import { allHandlersFinished, CancellationScope, condition, defineQuery, isCancellation, log, setHandler, sleep, workflowInfo } from "./registry.js";
import { ProbeWorkflowInputSchema, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowInputSchema, IssueWorkflowStateSchema, normalizeSafeSummary, type IssueBlocker, type IssueBlockerAction, type IssueCommand, type IssueWorkflowInput, type IssueWorkflowState, type LeadPlanningResult, type ReconcileTargetBaseActivityResult, type TargetBaseCheckpoint } from "./issue-contracts.js";
import { assertPayloadWithinLimit } from "./policy.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "./target-base.js";
import { advanceSourcePullRequestState, isSourcePullRequestPreDelivery, sourcePullRequestState } from "./github-source-pull-request.js";
import { githubPullRequestObservationFields } from "../github-pull-request-observation.js";
import { reconcile, type PullRequestTarget } from "../pull-request-reconciler.js";
import { planMergeConflict, projectIssueStateActivity, reconcileTargetBase, recordProbeStarted, loadTaskSourcePullRequest, observeGithubPullRequest, applyGithubPullRequestAction } from "./workflow/activity-proxies.js";
import { syncGithubPullRequestSignal } from "./issue-updates.js";
import { evidencePointer, humanBlocker, withWorktreeCommands } from "./workflow/state-transitions.js";
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
import { applyLeadResult, applyLegacyLeadResult, autoChainedCommand, autoRetryDeliveryBlocker, canAutoRetryDeliveryBlocker, createAcquireExternalTurn, createGuarded, failureBlockCategory, isoEpochMillis, leadResultKind, permanentActivityFailure, rateLimitFailure, runAutoChainedCommand } from "./workflow/runtime.js";
export * from "./issue-updates.js";
export { repairBlockedState, repairRequiredState, repairedDeliveryAwaitingFreshReviewState, reviewApprovedState, reviewBlockedState, reviewingDeliveryState } from "./workflow/state-transitions.js";
async function projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState> { const projected = withWorktreeCommands(state, true); return projectIssueStateActivity(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: workflowInfo().runId, eventId: projected.lastEventId, state: projected })); }
const MAX_RECONCILIATION_ATTEMPTS = 20;
function sleepUntil(retryAt: string | null | undefined): Promise<void> { return retryAt ? sleep(Math.max(1, Date.parse(retryAt) - Date.now())) : sleep("1 second"); }
export const probeStateQuery = defineQuery<ProbeWorkflowState>("probeState");
export async function probeWorkflow(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
  const validatedInput = ProbeWorkflowInputSchema.parse(input);
  let state: ProbeWorkflowState = {
    workflowId: validatedInput.workflowId,
    probeId: validatedInput.probeId,
    companyId: validatedInput.companyId,
    status: "starting",
  };
  setHandler(probeStateQuery, () => state);
  state = await recordProbeStarted(validatedInput);
  await condition(() => false);
  return state;
}
export const issueStateQuery = defineQuery<IssueWorkflowState>("issueState");
const leadPlanningPatch = "forge-lead-planning-v1";
const leadResultRoutingPatch = "forge-lead-result-routing-v2";
const planGovernancePatch = "forge-plan-governance-v1";
const planningProjectionIntegrityPatch = "forge-planning-projection-integrity-v1";
const distinctPlanningStatesPatch = "forge-distinct-planning-states-v1";
const developerFailureRecoveryPatch = "forge-developer-failure-recovery-v1";
const developerReconciliationRecoveryPatch = "forge-developer-reconciliation-recovery-v1";
const developerBlockedRecoveryStatePatch = "forge-developer-blocked-recovery-state-v1";
const cancelBlockedDeveloperResultPatch = "forge-cancel-blocked-developer-result-v1";
const artifactBackedConflictPatch = "forge-artifact-backed-conflict-evidence-v1";
const artifactBackedReviewPatch = "forge-artifact-backed-review-evidence-v1";
const exactDeliveryReviewPatch = "forge-exact-delivery-review-v1";
const typedReleaseResultPatch = "forge-typed-release-result-v1";
const targetBaseReconciliationPatch = "forge-target-base-reconciliation-v1";
const exactAcceptanceReceiptPatch = "forge-exact-acceptance-receipt-v1";
const durableCapacityPatch = "durable-capacity-v1";
const decisionResolutionProjectionPatch = "forge-decision-resolution-projection-v1";
const exhaustedActivityRecoveryPatch = "forge-exhausted-activity-recovery-v1";
const autoChainLeadPhasesPatch = "forge-auto-chain-lead-phases-v1";
const unconditionalCancelPatch = "forge-unconditional-cancel-v1";
export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const continuation = validatedInput.continuationState;
  const reviseContinueEnabled = true, guardedHandlersEnabled = true;
  const failedRetryEnabled = true, herdrExecutionSubstrateEnabled = true;
  let sourcePullRequest = sourcePullRequestState(validatedInput, true);
  const projectionStamps: number[] = [];
  const addRevisionCommand = (commands: IssueCommand[]): IssueCommand[] => reviseContinueEnabled && !commands.includes("revise_plan") ? [...commands, "revise_plan"] : commands;
  let state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState(validatedInput),
    ...sourcePullRequest,
    activeOperation: null,
    processedCommandIds: [],
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  const exactPlanAuthorityEnabled = true;
  const isolatedDeveloperExecutionEnabled = true;
  const initialProjectionBarrierEnabled = true;
  const planApprovalBlockerEnabled = true;
  const approvalCommands = (exactSubject: boolean, supplementalReview: boolean): IssueCommand[] => {
    const commands: IssueCommand[] = exactSubject ? ["approve_plan", "request_plan_revision", "cancel_issue"] : ["approve_plan", "reject_plan", "cancel_issue"];
    return supplementalReview ? [...commands, "request_supplemental_review"] : commands;
  };
  const approvalBlocker = (result: LeadPlanningResult, exactSubject: boolean, supplementalReview: boolean): IssueBlocker | null => {
    if (!planApprovalBlockerEnabled) return null;
    const actions: IssueBlockerAction[] = exactSubject
      ? [{ command: "approve_plan", label: "Approve plan", requiresNote: true, destructive: false }, { command: "request_plan_revision", label: "Request plan revision", requiresNote: true, destructive: false }]
      : [{ command: "approve_plan", label: "Approve plan", requiresNote: false, destructive: false }, { command: "reject_plan", label: "Request plan revision", requiresNote: true, destructive: false }];
    if (supplementalReview) actions.push({ command: "request_supplemental_review", label: "Request supplemental review", requiresNote: false, destructive: false });
    return humanBlocker("member_authorization", "Member approval is required for this material plan.", actions, evidencePointer(result.leadOutputArtifactId, "lead-plan"));
  };
  state = withWorktreeCommands(state, true);
  const initialProjection = continuation || !exactPlanAuthorityEnabled ? Promise.resolve(state) : projectIssueState(state);
  let continuationRequested = false;
  let initialProjectionComplete = Boolean(continuation);
  let decisionInFlight = false;
  const currentState = (): IssueWorkflowState => state;
  let planningScope: CancellationScope | undefined;
  let planningPromise: Promise<LeadPlanningResult> | undefined;
  const shouldContinueAsNew = (_revision: number): boolean => false;
  let stateMutationLocked = false;
  let githubSyncRequested = false;
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
    const reviewVerificationFailure = true;
    const verification = result.code === "verification_failed" || result.code === "verification_timed_out" || result.code === "verification_evidence_too_large";
    const summary = normalizeSafeSummary(result.summary, 200);
    if (reviewVerificationFailure && result.code === "verification_failed" && result.owner === "lead" && result.resultHead && result.resultTree && state.developerExecutionId) {
      const published = Boolean(state.releaseId && state.pullRequestNumber && state.pullRequestUrl);
      state = IssueWorkflowStateSchema.parse({ ...state, blocker: null, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Project verification failed after the merge. Reviewing the merged changes.", lastEventId: `${state.workflowId}:${state.revision + 1}`,
        targetBaseSha: result.observedBaseSha ?? state.targetBaseSha, targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: result.code, targetBaseBlockerOwner: result.owner, targetBaseBlockerRetryable: result.retryable, targetBaseBlockerSummary: summary,
        forwardMergeId: result.checkId, forwardMergePriorHead: result.priorHead ?? state.forwardMergePriorHead, forwardMergePriorTree: result.priorTree ?? state.forwardMergePriorTree, forwardMergeTargetBaseSha: result.observedBaseSha ?? state.forwardMergeTargetBaseSha, forwardMergeConflictArtifact: null, forwardMergeConflictFileCount: null,
        resultCommit: result.resultHead, resultTree: result.resultTree, dirtyState: "clean", deliverySummary: normalizeSafeSummary(`Project verification failed: ${summary}`, 200), developerOutcome: "completed", deliveryReviewSupersedesId: null, repairCycle: 0, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null,
        releaseId: published ? state.releaseId : null, pullRequestNumber: published ? state.pullRequestNumber : null, pullRequestUrl: published ? state.pullRequestUrl : null, deliveryDecisionArtifactId: null, ciRunId: null, ciAttempt: 0, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, acceptedHeadSha: null, mergeOutcome: null, expectedHeadSha: result.resultHead, expectedHeadTree: result.resultTree, ...recoveryFields(null, null, null, null) });
      return;
    }
    const allowedCommands = [verification ? "retry_forward_merge_verification" : "retry_target_base_reconciliation", "cancel_issue"] as const;
    state = IssueWorkflowStateSchema.parse({
      ...state,
      blocker: null,
      revision: state.revision + 1,
      phase: "delivery_blocked",
      owner: result.owner === "lead" ? "lead" : "human",
      allowedCommands,
      pendingAction: summary,
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      targetBaseCheckId: result.checkId,
      targetBaseCheckpoint: result.checkpoint,
      targetBaseOutcome: result.outcome,
      targetBaseBlockerCode: result.code,
      targetBaseBlockerOwner: result.owner,
      targetBaseBlockerRetryable: true,
      targetBaseBlockerSummary: summary,
      ...recoveryFields(null, null, null, null),
      ...(verification && result.observedBaseSha ? { forwardMergeTargetBaseSha: result.observedBaseSha } : {}),
      ...(verification && result.resultHead ? { resultCommit: result.resultHead } : {}),
      ...(verification && result.resultTree ? { resultTree: result.resultTree } : {}),
      ...(verification && result.evidenceArtifact ? { developerEvidenceArtifactId: result.evidenceArtifact.id, developerOutcome: "blocked" as const } : {}),
    });
  };
  const runTargetBaseCheckpoint = async (checkpoint: TargetBaseCheckpoint, verificationOnly = false): Promise<boolean> => {
    if (!true) return true;
    if (!state.developerExecutionId || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("An exact Developer delivery is required before target-base reconciliation");
    const result = await reconcileTargetBase({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, checkpoint, developerExecutionId: state.developerExecutionId, expectedBaseSha: state.targetBaseSha, expectedHeadSha: state.resultCommit, expectedHeadTree: state.resultTree, ...(state.forwardMergeId ? { forwardMergeId: state.forwardMergeId } : {}), ...(verificationOnly ? { verificationOnly: true } : {}), ...(state.deliveryReviewId ? { deliveryReviewId: state.deliveryReviewId } : {}), ...(state.ciRunId ? { ciRunId: state.ciRunId } : {}), ...(state.finalReviewId ? { finalReviewId: state.finalReviewId } : {}), ...(state.acceptanceId ? { acceptanceId: state.acceptanceId } : {}), ...(state.releaseId ? { releaseId: state.releaseId } : {}) });
    if (result.outcome === "no_drift") {
      const priorRevision = state.revision;
      if (true) state = IssueWorkflowStateSchema.parse({ ...state, targetBaseSha: result.observedBaseSha, resultCommit: result.headSha, resultTree: result.headTree });
      state = applyTargetBaseNoDrift(state, result);
      if (state.revision !== priorRevision) await projectIssueState(state);
      return true;
    }
    if (result.outcome === "revalidated") state = applyTargetBaseRevalidation(state, result);
    else if (result.outcome === "blocked") applyTargetBaseBlocked(result);
    else {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: [], pendingAction: "Lead conflict-resolution plan", targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null, forwardMergePriorHead: result.priorHead, forwardMergePriorTree: result.priorTree, forwardMergeTargetBaseSha: result.observedBaseSha, forwardMergeConflictArtifact: result.conflictArtifact, forwardMergeConflictFileCount: result.conflictFileCount, forwardMergeId: result.checkId, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await planMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, worktreePath: state.worktreePath!, branchName: state.branchName!, priorHead: result.priorHead, targetBaseSha: result.observedBaseSha, conflictArtifact: result.conflictArtifact, conflictFileCount: result.conflictFileCount, forwardMergeId: result.checkId });
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Forge could not prepare a conflict plan. Try resolving again.", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
    }
    await projectIssueState(state);
    return false;
  };
  const supervisedDeveloperTurns = true;
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
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Lead delivery review", branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: typeof result.currentStep === "number" ? result.currentStep : null, dirtyState: result.dirtyState, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "repair") {
      if (typeof result.branchName !== "string" || typeof result.targetBaseSha !== "string" || (result.dirtyState !== "clean" && result.dirtyState !== "dirty") || result.outcome !== "completed" || typeof result.cycle !== "number") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", branchName: result.branchName, targetBaseSha: result.targetBaseSha, dirtyState: result.dirtyState, repairCycle: result.cycle, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "merge_conflict_resolution") {
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", targetBaseSha: state.forwardMergeTargetBaseSha ?? state.targetBaseSha, dirtyState: "clean", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, mergeResolutionDeveloperExecutionId: result.developerExecutionId as string, mergeResolutionDeveloperSessionRef: result.developerSessionRef as string, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    return false;
  };
  setHandler(issueStateQuery, () => state);
  setHandler(syncGithubPullRequestSignal, () => { githubSyncRequested = true; });
  const syncGithubPullRequest = async (): Promise<void> => {
    if (!state.releaseRepository && !sourcePullRequest && true) sourcePullRequest = await loadTaskSourcePullRequest({ taskId: state.issueId, companyId: state.companyId }).then((source) => sourcePullRequestState(source, true), () => undefined);
    if (!state.releaseRepository && sourcePullRequest) { state = IssueWorkflowStateSchema.parse(advanceSourcePullRequestState(state, sourcePullRequest)); await projectIssueState(state); }
    if (!state.releaseRepository || !state.branchName) return;
    // GitHub reconciliation only runs while Forge is waiting on GitHub. While an agent turn or a
    // publish is in flight, an observation must not rewrite the phase under it. delivery_ready holds an
    // unreleased local head (after a repair the PR still points at the failed commit), so it is skipped too.
    const syncSkipsAgentPhases = true;
    if (syncSkipsAgentPhases && !isSourcePullRequestPreDelivery(state, sourcePullRequest) && (state.activeOperation !== null || ["planning", "supplemental_review", "plan_consolidation", "development", "reviewing_delivery", "repair_required", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_repair_planning", "ci_repairing", "final_review", ...(true ? ["delivery_ready"] : [])].includes(state.phase))) return;
    const observed = await observeGithubPullRequest({ repository: state.releaseRepository, branch: state.branchName, pullRequestNumber: state.pullRequestNumber }).catch(() => null);
    if (!observed) return;
    const common = githubPullRequestObservationFields(observed, new Date().toISOString());
    if (isSourcePullRequestPreDelivery(state, sourcePullRequest) && observed.state !== "merged") { state = IssueWorkflowStateSchema.parse(advanceSourcePullRequestState(state, common)); await projectIssueState(state); return; }
    if (true) {
      const target: PullRequestTarget = validatedInput.deliveryTarget === "merged" ? "merged" : validatedInput.deliveryTarget === "pull_request_ready" ? "ready" : "draft";
      const checks = observed.checks.failing > 0 ? "failed" : observed.checks.pending > 0 ? "pending" : observed.checks.total > 0 && observed.checks.successful === observed.checks.total ? "success" : "none";
      const conflictResolutionEnabled = true;
      const reconciliation = reconcile({ observed: { exists: observed.exists, number: observed.number, state: observed.state, isDraft: observed.isDraft, headSha: observed.headSha, mergeable: conflictResolutionEnabled ? observed.mergeable : null, checks, reviewDecision: observed.reviewDecision, autoMergeEnabled: observed.autoMergeEnabled }, target, current: { phase: state.phase, ...(state.pullRequestNumber !== undefined ? { pullRequestNumber: state.pullRequestNumber } : {}), ...(state.expectedHeadSha !== undefined ? { observedHeadSha: state.expectedHeadSha } : {}), ...(state.autoMergeAvailable !== undefined ? { autoMergeAvailable: state.autoMergeAvailable } : {}), ...(state.githubPullRequestObservationKey !== undefined ? { adoptedObservationKey: state.githubPullRequestObservationKey } : {}) } });
      const revision = state.revision + 1;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision, phase: reconciliation.phase === "Done" ? "done" : reconciliation.phase === "Merging" ? "manual_merge" : reconciliation.phase === "Resolving conflicts" ? "merge_conflict_reviewing" : reconciliation.phase === "Waiting for CI" ? "ci_waiting" : reconciliation.phase === "Opening PR" ? "releasing" : "delivery_blocked", owner: reconciliation.owner === "human" ? "human" : "lead", allowedCommands: reconciliation.allowedCommands.filter((command): command is IssueCommand => command === "publish_draft" || command === "cancel_issue" || command === "send_planner_note"), pendingAction: reconciliation.pendingAction, githubPullRequestObservationKey: [observed.number ?? "none", observed.state ?? "none", observed.isDraft ?? "none", observed.headSha ?? "none", observed.reviewDecision ?? "none"].join(":"), mergeOutcome: observed.state === "merged" ? "merged" : state.mergeOutcome, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${revision}` });
      await projectIssueState(state);
      for (const action of reconciliation.actions) {
        if ((action.kind === "enable_auto_merge" || action.kind === "merge" || action.kind === "mark_ready") && state.releaseRepository) {
          const failure = await applyGithubPullRequestAction({ repository: state.releaseRepository, number: action.number, headSha: "headSha" in action ? action.headSha : observed.headSha ?? "", action: action.kind }).then(() => null, (error: Error & { cause?: { message?: string } }) => error.cause?.message ?? error.message);
          if (failure !== null) {
            if (action.kind === "enable_auto_merge" && /auto.?merge is not allowed|not enabled for this repository/i.test(failure)) {
              state = IssueWorkflowStateSchema.parse({ ...state, autoMergeAvailable: false, revision: state.revision + 1, pendingAction: "Auto-merge is not available. Forge will merge directly.", lastEventId: `${state.workflowId}:${state.revision + 1}` });
              await projectIssueState(state);
              continue;
            }
            state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, pendingAction: `GitHub ${action.kind.replaceAll("_", " ")} failed: ${failure} — retrying`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
            await projectIssueState(state);
          }
        }
        else if (action.kind === "resolve_conflicts") {
          if (await runTargetBaseCheckpoint("pre_release")) {
            state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "GitHub reports merge conflicts, but the branch already contains the base branch. Waiting for GitHub to re-check.", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
            await projectIssueState(state);
          }
        }
        else if ((action.kind === "push_open_draft" || action.kind === "push_open_ready") && state.phase === "releasing") await workflowContext.runPublishTurn();
        else if (action.kind === "repair_ci" && state.phase === "ci_waiting") await workflowContext.reconcileCiTurn();
      }
      return;
    }
  };
  const captureInitialProjectionState = true;
  const initialProjectionState = state;
  const projectCapacityState = async (capacity: IssueWorkflowState["capacity"], pendingAction?: string): Promise<number> => {
    const changed = JSON.stringify(state.capacity) !== JSON.stringify(capacity) || (pendingAction !== undefined && state.pendingAction !== pendingAction);
    if (!changed) return state.revision;
    state = IssueWorkflowStateSchema.parse({ ...state, capacity, ...(capacity === null ? { capacityBlocker: null } : {}), ...(pendingAction !== undefined ? { pendingAction } : {}), revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state.revision;
  };
  const acquireExternalTurn = createAcquireExternalTurn({ get: () => state, set: (next) => { state = next; } }, { projectState: projectIssueState });
  const guarded = createGuarded({ get: () => state, set: (next) => { state = next; } }, { enabled: guardedHandlersEnabled, reviseContinueEnabled, failedRetryEnabled, project: projectIssueState });
  const workflowContext = createIssueWorkflowContext(validatedInput, state, {
    project: () => {
      // A run projecting more than 100 revisions in a wall-clock second is a hot loop, not progress:
      // log it and pause for real time so HTTP and timers keep running. Otherwise stay synchronous so
      // command/auto-chain ordering is unchanged.
      const now = Date.now();
      projectionStamps.push(now);
      while (projectionStamps.length && now - projectionStamps[0]! > 1_000) projectionStamps.shift();
      state = withWorktreeCommands(state, true);
      if (projectionStamps.length > 100) { log.error("Issue run is projecting in a hot loop; throttling", { workflowId: state.workflowId, phase: state.phase, revision: state.revision }); return new Promise<void>((resolve) => setTimeout(resolve, 1_000)).then(() => projectIssueState(state)); }
      return projectIssueState(state);
    },
    projectState: (value) => { state = withWorktreeCommands(value, true); return projectIssueState(state); },
    projectInitialPlanningState: async (next, distinctPlanningStates) => { if (distinctPlanningStates || !true) await projectIssueState(next); },
    planningProjectionFlags: () => { const distinctPlanningStates = true; return { distinctPlanningStates, shouldProject: distinctPlanningStates || !true }; },
    leadPlanningEnabled: () => true,
    durablePlanningCapacityEnabled: () => true,
    leadResultRoutingEnabled: () => true,
    planGovernanceEnabled: () => true,
    decisionResolutionProjectionEnabled: () => true,
    continueAfter: 0, reviseContinueEnabled, exactPlanAuthorityEnabled, isolatedDeveloperExecutionEnabled, initialProjectionBarrierEnabled, planApprovalBlockerEnabled,
    guarded, captureInitialProjectionState, initialProjectionState, initialProjection,
    get stateMutationLocked() { return stateMutationLocked; },
    set stateMutationLocked(value: boolean) { stateMutationLocked = value; },
    get continuationRequested() { return continuationRequested; },
    set continuationRequested(value: boolean) { continuationRequested = value; },
    get initialProjectionComplete() { return initialProjectionComplete; },
    set initialProjectionComplete(value: boolean) { initialProjectionComplete = value; },
    get decisionInFlight() { return decisionInFlight; },
    set decisionInFlight(value: boolean) { decisionInFlight = value; },
    get planningScope() { return planningScope; },
    set planningScope(value: CancellationScope | undefined) { planningScope = value; },
    get planningPromise() { return planningPromise; },
    set planningPromise(value: Promise<LeadPlanningResult> | undefined) { planningPromise = value; },
    supervisedDeveloperTurns, herdrExecutionSubstrateEnabled, shouldContinueAsNew, currentState, addRevisionCommand, approvalCommands, approvalBlocker,
    withStateMutation, commandAlreadyProcessed, markCommandProcessed, recordHandlerNoop,
    applyTargetBaseBlocked, runTargetBaseCheckpoint, recoveryFields, applyCompletedDeveloperResult, projectCapacityState, acquireExternalTurn,
    cancelCurrentCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    settleCancelledCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    permanentActivityFailure, failureBlockCategory, leadResultKind, applyLeadResult, applyLegacyLeadResult,
    leadPlanningPatch, leadResultRoutingPatch, planningProjectionIntegrityPatch, distinctPlanningStatesPatch, durableCapacityPatch, planGovernancePatch, decisionResolutionProjectionPatch,
    exhaustedActivityRecoveryPatch, developerFailureRecoveryPatch, developerReconciliationRecoveryPatch, developerBlockedRecoveryStatePatch, cancelBlockedDeveloperResultPatch,
    artifactBackedReviewPatch, exactDeliveryReviewPatch, typedReleaseResultPatch, targetBaseReconciliationPatch, exactAcceptanceReceiptPatch, artifactBackedConflictPatch, unconditionalCancelPatch, rateLimitFailure,
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
  void true;
  assertPayloadWithinLimit("Issue Workflow result", state);
  // Continue-As-New carries the last business revision into a fresh run; re-emitting it would read as conflicting authoritative history.
  try {
    if (workflowContext.exactPlanAuthorityEnabled) await workflowContext.initialProjection;
    else {
      if (!continuation) await workflowContext.projectState(workflowContext.captureInitialProjectionState ? workflowContext.initialProjectionState : workflowContext.state);
      workflowContext.initialProjectionComplete = true;
    }
    while (true) {
      if ((workflowContext.state.phase === "done" && !workflowContext.state.allowedCommands.includes("delete_worktree")) || (workflowContext.state.phase === "cancelled" && !(true && (workflowContext.state.allowedCommands.includes("continue_work") || workflowContext.state.allowedCommands.includes("delete_worktree"))))) { if (true) await condition(allHandlersFinished); return workflowContext.state; } // finish only after every handler landed its projection; a terminal issue offering cleanup or continuation stays open
      if (githubSyncRequested) {
        githubSyncRequested = false;
        if (true) await syncGithubPullRequest();
        continue;
      }
      if (workflowContext.state.phase === "releasing" && workflowContext.state.activeOperation === null && !workflowContext.state.releaseRetryAt) {
        workflowContext.state = IssueWorkflowStateSchema.parse({ ...workflowContext.state, revision: workflowContext.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: workflowContext.addRevisionCommand(["review_delivery", "cancel_issue"]), pendingAction: "Publish was interrupted — re-review before publishing", lastEventId: `${workflowContext.state.workflowId}:${workflowContext.state.revision + 1}` });
        await workflowContext.project();
        continue;
      }
      if (workflowContext.state.phase === "releasing" && workflowContext.state.releaseRetryAt) {
        const delay = Math.max(0, Date.parse(workflowContext.state.releaseRetryAt) - Date.now());
        if (delay > 0) await sleep(delay);
        if (workflowContext.state.phase === "releasing") await workflowContext.runPublishTurn();
        continue;
      }
      if (workflowContext.state.phase === "ci_waiting") {
        const sleepingRevision = workflowContext.state.revision;
        const sleepingReleaseId = workflowContext.state.releaseId;
        const sleepingHeadSha = workflowContext.state.expectedHeadSha;
        const pollAt = workflowContext.state.ciNextPollAt ? isoEpochMillis(workflowContext.state.ciNextPollAt) : Date.now();
        const delay = Math.max(0, pollAt - Date.now());
        if (delay > 0) await sleep(delay);
        if (workflowContext.state.phase !== "ci_waiting" || workflowContext.state.revision !== sleepingRevision || workflowContext.state.releaseId !== sleepingReleaseId || workflowContext.state.expectedHeadSha !== sleepingHeadSha) continue;
        if (true) await syncGithubPullRequest();
        // CI reconciliation needs a release; without one the PR sync above is the only observer. Never throw from the loop.
        if (workflowContext.state.phase === "ci_waiting" && workflowContext.state.releaseId) await workflowContext.reconcileCiTurn();
        else if (workflowContext.state.phase === "ci_waiting" && true && workflowContext.state.resultCommit && workflowContext.state.branchName && !workflowContext.state.deliveryReviewId) {
          // ci_waiting without a release is a dead end: an unreleased exact delivery goes back through review and publish.
          workflowContext.state = IssueWorkflowStateSchema.parse({ ...workflowContext.state, revision: workflowContext.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", ciNextPollAt: null, lastEventId: `${workflowContext.state.workflowId}:${workflowContext.state.revision + 1}` });
          await workflowContext.project();
        }
        else if (workflowContext.state.phase === "ci_waiting") await sleep("60 seconds");
        continue;
      }
      if (workflowContext.state.phase === "manual_merge" && true) {
        if (true) { await condition(() => githubSyncRequested, "60 seconds"); githubSyncRequested = false; } else await sleep("60 seconds"); // a sync signal (webhook, operator) wakes the poll
        if (workflowContext.state.phase === "manual_merge") await syncGithubPullRequest();
        continue;
      }
      if (workflowContext.state.phase === "ready_reconciliation") {
        await sleepUntil(workflowContext.state.acceptanceRetryAt);
        if (workflowContext.state.phase === "ready_reconciliation") await workflowContext.reconcileAcceptanceTurn();
        continue;
      }
      if (await autoRetryDeliveryBlocker(workflowContext)) continue;
      const chained = allHandlersFinished() ? autoChainedCommand(workflowContext, autoChainLeadPhasesPatch) : null;
      if (chained) {
        await runAutoChainedCommand(workflowContext, chained);
        continue;
      }
      await condition(() => githubSyncRequested || (true && allHandlersFinished() && !workflowContext.state.allowedCommands.includes("delete_worktree") && (workflowContext.state.phase === "done" || (workflowContext.state.phase === "cancelled" && !workflowContext.state.allowedCommands.includes("continue_work")))) || (workflowContext.continuationRequested && allHandlersFinished()) || (workflowContext.state.phase === "releasing" && Boolean(workflowContext.state.releaseRetryAt)) || workflowContext.state.phase === "ci_waiting" || workflowContext.state.phase === "ready_reconciliation" || workflowContext.state.phase === "manual_merge" || (allHandlersFinished() && (autoChainedCommand(workflowContext, autoChainLeadPhasesPatch) !== null || canAutoRetryDeliveryBlocker(workflowContext))));
    }
  } catch (error) {
    if (!isCancellation(error)) throw error;
    // External cancellation projects the same cancelled phase as cancel_issue in a non-cancellable scope.
    await CancellationScope.nonCancellable(async () => {
      if (state.phase === "cancelled" || state.phase === "done") return;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Issue cancelled externally", blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    });
    throw error;
  }
}
