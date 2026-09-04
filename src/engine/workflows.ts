import { at, isBlocked } from "../issue-phases.js";
import { condition, isCancellation, log, runExecution, setHandler, sleep } from "./registry.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowInputSchema, IssueWorkflowStateSchema, normalizeSafeSummary, type IssueBlocker, type IssueBlockerAction, type IssueWorkflowInput, type IssueWorkflowState, type ReconcileTargetBaseActivityResult, type TargetBaseCheckpoint } from "./issue-contracts.js";
import type { IssueCommand } from "../commands/registry.js";
import type { LeadPlanningResult } from "../lead-contracts.js";
import { assertPayloadWithinLimit } from "./policy.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "./target-base.js";
import { advanceSourcePullRequestState, isSourcePullRequestPreDelivery, sourcePullRequestState } from "./github-source-pull-request.js";
import { githubPullRequestObservationFields } from "../github-pull-request-observation.js";
import { pullRequestObservationKey, reconcile, type PullRequestObservation, type PullRequestTarget } from "../pull-request-reconciler.js";
import type { GithubPullRequestObservationResult } from "./contracts/activities/github-sync.js";
import { adoptPullRequestRelease, planMergeConflict, projectIssueStateActivity, reconcileTargetBase, loadTaskSourcePullRequest, observeGithubPullRequest, applyGithubPullRequestAction } from "./workflow/activity-proxies.js";
import { syncGithubPullRequestSignal } from "./issue-updates.js";
import { credentialBlockedState, evidencePointer, humanBlocker, withWorktreeCommands } from "./workflow/state-transitions.js";
import { createIssueWorkflowContext } from "./workflow/context.js";
import { registerGovernanceHandlers } from "./workflow/register-governance.js";
import { registerLifecycleHandlers, registerLifecycleHandlersContinuation } from "./workflow/register-lifecycle.js";
import { registerPlanningHandlers, registerPlanningHandlersContinuation, registerPlanningHandlersReject, registerPlanningHandlersRevision } from "./workflow/register-planning.js";
import { registerAcceptanceHandlers } from "./workflow/register-acceptance.js";
import { registerCapacityHandlers } from "./workflow/register-capacity.js";
import { registerCiHandlers } from "./workflow/register-ci.js";
import { registerDeliveryReviewHandlers } from "./workflow/register-delivery-review.js";
import { registerDevelopmentHandlers } from "./workflow/register-development.js";
import { registerMergeHandlers, registerMergeReconciliationHandler } from "./workflow/register-merge.js";
import { registerReleaseHandlers } from "./workflow/register-release.js";
import { registerTargetBaseHandlers } from "./workflow/register-target-base.js";
import { reobserveParkedTask } from "./workflow/reobserve.js";
import { applyLeadResult, autoChainedCommand, autoRetryDeliveryBlocker, canAutoRetryDeliveryBlocker, classifyRepairFailure, createAcquireExternalTurn, createGuarded, failureBlockCategory, isoEpochMillis, leadResultKind, permanentActivityFailure, rateLimitFailure, resumeLeadTurn, runAutoChainedCommand } from "./workflow/runtime.js";
export * from "./issue-updates.js"; export { repairBlockedState, repairRequiredState, repairedDeliveryAwaitingFreshReviewState, reviewApprovedState, reviewBlockedState, reviewingDeliveryState } from "./workflow/state-transitions.js";
async function projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState> { const projected = withWorktreeCommands(state); return projectIssueStateActivity(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: runExecution.current().runId, eventId: projected.lastEventId, state: projected })); }
const MAX_RECONCILIATION_ATTEMPTS = 20;
function sleepUntil(retryAt: string | null | undefined): Promise<void> { return retryAt ? sleep(Math.max(1, Date.parse(retryAt) - Date.now())) : sleep("1 second"); }
function sameTransition(state: IssueWorkflowState, next: Partial<IssueWorkflowState>): boolean { return Object.entries(next).every(([field, value]) => JSON.stringify(state[field as keyof IssueWorkflowState]) === JSON.stringify(value)); }
export const issueStateQuery = "issueState" as const;
export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const continuation = validatedInput.continuationState;
  let sourcePullRequest = sourcePullRequestState(validatedInput, true);
  const projectionStamps: Array<{ at: number; step: IssueWorkflowState["step"] }> = [];
  let automaticActionsHalted = false;
  const addRevisionCommand = (commands: IssueCommand[]): IssueCommand[] => !commands.includes("revise_plan") ? [...commands, "revise_plan"] : commands;
  let state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState(validatedInput),
    ...sourcePullRequest,
    activeOperation: null,
    processedCommandIds: [],
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  const approvalCommands = (exactSubject: boolean, supplementalReview: boolean): IssueCommand[] => {
    const commands: IssueCommand[] = exactSubject ? ["approve_plan", "request_plan_revision", "cancel_issue"] : ["approve_plan", "reject_plan", "cancel_issue"];
    return supplementalReview ? [...commands, "request_supplemental_review"] : commands;
  };
  const approvalBlocker = (result: LeadPlanningResult, exactSubject: boolean, supplementalReview: boolean): IssueBlocker | null => {
    const actions: IssueBlockerAction[] = exactSubject
      ? [{ command: "approve_plan", label: "Approve the plan", requiresNote: true, destructive: false }, { command: "request_plan_revision", label: "Request plan changes", requiresNote: true, destructive: false }]
      : [{ command: "approve_plan", label: "Approve the plan", requiresNote: false, destructive: false }, { command: "reject_plan", label: "Reject the plan", requiresNote: true, destructive: false }];
    if (supplementalReview) actions.push({ command: "request_supplemental_review", label: "Request a second review", requiresNote: false, destructive: false });
    return humanBlocker("member_authorization", "Your approval is necessary for this plan.", actions, evidencePointer(result.leadOutputArtifactId, "lead-plan"));
  };
  state = withWorktreeCommands(state);
  const initialProjection = continuation ? Promise.resolve(state) : projectIssueState(state);
  let continuationRequested = false;
  let initialProjectionComplete = Boolean(continuation);
  let decisionInFlight = false;
  const currentState = (): IssueWorkflowState => state;
  let planningPromise: Promise<LeadPlanningResult> | undefined;
  const shouldContinueAsNew = (_revision: number): boolean => false;
  let stateMutationLocked = false;
  let githubSyncRequested = false;
  let githubObservationFailure: unknown;
  const withStateMutation = async <T>(operation: () => T): Promise<T> => {
    await condition(() => !stateMutationLocked);
    stateMutationLocked = true;
    try { return operation(); } finally { stateMutationLocked = false; }
  };
  const commandAlreadyProcessed = (commandId: string): boolean => commandId !== "legacy-command" && (state.processedCommandIds ?? []).includes(commandId);
  const markCommandProcessed = (commandId: string): void => {
    const processed = state.processedCommandIds ?? [];
    if (commandId !== "legacy-command" && !processed.includes(commandId)) state = IssueWorkflowStateSchema.parse({ ...state, processedCommandIds: [...processed, commandId].slice(-32) });
  };
  const recordHandlerNoop = async (command: string, reason: string): Promise<void> => {
    state = IssueWorkflowStateSchema.parse({ ...state, lastHandlerError: { command, reason: reason.slice(0, 256), at: new Date().toISOString() } });
    await projectIssueState(state);
  };
  const applyTargetBaseBlocked = (result: Extract<ReconcileTargetBaseActivityResult, { outcome: "blocked" }>): void => {
    const verification = result.code === "verification_failed" || result.code === "verification_timed_out" || result.code === "verification_evidence_too_large";
    const summary = normalizeSafeSummary(result.summary, 200);
    if (result.code === "verification_failed" && result.owner === "lead" && result.resultHead && result.resultTree && state.developerExecutionId) {
      const published = Boolean(state.releaseId && state.pullRequestNumber && state.pullRequestUrl);
      state = IssueWorkflowStateSchema.parse({ ...state, blocker: null, revision: state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The project verification failed after the merge. The Planner reviews the merged changes.", lastEventId: `${state.workflowId}:${state.revision + 1}`,
        targetBaseSha: result.observedBaseSha ?? state.targetBaseSha, targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: result.code, targetBaseBlockerOwner: result.owner, targetBaseBlockerRetryable: result.retryable, targetBaseBlockerSummary: summary,
        forwardMergeId: result.checkId, forwardMergePriorHead: result.priorHead ?? state.forwardMergePriorHead, forwardMergePriorTree: result.priorTree ?? state.forwardMergePriorTree, forwardMergeTargetBaseSha: result.observedBaseSha ?? state.forwardMergeTargetBaseSha, forwardMergeConflictArtifact: null, forwardMergeConflictFileCount: null,
        resultCommit: result.resultHead, resultTree: result.resultTree, dirtyState: "clean", deliverySummary: normalizeSafeSummary(`Project verification failed: ${summary}`, 200), developerOutcome: "completed", deliveryReviewSupersedesId: null, repairCycle: 0, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null,
        releaseId: published ? state.releaseId : null, pullRequestNumber: published ? state.pullRequestNumber : null, pullRequestUrl: published ? state.pullRequestUrl : null, deliveryDecisionArtifactId: null, ciRunId: null, ciAttempt: 0, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, acceptedHeadSha: null, mergeOutcome: null, expectedHeadSha: result.resultHead, expectedHeadTree: result.resultTree, ...recoveryFields(null, null, null, null) });
      return;
    }
    const allowedCommands = (result.retryable ? [verification ? "retry_forward_merge_verification" : "retry_target_base_reconciliation", "cancel_issue"] : ["cancel_issue"]) as IssueCommand[];
    state = IssueWorkflowStateSchema.parse({
      ...state,
      blocker: null,
      revision: state.revision + 1,
      ...at("development"),
      owner: result.owner === "lead" ? "lead" : "human",
      allowedCommands,
      pendingAction: summary,
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      targetBaseCheckId: result.checkId,
      targetBaseCheckpoint: result.checkpoint,
      targetBaseOutcome: result.outcome,
      targetBaseBlockerCode: result.code,
      targetBaseBlockerOwner: result.owner,
      targetBaseBlockerRetryable: result.retryable,
      targetBaseBlockerSummary: summary,
      ...recoveryFields(null, null, null, null),
      ...(verification && result.observedBaseSha ? { forwardMergeTargetBaseSha: result.observedBaseSha } : {}),
      ...(verification && result.resultHead ? { resultCommit: result.resultHead } : {}),
      ...(verification && result.resultTree ? { resultTree: result.resultTree } : {}),
      ...(verification && result.evidenceArtifact ? { developerEvidenceArtifactId: result.evidenceArtifact.id, developerOutcome: "blocked" as const } : {}),
    });
  };
  const runTargetBaseCheckpoint = async (checkpoint: TargetBaseCheckpoint, verificationOnly = false): Promise<boolean> => {
    if (!state.developerExecutionId || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("An exact Developer delivery is required before target-base reconciliation");
    const result = await reconcileTargetBase({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, checkpoint, developerExecutionId: state.developerExecutionId, expectedBaseSha: state.targetBaseSha, expectedHeadSha: state.resultCommit, expectedHeadTree: state.resultTree, ...(state.forwardMergeId ? { forwardMergeId: state.forwardMergeId } : {}), ...(verificationOnly ? { verificationOnly: true } : {}), ...(state.deliveryReviewId ? { deliveryReviewId: state.deliveryReviewId } : {}), ...(state.ciRunId ? { ciRunId: state.ciRunId } : {}), ...(state.finalReviewId ? { finalReviewId: state.finalReviewId } : {}), ...(state.acceptanceId ? { acceptanceId: state.acceptanceId } : {}), ...(state.releaseId ? { releaseId: state.releaseId } : {}) });
    if (result.outcome === "no_drift") {
      const priorRevision = state.revision;
      state = IssueWorkflowStateSchema.parse({ ...state, targetBaseSha: result.observedBaseSha, resultCommit: result.headSha, resultTree: result.headTree });
      state = applyTargetBaseNoDrift(state, result);
      if (state.revision !== priorRevision) await projectIssueState(state);
      return true;
    }
    if (result.outcome === "revalidated") state = applyTargetBaseRevalidation(state, result);
    else if (result.outcome === "blocked") applyTargetBaseBlocked(result);
    else {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("merge_conflict_reviewing"), owner: "lead", allowedCommands: [], pendingAction: "The Planner plans the conflict resolution", targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null, forwardMergePriorHead: result.priorHead, forwardMergePriorTree: result.priorTree, forwardMergeTargetBaseSha: result.observedBaseSha, forwardMergeConflictArtifact: result.conflictArtifact, forwardMergeConflictFileCount: result.conflictFileCount, forwardMergeId: result.checkId, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await planMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, worktreePath: state.worktreePath!, branchName: state.branchName!, priorHead: result.priorHead, targetBaseSha: result.observedBaseSha, conflictArtifact: result.conflictArtifact, conflictFileCount: result.conflictFileCount, forwardMergeId: result.checkId });
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("merge_conflict_resolving"), owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "The Builder waits for the Planner conflict plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch (error) {
        if (isCancellation(error)) throw error;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("merge_conflict_resolving"), owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Forge did not prepare a conflict plan. Retry the resolution.", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
    }
    await projectIssueState(state);
    return false;
  };
  const recoveryFields = (status: "starting" | "active" | "reconnecting" | "result_pending_claim" | "cancellation_requested" | "cancelling" | "interrupted" | "cancelled" | "failed" | null, reasonCode: string | null, summary: string | null, heartbeatAt: string | null) => ({ developerRecoveryStatus: status, developerRecoveryReasonCode: reasonCode, developerRecoverySummary: summary, developerLastHeartbeatAt: heartbeatAt });
  const applyCompletedDeveloperResult = (rawResult: unknown, summary: string): boolean => {
    if (!rawResult || typeof rawResult !== "object") return false;
    const result = rawResult as Record<string, unknown>;
    const requiredStrings = ["developerExecutionId", "developerSessionRef", "resultCommit", "resultTree", "deliveryArtifactId", "evidenceArtifactId"];
    if (requiredStrings.some((field) => typeof result[field] !== "string" || !result[field])) return false;
    const common = {
      developerExecutionId: result.developerExecutionId as string,
      developerSessionRef: result.developerSessionRef as string,
      resultCommit: result.resultCommit as string,
      resultTree: result.resultTree as string,
      deliveryArtifactId: result.deliveryArtifactId as string,
      developerEvidenceArtifactId: result.evidenceArtifactId as string,
      deliverySummary: (typeof result.deliverySummary === "string" ? result.deliverySummary : result.summary as string),
      developerOutcome: "completed" as const,
      ...recoveryFields("active", null, summary, null),
      activeOperation: null,
    };
    if (state.developerTurnKind === "implementation") {
      if (typeof result.branchName !== "string" || typeof result.targetBaseSha !== "string" || (result.dirtyState !== "clean" && result.dirtyState !== "dirty") || result.outcome !== "completed") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the delivery", branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: typeof result.currentStep === "number" ? result.currentStep : null, dirtyState: result.dirtyState, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "repair") {
      if (typeof result.branchName !== "string" || typeof result.targetBaseSha !== "string" || (result.dirtyState !== "clean" && result.dirtyState !== "dirty") || result.outcome !== "completed" || typeof result.cycle !== "number") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", branchName: result.branchName, targetBaseSha: result.targetBaseSha, dirtyState: result.dirtyState, repairCycle: result.cycle, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "merge_conflict_resolution") {
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", targetBaseSha: state.forwardMergeTargetBaseSha ?? state.targetBaseSha, dirtyState: "clean", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, mergeResolutionDeveloperExecutionId: result.developerExecutionId as string, mergeResolutionDeveloperSessionRef: result.developerSessionRef as string, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    return false;
  };
  setHandler(issueStateQuery, () => state);
  setHandler(syncGithubPullRequestSignal, () => { githubSyncRequested = true; });
  const syncGithubPullRequest = async (): Promise<GithubPullRequestObservationResult | null> => {
    if (runExecution.current().autoActionsHalted()) return null;
    const repository = state.releaseRepository ?? validatedInput.repository;
    if (!repository && !sourcePullRequest) {
      sourcePullRequest = await loadTaskSourcePullRequest({ taskId: state.issueId, companyId: state.companyId }).then(
        (source) => sourcePullRequestState(source, true),
        (error) => {
          if (isCancellation(error)) throw error;
          return undefined;
        },
      );
    }
    if (!repository && sourcePullRequest) { state = IssueWorkflowStateSchema.parse(advanceSourcePullRequestState(state, sourcePullRequest)); await projectIssueState(state); }
    if (!repository || !state.branchName) return null;
    // GitHub reconciliation only runs while Forge is waiting on GitHub. While an agent turn or a
    // publish is in flight, an observation must not rewrite the phase under it. delivery_ready holds an
    // unreleased local head (after a repair the PR still points at the failed commit), so it is skipped too.
    if (!isSourcePullRequestPreDelivery(state, sourcePullRequest) && (state.activeOperation !== null || ["planning", "supplemental_review", "plan_consolidation", "development", "reviewing_delivery", "repair_required", "releasing", "merge_conflict_reviewing", "merge_conflict_resolving", "ci_repair_planning", "ci_repairing", "final_review"].includes(state.step))) return null;
    githubObservationFailure = undefined;
    const observed = await observeGithubPullRequest({ repository, branch: state.branchName, pullRequestNumber: state.pullRequestNumber }).catch((error) => {
      if (isCancellation(error)) throw error;
      githubObservationFailure = error;
      return null;
    });
    if (!observed) return null;
    githubObservationFailure = undefined;
    const common = githubPullRequestObservationFields(observed, new Date().toISOString());
    if (isSourcePullRequestPreDelivery(state, sourcePullRequest) && observed.state !== "merged") { state = IssueWorkflowStateSchema.parse(advanceSourcePullRequestState(state, common)); await projectIssueState(state); return observed; }
    const reviewedCommit = state.resultCommit;
    if (["delivery_ready", "delivery_reviewed"].includes(state.step) && reviewedCommit && observed.exists && observed.number && observed.url && observed.headSha) {
      if (observed.headSha.toLowerCase() !== reviewedCommit.toLowerCase()) {
        const transition = { ...at("delivery_ready"), owner: "lead" as const, allowedCommands: ["review_delivery", "cancel_issue"] as IssueCommand[], pendingAction: "The Planner reviews the latest changes", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null };
        if (sameTransition(state, transition)) return observed;
        state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, ...transition, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return observed;
      }
      if (observed.state === "merged") {
        state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, ...at("done"), owner: "human", allowedCommands: [], pendingAction: `Done. Pull request #${observed.number} was merged outside Forge.`, mergeOutcome: "merged", pullRequestNumber: observed.number, pullRequestUrl: observed.url, releaseRepository: repository, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return observed;
      }
      if (observed.state === "open" && state.baseBranch) {
        const adopted = await adoptPullRequestRelease({ taskId: state.issueId, companyId: state.companyId, workflowId: state.workflowId, projectRevisionId: state.projectRevisionId, repository, branchName: state.branchName, baseBranch: state.baseBranch, ...(state.targetBaseSha ? { expectedBaseSha: state.targetBaseSha } : {}), pullRequestNumber: observed.number, headSha: reviewedCommit });
        const nextStep = validatedInput.deliveryTarget === "merged" ? "ci_waiting" : "manual_merge";
        state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, ...at(nextStep), owner: nextStep === "ci_waiting" ? "lead" : "human", allowedCommands: nextStep === "ci_waiting" ? ["cancel_issue"] : ["reconcile_merge", "cancel_issue"], pendingAction: nextStep === "ci_waiting" ? "Forge waits for CI" : "Your merge is necessary", releaseId: adopted.releaseId, releaseRepository: adopted.repository, baseBranch: adopted.baseBranch, targetBaseSha: adopted.targetBaseSha, pullRequestNumber: adopted.pullRequestNumber, pullRequestUrl: adopted.pullRequestUrl, expectedHeadSha: adopted.headSha, expectedHeadTree: adopted.headTree, resultCommit: adopted.headSha, resultTree: adopted.headTree, releaseFailureSummary: null, releaseRetryAt: null, ciAttempt: 0, ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return observed;
      }
    }
    {
      const target: PullRequestTarget = validatedInput.deliveryTarget === "merged" ? "merged" : validatedInput.deliveryTarget === "pull_request_ready" ? "ready" : "draft";
      const checks: PullRequestObservation["checks"] = observed.checks.failing > 0 ? "failed" : observed.checks.pending > 0 ? "pending" : observed.checks.total > 0 && observed.checks.successful === observed.checks.total ? "success" : "none";
      const pullRequestObservation = { exists: observed.exists, number: observed.number, state: observed.state, isDraft: observed.isDraft, headSha: observed.headSha, mergeable: observed.mergeable, checks, reviewDecision: observed.reviewDecision, autoMergeEnabled: observed.autoMergeEnabled };
      const observationKey = pullRequestObservationKey(pullRequestObservation);
      if (state.owner === "human" && state.githubPullRequestObservationKey === observationKey) {
        const allowedCommands = observed.mergeable === "CONFLICTING" && !state.allowedCommands.includes("resolve_merge_conflict") ? [...state.allowedCommands, "resolve_merge_conflict" as const] : state.allowedCommands;
        state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, allowedCommands, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return observed;
      }
      const reconciliation = reconcile({ observed: pullRequestObservation, target, current: { step: state.step, owner: state.owner, pendingAction: state.pendingAction, ...(state.pullRequestNumber !== undefined ? { pullRequestNumber: state.pullRequestNumber } : {}), ...(state.expectedHeadSha !== undefined ? { observedHeadSha: state.expectedHeadSha } : {}), ...(state.autoMergeAvailable !== undefined ? { autoMergeAvailable: state.autoMergeAvailable } : {}), ...(state.githubPullRequestObservationKey !== undefined ? { adoptedObservationKey: state.githubPullRequestObservationKey } : {}) } });
      if (reconciliation.unchanged) return observed;
      const revision = state.revision + 1;
      const step = reconciliation.phase === "Done" ? "done" : reconciliation.phase === "Forge merges the pull request" ? "manual_merge" : reconciliation.phase === "Resolving conflicts" ? "merge_conflict_reviewing" : reconciliation.phase === "Forge waits for CI" ? "ci_waiting" : reconciliation.phase === "Opening PR" ? "releasing" : state.step;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision, ...at(step), owner: reconciliation.owner === "human" ? "human" : "lead", allowedCommands: reconciliation.allowedCommands.filter((command): command is IssueCommand => command === "publish_draft" || command === "cancel_issue" || command === "send_planner_note"), pendingAction: reconciliation.pendingAction, githubPullRequestObservationKey: observationKey, mergeOutcome: observed.state === "merged" ? "merged" : state.mergeOutcome, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${revision}` });
      await projectIssueState(state);
      for (const action of reconciliation.actions) {
        if ((action.kind === "enable_auto_merge" || action.kind === "merge" || action.kind === "mark_ready") && state.releaseRepository) {
          const failure = await applyGithubPullRequestAction({ repository: state.releaseRepository, number: action.number, headSha: "headSha" in action ? action.headSha : observed.headSha ?? "", action: action.kind }).then(
            () => null,
            (error: Error & { cause?: { message?: string } }) => {
              if (isCancellation(error)) throw error;
              return error.cause?.message ?? error.message;
            },
          );
          if (failure !== null) {
            if (action.kind === "enable_auto_merge" && /auto.?merge is not allowed|not enabled for this repository/i.test(failure)) {
              state = IssueWorkflowStateSchema.parse({ ...state, autoMergeAvailable: false, revision: state.revision + 1, pendingAction: "Auto-merge is not available. Forge merges the branch directly.", lastEventId: `${state.workflowId}:${state.revision + 1}` });
              await projectIssueState(state);
              continue;
            }
            state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, pendingAction: `GitHub ${action.kind.replaceAll("_", " ")} failed: ${failure}. Forge retries.`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
            await projectIssueState(state);
          }
        }
        else if (action.kind === "resolve_conflicts") {
          if (await runTargetBaseCheckpoint("pre_release")) {
            state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("ci_waiting"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "GitHub reports merge conflicts, but the branch contains the base branch. Forge waits for GitHub to check again.", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
            await projectIssueState(state);
          }
        }
        else if ((action.kind === "push_open_draft" || action.kind === "push_open_ready") && state.step === "releasing") await workflowContext.runPublishTurn();
        else if (action.kind === "repair_ci" && state.step === "ci_waiting") await workflowContext.reconcileCiTurn();
      }
      return observed;
    }
    return observed;
  };
  const initialProjectionState = state;
  const projectCapacityState = async (capacity: IssueWorkflowState["capacity"], pendingAction?: string): Promise<number> => {
    const changed = JSON.stringify(state.capacity) !== JSON.stringify(capacity) || (pendingAction !== undefined && state.pendingAction !== pendingAction);
    if (!changed) return state.revision;
    state = IssueWorkflowStateSchema.parse({ ...state, capacity, ...(capacity === null ? { capacityBlocker: null } : {}), ...(pendingAction !== undefined ? { pendingAction } : {}), revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state.revision;
  };
  const acquireExternalTurn = createAcquireExternalTurn({ get: () => state, set: (next) => { state = next; } }, { projectState: projectIssueState });
  const guarded = createGuarded({ get: () => state, set: (next) => { state = next; } }, { project: projectIssueState });
  const workflowContext = createIssueWorkflowContext(validatedInput, state, {
    project: () => {
      const now = Date.now();
      projectionStamps.push({ at: now, step: state.step });
      while (projectionStamps.length && now - projectionStamps[0]!.at > 60_000) projectionStamps.shift();
      state = withWorktreeCommands(state);
      // safety bound, not a mirror gate
      if (!automaticActionsHalted && projectionStamps.length >= 40) {
        automaticActionsHalted = true;
        log.warn("Issue run stopped an automatic loop", { workflowId: state.workflowId, repeatingSteps: projectionStamps.map((stamp) => stamp.step) });
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("delivery_ready"), owner: "human", allowedCommands: ["review_delivery", "publish_draft", "cancel_issue"], pendingAction: "Forge stopped an automatic loop. Review the task, then retry.", blocker: humanBlocker("agent_exhausted", "Forge stopped an automatic loop. Review the task, then retry.", [{ command: "review_delivery", label: "Approve the delivery", requiresNote: false, destructive: false }, { command: "publish_draft", label: "Publish the pull request", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(state.deliveryReviewArtifact?.artifactId ?? state.developerEvidenceArtifactId ?? undefined, "attention-evidence")), stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      return projectIssueState(state);
    },
    projectState: (value) => { state = withWorktreeCommands(value); return projectIssueState(state); },
    projectInitialPlanningState: async (next) => { await projectIssueState(next); },
    planningProjectionFlags: () => ({ distinctPlanningStates: true, shouldProject: true }),
    continueAfter: 0,
    guarded, captureInitialProjectionState: true, initialProjectionState, initialProjection,
    get stateMutationLocked() { return stateMutationLocked; },
    set stateMutationLocked(value: boolean) { stateMutationLocked = value; },
    get continuationRequested() { return continuationRequested; },
    set continuationRequested(value: boolean) { continuationRequested = value; },
    get initialProjectionComplete() { return initialProjectionComplete; },
    set initialProjectionComplete(value: boolean) { initialProjectionComplete = value; },
    get decisionInFlight() { return decisionInFlight; },
    set decisionInFlight(value: boolean) { decisionInFlight = value; },
    get planningPromise() { return planningPromise; },
    set planningPromise(value: Promise<LeadPlanningResult> | undefined) { planningPromise = value; },
    supervisedDeveloperTurns: true, shouldContinueAsNew, currentState, addRevisionCommand, approvalCommands, approvalBlocker,
    withStateMutation, commandAlreadyProcessed, markCommandProcessed, recordHandlerNoop,
    applyTargetBaseBlocked, runTargetBaseCheckpoint, recoveryFields, applyCompletedDeveloperResult, projectCapacityState, acquireExternalTurn,
    cancelCurrentCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    settleCancelledCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    permanentActivityFailure, failureBlockCategory, leadResultKind, applyLeadResult,
    rateLimitFailure,
    maxReconciliationAttempts: MAX_RECONCILIATION_ATTEMPTS,
    runPublishTurn: async () => { throw new Error("Publish runtime is not initialized"); },
    reconcileCiTurn: async () => { throw new Error("CI runtime is not initialized"); },
    reconcileMergeTurn: async () => { throw new Error("Merge runtime is not initialized"); },
    reconcileAcceptanceTurn: async () => { throw new Error("Acceptance runtime is not initialized"); },
    retryAcceptDelivery: async () => { throw new Error("Acceptance runtime is not initialized"); },
    retryTargetBaseReconciliation: async () => { throw new Error("Target-base runtime is not initialized"); },
    resumeCapacityOperation: async () => { throw new Error("Capacity runtime is not initialized"); },
    runFinalReviewTurn: async () => { throw new Error("Final-review runtime is not initialized"); },
  }, { get: () => state, set: (next) => { state = next; } });
  registerPlanningHandlers(workflowContext);
  registerGovernanceHandlers(workflowContext);
  registerPlanningHandlersContinuation(workflowContext);
  registerDevelopmentHandlers(workflowContext);
  registerDeliveryReviewHandlers(workflowContext);
  registerReleaseHandlers(workflowContext);
  registerMergeHandlers(workflowContext);
  registerTargetBaseHandlers(workflowContext);
  registerCiHandlers(workflowContext);
  registerAcceptanceHandlers(workflowContext);
  registerMergeReconciliationHandler(workflowContext);
  registerLifecycleHandlers(workflowContext);
  registerPlanningHandlersRevision(workflowContext);
  registerLifecycleHandlersContinuation(workflowContext);
  registerPlanningHandlersReject(workflowContext);
  registerCapacityHandlers(workflowContext);
  assertPayloadWithinLimit("Issue Workflow result", state);
  // Continue-As-New carries the last business revision into a fresh run; re-emitting it would read as conflicting authoritative history.
  try {
    await workflowContext.initialProjection;
    const automaticActionsAllowed = (): boolean => !automaticActionsHalted;
    const githubSyncPending = (): boolean => githubSyncRequested;
    const currentStep = (): IssueWorkflowState["step"] => workflowContext.state.step;
    function shouldWake(): boolean {
      return githubSyncRequested // GitHub changed.
        || (!workflowContext.state.allowedCommands.includes("delete_worktree") && (workflowContext.state.step === "done" || (workflowContext.state.step === "cancelled" && !workflowContext.state.allowedCommands.includes("continue_work")))) // A terminal state needs completion.
        || workflowContext.continuationRequested // A continuation was requested.
        || (!automaticActionsHalted && (autoChainedCommand(workflowContext, "") !== null // A phase can advance automatically.
          || canAutoRetryDeliveryBlocker(workflowContext))); // A delivery blocker can retry.
    }
    for (;;) {
      if ((workflowContext.state.step === "done" && !workflowContext.state.allowedCommands.includes("delete_worktree")) || (workflowContext.state.step === "cancelled" && !(workflowContext.state.allowedCommands.includes("continue_work") || workflowContext.state.allowedCommands.includes("delete_worktree")))) { return workflowContext.state; } // finish only after every handler landed its projection; a terminal issue offering cleanup or continuation stays open
      if (continuation && await resumeLeadTurn(workflowContext)) continue;
      if (automaticActionsAllowed() && await reobserveParkedTask(workflowContext, validatedInput)) continue;
      if (githubSyncPending()) {
        githubSyncRequested = false;
        await syncGithubPullRequest();
        continue;
      }
      if (workflowContext.state.step === "releasing" && workflowContext.state.owner === "lead" && !isBlocked(workflowContext.state) && workflowContext.state.activeOperation === null && !workflowContext.state.releaseRetryAt) {
        workflowContext.state = IssueWorkflowStateSchema.parse({ ...workflowContext.state, revision: workflowContext.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: workflowContext.addRevisionCommand(["review_delivery", "cancel_issue"]), pendingAction: "The publish stopped. Review again before you publish.", lastEventId: `${workflowContext.state.workflowId}:${workflowContext.state.revision + 1}` });
        await workflowContext.project();
        continue;
      }
      if (workflowContext.state.step === "releasing" && workflowContext.state.releaseRetryAt) {
        const delay = Math.max(0, Date.parse(workflowContext.state.releaseRetryAt) - Date.now());
        if (delay > 0) await sleep(delay);
        if (currentStep() === "releasing") await workflowContext.runPublishTurn();
        continue;
      }
      if (workflowContext.state.step === "ci_waiting") {
        const sleepingRevision = workflowContext.state.revision;
        const sleepingReleaseId = workflowContext.state.releaseId;
        const sleepingHeadSha = workflowContext.state.expectedHeadSha;
        const pollAt = workflowContext.state.ciNextPollAt ? isoEpochMillis(workflowContext.state.ciNextPollAt) : runExecution.current().now();
        const delay = Math.max(0, pollAt - runExecution.current().now());
        if (delay > 0) await sleep(delay);
        if (currentStep() !== "ci_waiting" || workflowContext.state.revision !== sleepingRevision || workflowContext.state.releaseId !== sleepingReleaseId || workflowContext.state.expectedHeadSha !== sleepingHeadSha) continue;
        const observation = await syncGithubPullRequest();
        if (observation === null && githubObservationFailure) {
          const failure = workflowContext.permanentActivityFailure(githubObservationFailure);
          githubObservationFailure = undefined;
          const failureClass = classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : failure?.code === "authentication-required" ? { category: "provider_authentication" } : {}), summary: failure?.summary ?? "Forge could not check CI. Retry.", source: "ci" });
          const ciNextPollAt = new Date(runExecution.current().now() + 60_000).toISOString();
          const deferred = IssueWorkflowStateSchema.parse({ ...workflowContext.state, ciNextPollAt });
          const evidence = evidencePointer(failure?.evidenceArtifactId ?? deferred.ciEvidenceArtifactId ?? deferred.developerEvidenceArtifactId ?? undefined, "attention-evidence");
          workflowContext.state = failureClass === "credential_missing"
            ? credentialBlockedState(deferred, "reconcile_ci", evidence)
            : IssueWorkflowStateSchema.parse({ ...deferred, revision: deferred.revision + 1, lastEventId: `${deferred.workflowId}:${deferred.revision + 1}` });
          await workflowContext.project();
          continue;
        }
        // CI reconciliation needs a release; without one the PR sync above is the only observer. Never throw from the loop.
        if (currentStep() === "ci_waiting" && workflowContext.state.releaseId) await workflowContext.reconcileCiTurn(observation);
        else if (currentStep() === "ci_waiting" && workflowContext.state.resultCommit && workflowContext.state.branchName && !workflowContext.state.deliveryReviewId) {
          // ci_waiting without a release is a dead end: an unreleased exact delivery goes back through review and publish.
          workflowContext.state = IssueWorkflowStateSchema.parse({ ...workflowContext.state, revision: workflowContext.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", ciNextPollAt: null, lastEventId: `${workflowContext.state.workflowId}:${workflowContext.state.revision + 1}` });
          await workflowContext.project();
        }
        else if (currentStep() === "ci_waiting") await sleep("60 seconds");
        continue;
      }
      if (workflowContext.state.step === "manual_merge") {
        await condition(() => githubSyncRequested, "60 seconds"); githubSyncRequested = false; // a sync signal (webhook, operator) wakes the poll
        if (currentStep() === "manual_merge") await syncGithubPullRequest();
        continue;
      }
      if (workflowContext.state.step === "ready_reconciliation") {
        await sleepUntil(workflowContext.state.acceptanceRetryAt);
        if (currentStep() === "ready_reconciliation") await workflowContext.reconcileAcceptanceTurn();
        continue;
      }
      if (automaticActionsAllowed()) {
        if (await autoRetryDeliveryBlocker(workflowContext)) continue;
        const chained = autoChainedCommand(workflowContext, "");
        if (chained) {
          await runAutoChainedCommand(workflowContext, chained);
          continue;
        }
      }
      await condition(shouldWake);
    }
  } catch (error) {
    if (!isCancellation(error)) throw error;
    // External cancellation projects the same cancelled phase as cancel_issue in a non-cancellable scope.
    await (async () => {
      if (state.step === "cancelled" || state.step === "done") return;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("cancelled"), owner: "human", allowedCommands: [], pendingAction: "The task was cancelled outside Forge", blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    });
    throw error;
  }
}
