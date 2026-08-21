import { allHandlersFinished, CancellationScope, condition, continueAsNew, defineQuery, isCancellation, patched, setHandler, sleep, workflowInfo } from "@temporalio/workflow";

import { ProbeWorkflowInputSchema, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import {
  buildInitialIssueWorkflowState,
  IssueProjectionEventSchema,
  IssueWorkflowInputSchema,
  IssueWorkflowStateSchema,
  type IssueBlocker,
  type IssueBlockerAction,
  type IssueCommand,
  type IssueWorkflowInput,
  type IssueWorkflowState,
  type LeadPlanningResult,
  type ReconcileTargetBaseActivityResult,
  type TargetBaseCheckpoint,
} from "./issue-contracts.js";
import { assertContinuationStateWithinLimit, assertPayloadWithinLimit, WORKFLOW_HISTORY_EVENT_LIMIT } from "./policy.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "./target-base.js";
import {
  planMergeConflict,
  projectIssueStateActivity,
  reconcileTargetBase,
  recordProbeStarted,
} from "./workflow/activity-proxies.js";
import { evidencePointer, humanBlocker } from "./workflow/state-transitions.js";
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
import { applyLeadResult, applyLegacyLeadResult, autoChainedCommand, compactStateForContinuation, createAcquireExternalTurn, createGuarded, failureBlockCategory, isoEpochMillis, leadResultKind, permanentActivityFailure, rateLimitFailure, runAutoChainedCommand } from "./workflow/runtime.js";

export * from "./issue-updates.js";
export { repairBlockedState, repairRequiredState, repairedDeliveryAwaitingFreshReviewState, reviewApprovedState, reviewBlockedState, reviewingDeliveryState } from "./workflow/state-transitions.js";
async function projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState> {
  return projectIssueStateActivity(IssueProjectionEventSchema.parse({
    schemaVersion: 1,
    runId: workflowInfo().runId,
    eventId: state.lastEventId,
    state,
  }));
}

const MAX_RECONCILIATION_ATTEMPTS = 20;

function sleepUntil(retryAt: string | null | undefined): Promise<void> {
  if (!retryAt) return sleep("1 second");
  return sleep(Math.max(1, Date.parse(retryAt) - Date.now()));
}

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
const captureInitialProjectionStatePatch = "forge-capture-initial-projection-state-v1";
const artifactBackedConflictPatch = "forge-artifact-backed-conflict-evidence-v1";
const artifactBackedReviewPatch = "forge-artifact-backed-review-evidence-v1";
const exactDeliveryReviewPatch = "forge-exact-delivery-review-v1";
const typedReleaseResultPatch = "forge-typed-release-result-v1";
const targetBaseReconciliationPatch = "forge-target-base-reconciliation-v1";
const exactAcceptanceReceiptPatch = "forge-exact-acceptance-receipt-v1";
const reviseContinuePatch = "forge-revise-continue-v1";
const developerSupervisorPatch = "forge-developer-supervisor-v1";
const exactPlanAuthorityPatch = "forge-exact-plan-authority-v2";
const isolatedDeveloperExecutionPatch = "forge-isolated-developer-execution-v1";
const initialProjectionBarrierPatch = "forge-initial-projection-barrier-v1";
const planApprovalBlockerPatch = "forge-plan-approval-blocker-v1";

const durableCapacityPatch = "durable-capacity-v1";
const decisionResolutionProjectionPatch = "forge-decision-resolution-projection-v1";
const exhaustedActivityRecoveryPatch = "forge-exhausted-activity-recovery-v1";
const capacityFinalizationOwnershipPatch = "forge-capacity-finalization-ownership-v1";
const capacityReadmissionPatch = "forge-capacity-readmit-v1";
const guardedHandlersPatch = "forge-guarded-handlers-v1";
const autoChainLeadPhasesPatch = "forge-auto-chain-lead-phases-v1";
const unconditionalCancelPatch = "forge-unconditional-cancel-v1";

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const continuation = validatedInput.continuationState;
  const continueAfter = validatedInput.continueAsNewAfter ?? 0;
  const reviseContinueEnabled = patched(reviseContinuePatch);
  const guardedHandlersEnabled = patched(guardedHandlersPatch);
  const addRevisionCommand = (commands: IssueCommand[]): IssueCommand[] => reviseContinueEnabled && !commands.includes("revise_plan") ? [...commands, "revise_plan"] : commands;
  let state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState(validatedInput),
    activeOperation: null,
    processedCommandIds: [],
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  const exactPlanAuthorityEnabled = patched(exactPlanAuthorityPatch);
  const isolatedDeveloperExecutionEnabled = patched(isolatedDeveloperExecutionPatch);
  const initialProjectionBarrierEnabled = patched(initialProjectionBarrierPatch);
  const planApprovalBlockerEnabled = patched(planApprovalBlockerPatch);
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
    return humanBlocker("member_authorization", "Member approval is required for this material plan.", actions, evidencePointer(result.leadOutputArtifactId, result.leadOutputSha256 ?? result.leadOutputArtifactSha256, "lead-plan"));
  };
  const initialProjection = continuation || !exactPlanAuthorityEnabled ? Promise.resolve(state) : projectIssueState(state);
  let continuationRequested = false;
  let initialProjectionComplete = Boolean(continuation);
  let decisionInFlight = false;
  const currentState = (): IssueWorkflowState => state;
  let planningScope: CancellationScope | undefined;
  let planningPromise: Promise<LeadPlanningResult> | undefined;
  const shouldContinueAsNew = (revision: number): boolean => {
    return workflowInfo().continueAsNewSuggested || (continueAfter > 0 && revision >= continueAfter) || workflowInfo().historyLength >= WORKFLOW_HISTORY_EVENT_LIMIT;
  };
  let stateMutationLocked = false;
  const withStateMutation = async <T>(operation: () => T): Promise<T> => {
    await condition(() => !stateMutationLocked);
    stateMutationLocked = true;
    try { return operation(); } finally { stateMutationLocked = false; }
  };
  const commandAlreadyProcessed = (commandId: string): boolean => commandId !== "legacy-command" && (state.processedCommandIds ?? []).includes(commandId);
  const markCommandProcessed = (commandId: string): void => {
    const processed = state.processedCommandIds ?? [];
    if (commandId !== "legacy-command" && !processed.includes(commandId)) state = IssueWorkflowStateSchema.parse({ ...state, processedCommandIds: [...processed, commandId].slice(-64) });
  };
  const applyTargetBaseBlocked = (result: Extract<ReconcileTargetBaseActivityResult, { outcome: "blocked" }>): void => {
    const verification = result.code === "verification_failed" || result.code === "verification_timed_out" || result.code === "verification_evidence_too_large";
    const retryable = result.retryable || (result.code === "merge_state_ownership_mismatch" && Boolean(state.forwardMergeId));
    const allowedCommands = retryable ? [verification ? "retry_forward_merge_verification" : "retry_target_base_reconciliation", "cancel_issue"] as const : ["cancel_issue"] as const;
    state = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      phase: "delivery_blocked",
      owner: result.owner === "lead" ? "lead" : "human",
      allowedCommands,
      pendingAction: result.summary,
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      targetBaseCheckId: result.checkId,
      targetBaseCheckpoint: result.checkpoint,
      targetBaseOutcome: result.outcome,
      targetBaseBlockerCode: result.code,
      targetBaseBlockerOwner: result.owner,
      targetBaseBlockerRetryable: retryable,
      targetBaseBlockerSummary: result.summary,
      ...recoveryFields(null, null, null, null),
      ...(verification && result.observedBaseSha ? { forwardMergeTargetBaseSha: result.observedBaseSha } : {}),
      ...(verification && result.resultHead ? { resultCommit: result.resultHead } : {}),
      ...(verification && result.resultTree ? { resultTree: result.resultTree } : {}),
      ...(verification && result.evidenceArtifact ? { developerEvidenceArtifactId: result.evidenceArtifact.id, developerOutcome: "blocked" as const } : {}),
    });
  };
  const runTargetBaseCheckpoint = async (checkpoint: TargetBaseCheckpoint, verificationOnly = false): Promise<boolean> => {
    if (!patched(targetBaseReconciliationPatch)) return true;
    if (!state.developerExecutionId || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("An exact Developer delivery is required before target-base reconciliation");
    const result = await reconcileTargetBase({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, checkpoint, developerExecutionId: state.developerExecutionId, expectedBaseSha: state.targetBaseSha, expectedHeadSha: state.resultCommit, expectedHeadTree: state.resultTree, ...(state.forwardMergeId ? { forwardMergeId: state.forwardMergeId } : {}), ...(verificationOnly ? { verificationOnly: true } : {}), ...(state.deliveryReviewId ? { deliveryReviewId: state.deliveryReviewId } : {}), ...(state.ciRunId ? { ciRunId: state.ciRunId } : {}), ...(state.finalReviewId ? { finalReviewId: state.finalReviewId } : {}), ...(state.acceptanceId ? { acceptanceId: state.acceptanceId } : {}), ...(state.releaseId ? { releaseId: state.releaseId } : {}) });
    if (result.outcome === "no_drift") {
      const priorRevision = state.revision;
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
  const supervisedDeveloperTurns = patched(developerSupervisorPatch);
  const recoveryFields = (status: "starting" | "active" | "reconnecting" | "result_pending_claim" | "cancellation_requested" | "cancelling" | "interrupted" | "cancelled" | "ownership_ambiguous" | "failed" | null, reasonCode: string | null, summary: string | null, heartbeatAt: string | null) => ({ developerRecoveryStatus: status, developerRecoveryReasonCode: reasonCode, developerRecoverySummary: summary, developerLastHeartbeatAt: heartbeatAt });
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
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead delivery review required", branchName: result.branchName, targetBaseSha: result.targetBaseSha, dirtyState: result.dirtyState, repairCycle: result.cycle, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "merge_conflict_resolution") {
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead delivery review required after conflict resolution", targetBaseSha: state.forwardMergeTargetBaseSha ?? state.targetBaseSha, dirtyState: "clean", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, mergeResolutionDeveloperExecutionId: result.developerExecutionId as string, mergeResolutionDeveloperSessionRef: result.developerSessionRef as string, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    return false;
  };
  setHandler(issueStateQuery, () => state);
  const captureInitialProjectionState = patched(captureInitialProjectionStatePatch);
  const initialProjectionState = state;
  const projectCapacityState = async (capacity: IssueWorkflowState["capacity"], pendingAction?: string): Promise<number> => {
    const changed = JSON.stringify(state.capacity) !== JSON.stringify(capacity) || (pendingAction !== undefined && state.pendingAction !== pendingAction);
    if (!changed) return state.revision;
    state = IssueWorkflowStateSchema.parse({ ...state, capacity, ...(capacity === null ? { capacityBlocker: null } : {}), ...(pendingAction !== undefined ? { pendingAction } : {}), revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    const projectedRevision = state.revision;
    await projectIssueState(state);
    return projectedRevision;
  };
  const acquireExternalTurn = createAcquireExternalTurn({ get: () => state, set: (next) => { state = next; } }, { projectState: projectIssueState, projectCapacityState, patched, durableCapacityPatch, capacityFinalizationOwnershipPatch, capacityReadmissionPatch });
  const guarded = createGuarded({ get: () => state, set: (next) => { state = next; } }, { enabled: guardedHandlersEnabled, reviseContinueEnabled, project: projectIssueState });
  const workflowContext = createIssueWorkflowContext(validatedInput, state, {
    project: () => projectIssueState(state),
    projectState: (value) => projectIssueState(value),
    projectInitialPlanningState: async (next, distinctPlanningStates) => {
      if (distinctPlanningStates || !patched(planningProjectionIntegrityPatch)) await projectIssueState(next);
    },
    planningProjectionFlags: () => {
      const distinctPlanningStates = patched(distinctPlanningStatesPatch);
      return { distinctPlanningStates, shouldProject: distinctPlanningStates || !patched(planningProjectionIntegrityPatch) };
    },
    leadPlanningEnabled: () => patched(leadPlanningPatch),
    durablePlanningCapacityEnabled: () => patched(durableCapacityPatch),
    leadResultRoutingEnabled: () => patched(leadResultRoutingPatch),
    planGovernanceEnabled: () => patched(planGovernancePatch),
    decisionResolutionProjectionEnabled: () => patched(decisionResolutionProjectionPatch),
    continueAfter,
    reviseContinueEnabled,
    exactPlanAuthorityEnabled,
    isolatedDeveloperExecutionEnabled,
    initialProjectionBarrierEnabled,
    planApprovalBlockerEnabled,
    patched,
    guarded,
    captureInitialProjectionState,
    initialProjectionState,
    initialProjection,
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
    supervisedDeveloperTurns,
    shouldContinueAsNew,
    currentState,
    addRevisionCommand,
    approvalCommands,
    approvalBlocker,
    withStateMutation,
    commandAlreadyProcessed,
    markCommandProcessed,
    applyTargetBaseBlocked,
    runTargetBaseCheckpoint,
    recoveryFields,
    applyCompletedDeveloperResult,
    projectCapacityState,
    acquireExternalTurn,
    cancelCurrentCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    preserveAmbiguousCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    settleCancelledCapacity: async () => { throw new Error("Capacity cancellation is not initialized"); },
    permanentActivityFailure,
    failureBlockCategory,
    leadResultKind,
    applyLeadResult,
    applyLegacyLeadResult,
    leadPlanningPatch,
    leadResultRoutingPatch,
    planningProjectionIntegrityPatch,
    distinctPlanningStatesPatch,
    durableCapacityPatch,
    planGovernancePatch,
    decisionResolutionProjectionPatch,
    exhaustedActivityRecoveryPatch,
    developerFailureRecoveryPatch,
    developerReconciliationRecoveryPatch,
    developerBlockedRecoveryStatePatch,
    cancelBlockedDeveloperResultPatch,
    artifactBackedReviewPatch,
    exactDeliveryReviewPatch,
    typedReleaseResultPatch,
    targetBaseReconciliationPatch,
    exactAcceptanceReceiptPatch,
    artifactBackedConflictPatch,
    unconditionalCancelPatch,
    rateLimitFailure,
    maxReconciliationAttempts: MAX_RECONCILIATION_ATTEMPTS,
    runPublishTurn: async () => { throw new Error("Publish runtime is not initialized"); },
    reconcileCiTurn: async () => { throw new Error("CI runtime is not initialized"); },
    reconcileMergeTurn: async () => { throw new Error("Merge runtime is not initialized"); },
    reconcileAcceptanceTurn: async () => { throw new Error("Acceptance runtime is not initialized"); },
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
  // Continue-As-New carries the last business revision into a fresh run. The
  // previous run already projected that revision, so emitting it again with a
  // different continuationCount would correctly look like conflicting
  // authoritative history to the projection boundary.
  try {
    if (workflowContext.exactPlanAuthorityEnabled) await workflowContext.initialProjection;
    else {
      if (!continuation) await workflowContext.projectState(workflowContext.captureInitialProjectionState ? workflowContext.initialProjectionState : workflowContext.state);
      workflowContext.initialProjectionComplete = true;
    }
    while (true) {
      if (workflowContext.state.phase === "cancelled" || workflowContext.state.phase === "done") return workflowContext.state;
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
        await workflowContext.reconcileCiTurn();
        continue;
      }
      if (workflowContext.state.phase === "ready_reconciliation") {
        await sleepUntil(workflowContext.state.acceptanceRetryAt);
        if (workflowContext.state.phase === "ready_reconciliation") await workflowContext.reconcileAcceptanceTurn();
        continue;
      }
      if (workflowContext.state.phase === "manual_merge") {
        await sleepUntil(workflowContext.state.mergeRetryAt);
        if (workflowContext.state.phase === "manual_merge") await workflowContext.reconcileMergeTurn();
        continue;
      }
      const chained = allHandlersFinished() ? autoChainedCommand(workflowContext, autoChainLeadPhasesPatch) : null;
      if (chained) {
        await runAutoChainedCommand(workflowContext, chained);
        continue;
      }
      await condition(() => (workflowContext.continuationRequested && allHandlersFinished()) || (workflowContext.state.phase === "releasing" && Boolean(workflowContext.state.releaseRetryAt)) || workflowContext.state.phase === "ci_waiting" || workflowContext.state.phase === "ready_reconciliation" || workflowContext.state.phase === "manual_merge" || (allHandlersFinished() && autoChainedCommand(workflowContext, autoChainLeadPhasesPatch) !== null));
      if (workflowContext.continuationRequested && allHandlersFinished()) {
        if (workflowContext.stateMutationLocked || workflowContext.state.activeOperation !== null) continue;
        const compact = compactStateForContinuation(workflowContext.state);
        assertContinuationStateWithinLimit(compact);
        await continueAsNew<typeof issueWorkflow>({ ...validatedInput, continuationState: compact, continueAsNewAfter: continueAfter });
      }
    }
  } catch (error) {
    if (!isCancellation(error)) throw error;
    // An external `temporal workflow cancel` lands here as a CancelledFailure from
    // whatever the loop was awaiting. Project the same cancelled phase the
    // cancel_issue update produces, in a non-cancellable scope since the ambient
    // cancellation would otherwise abort the projection activity itself.
    await CancellationScope.nonCancellable(async () => {
      if (state.phase === "cancelled" || state.phase === "done") return;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Issue cancelled externally", blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    });
    throw error;
  }
}
