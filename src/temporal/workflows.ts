import { ActivityFailure, allHandlersFinished, ApplicationFailure, condition, continueAsNew, defineQuery, defineUpdate, patched, proxyActivities, setHandler, sleep, workflowInfo } from "@temporalio/workflow";

import { ProbeWorkflowInputSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowInputSchema, IssueWorkflowStateSchema, PlanCommandInputSchema, RecordProgressInputSchema, StartPlanningInputSchema, type AcceptDeliveryActivityInput, type IssueActivities, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type PublishReleaseActivityInput, type PublishReleaseActivityResult, type RecordProgressInput, type ReconcileTargetBaseActivityResult, type StartPlanningInput, type TargetBaseCheckpoint } from "./issue-contracts.js";
import { assertContinuationStateWithinLimit, assertPayloadWithinLimit, WORKFLOW_HISTORY_EVENT_LIMIT } from "./policy.js";
import { isRetryableReleaseFailure } from "../release-failures.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "./target-base.js";

const { recordProbeStarted } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
});

const { projectIssueState: projectIssueStateActivity } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});

async function projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState> {
  return projectIssueStateActivity(IssueProjectionEventSchema.parse({
    schemaVersion: 1,
    runId: workflowInfo().runId,
    eventId: state.lastEventId,
    state,
  }));
}
const { runLeadPlanning } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
});
const { runSupplementalReview, consolidateLeadPlan } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
});
const { runDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 1 },
});
const { cancelDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { recordPlanDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});
const { reviewDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { runDeveloperRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 1 },
});
const { recordDeliveryDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { publishRelease } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 5, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});
const { reconcileTargetBase } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});
const { planMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { resolveMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 1 },
});
const { reconcileCi } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});
const { planCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { runCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 1 },
});
const { finalReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { planDeliveryRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { acceptDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});
const { reconcileAcceptance } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});
const { reconcileMerge } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

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
export const startPlanningUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("startPlanning");
export const recordProgressUpdate = defineUpdate<IssueWorkflowState, [RecordProgressInput]>("recordProgress");
export const requestSupplementalReviewUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("requestSupplementalReview");
export const approvePlanUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("approvePlan");
export const rejectPlanUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("rejectPlan");
export const startDevelopmentUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("startDevelopment");
export const retryDevelopmentUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryDevelopment");
export const cancelDevelopmentUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("cancelDevelopment");
export const reviewDeliveryUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reviewDelivery");
export const repairDeliveryUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("repairDelivery");
export const recordDeliveryDecisionUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("recordDeliveryDecision");
export const publishDraftUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("publishDraft");
export const resolveMergeConflictUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("resolveMergeConflict");
export const retryTargetBaseReconciliationUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryTargetBaseReconciliation");
export const retryForwardMergeVerificationUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryForwardMergeVerification");
export const reconcileCIUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileCI");
export const repairCIUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("repairCI");
export const finalReviewUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("finalReview");
export const acceptDeliveryUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("acceptDelivery");
export const requestDeliveryChangesUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("requestDeliveryChanges");
export const cancelIssueUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("cancelIssue");
export const reconcileAcceptanceUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileAcceptance");
export const reconcileMergeUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileMerge");
const leadPlanningPatch = "forge-lead-planning-v1";
const planGovernancePatch = "forge-plan-governance-v1";
const planningProjectionIntegrityPatch = "forge-planning-projection-integrity-v1";
const distinctPlanningStatesPatch = "forge-distinct-planning-states-v1";
const developerFailureRecoveryPatch = "forge-developer-failure-recovery-v1";
const captureInitialProjectionStatePatch = "forge-capture-initial-projection-state-v1";
const artifactBackedConflictPatch = "forge-artifact-backed-conflict-evidence-v1";
const artifactBackedReviewPatch = "forge-artifact-backed-review-evidence-v1";
const typedReleaseResultPatch = "forge-typed-release-result-v1";
const targetBaseReconciliationPatch = "forge-target-base-reconciliation-v1";
const exactAcceptanceReceiptPatch = "forge-exact-acceptance-receipt-v1";

function compactStateForContinuation(state: IssueWorkflowState): IssueWorkflowState {
  const compact = { ...state, activeOperation: null } as Record<string, unknown>;
  for (const key of ["worktreePath", "deliveryBlockingFindings", "deliveryRepairPlan", "forwardMergeConflictFiles", "forwardMergeConflictDiff", "conflictFiles", "conflictDiff"]) delete compact[key];
  return IssueWorkflowStateSchema.parse(compact);
}

function permanentActivityFailure(error: unknown): { code: string; summary: string } | undefined {
  if (!(error instanceof ActivityFailure) || !(error.cause instanceof ApplicationFailure) || !error.cause.nonRetryable) return undefined;
  const detail = error.cause.details?.[0];
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.summary === "string") return { code: record.code, summary: record.summary };
  }
  return { code: error.cause.type ?? "permanent-activity-failure", summary: error.cause.message || "The invocation cannot complete without a configuration change." };
}

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const continuation = validatedInput.continuationState;
  const continueAfter = validatedInput.continueAsNewAfter ?? 0;
  let state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState(validatedInput),
    activeOperation: null,
    processedCommandIds: [],
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  let continuationRequested = false;
  let initialProjectionComplete = Boolean(continuation);
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
    const allowedCommands = result.retryable ? [verification ? "retry_forward_merge_verification" : "retry_target_base_reconciliation", "cancel_issue"] as const : ["cancel_issue"] as const;
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
      targetBaseBlockerRetryable: result.retryable,
      targetBaseBlockerSummary: result.summary,
      ...(verification && result.observedBaseSha ? { forwardMergeTargetBaseSha: result.observedBaseSha } : {}),
      ...(verification && result.resultHead ? { resultCommit: result.resultHead } : {}),
      ...(verification && result.resultTree ? { resultTree: result.resultTree } : {}),
      ...(verification && result.evidenceArtifact ? { developerEvidenceArtifactId: result.evidenceArtifact.id, developerOutcome: "blocked" as const } : {}),
    });
  };
  const runTargetBaseCheckpoint = async (checkpoint: TargetBaseCheckpoint, verificationOnly = false): Promise<boolean> => {
    if (!patched(targetBaseReconciliationPatch)) return true;
    if (!state.developerExecutionId || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("An exact Developer delivery is required before target-base reconciliation");
    const result = await reconcileTargetBase({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, checkpoint, developerExecutionId: state.developerExecutionId, expectedBaseSha: state.targetBaseSha, expectedHeadSha: state.resultCommit, expectedHeadTree: state.resultTree, ...(verificationOnly ? { verificationOnly: true, forwardMergeId: state.targetBaseCheckId ?? undefined } : {}), ...(state.deliveryReviewId ? { deliveryReviewId: state.deliveryReviewId } : {}), ...(state.ciRunId ? { ciRunId: state.ciRunId } : {}), ...(state.finalReviewId ? { finalReviewId: state.finalReviewId } : {}), ...(state.acceptanceId ? { acceptanceId: state.acceptanceId } : {}), ...(state.releaseId ? { releaseId: state.releaseId } : {}) });
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
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Lead conflict-resolution planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
    }
    await projectIssueState(state);
    return false;
  };
  setHandler(issueStateQuery, () => state);
  const captureInitialProjectionState = patched(captureInitialProjectionStatePatch);
  const initialProjectionState = state;
  setHandler(startPlanningUpdate, async (rawInput) => {
    if (captureInitialProjectionState) await condition(() => initialProjectionComplete);
    assertPayloadWithinLimit("startPlanning command", rawInput);
    StartPlanningInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      phase: "planning",
      revision: state.revision + 1,
      owner: "lead",
      allowedCommands: continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      continuationCount: state.continuationCount,
      lastSummaryHash: state.lastSummaryHash,
    });
    state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    const distinctPlanningStates = patched(distinctPlanningStatesPatch);
    if (distinctPlanningStates || !patched(planningProjectionIntegrityPatch)) await projectIssueState(next);
    if (patched(leadPlanningPatch)) {
      let leadResult;
      try {
        leadResult = await runLeadPlanning({
          taskId: validatedInput.issueId,
          companyId: validatedInput.companyId,
          workflowId: validatedInput.workflowId,
          projectId: validatedInput.projectId,
          projectRevisionId: validatedInput.projectRevisionId,
          briefArtifactId: validatedInput.briefArtifactId,
          imageArtifactIds: validatedInput.imageArtifactIds,
          roleProfiles: validatedInput.roleProfiles,
          revision: next.revision,
        });
      } catch (error) {
        const failure = permanentActivityFailure(error);
        if (!failure) throw error;
        state = IssueWorkflowStateSchema.parse({
          ...next,
          phase: "failed",
          revision: next.revision + 1,
          owner: "human",
          allowedCommands: ["start_planning", "cancel_issue"],
          pendingAction: failure.summary,
          lastEventId: `${state.workflowId}:${next.revision + 1}`,
        });
        await projectIssueState(state);
        return state;
      }
      state = IssueWorkflowStateSchema.parse({ ...next, ...leadResult, ...(distinctPlanningStates ? { revision: next.revision + 1, lastEventId: `${next.workflowId}:${next.revision + 1}` } : {}), planRevision: next.revision, planMaterial: leadResult.material, materialCategories: leadResult.materialCategories, supplementalReviewUsed: false });
      if (patched(planGovernancePatch)) {
        state = leadResult.material
          ? IssueWorkflowStateSchema.parse({ ...state, phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue", ...(validatedInput.supplementalReview ? ["request_supplemental_review" as const] : [])], pendingAction: "Approve final plan" })
          : IssueWorkflowStateSchema.parse({ ...state, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development" });
      }
      assertPayloadWithinLimit("Issue Workflow result", state);
      await projectIssueState(state);
    }
    return state;
  }, {
    validator(rawInput) {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "backlog" && state.phase !== "planning" && state.phase !== "failed") throw new Error("Planning can only start from Backlog, Planning, or Failed");
    },
  });
  const validatePlanCommand = (rawInput: PlanCommandInput): PlanCommandInput => {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "approval") throw new Error("Plan command is not available in the current phase");
    return command;
  };
  setHandler(requestSupplementalReviewUpdate, async (rawInput) => {
    assertPayloadWithinLimit("supplemental review command", rawInput);
    const command = validatePlanCommand(rawInput);
    const review = await runSupplementalReview({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.planRevision ?? state.revision, leadOutputArtifactId: state.leadOutputArtifactId!, leadEvidenceArtifactId: state.leadEvidenceArtifactId! });
    const consolidated = await consolidateLeadPlan({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.revision + 1, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId });
    state = IssueWorkflowStateSchema.parse({ ...state, ...consolidated, revision: state.revision + 1, phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue"], pendingAction: "Approve final plan", lastEventId: `${state.workflowId}:${state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, planMaterial: consolidated.material, materialCategories: consolidated.materialCategories, planRevision: state.planRevision ?? state.revision });
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    validatePlanCommand(rawInput);
    if (!validatedInput.supplementalReview || state.supplementalReviewUsed) throw new Error("Supplemental review is not available");
    if (!state.planMaterial || !state.leadOutputArtifactId || !state.leadSessionRef) throw new Error("A material Lead plan is required before supplemental review");
    if (!validatedInput.roleProfiles.reviewer) throw new Error("A supplemental reviewer profile is required");
  } });
  setHandler(approvePlanUpdate, async (rawInput) => {
    assertPayloadWithinLimit("plan approval command", rawInput);
    const command = validatePlanCommand(rawInput);
    const decision = await recordPlanDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision: state.planRevision ?? state.revision, actorUserId: command.actorUserId, decision: "approve", note: command.note ?? "Approved final plan" });
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${state.workflowId}:${state.revision + 1}`, decisionId: decision.decisionId });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) { validatePlanCommand(rawInput); if (!state.planMaterial) throw new Error("Routine plans do not require approval"); } });
  setHandler(startDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("start development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    const executionId = `developer_${state.workflowId}_${command.commandId}`.slice(0, 256);
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || state.phase !== "ready_for_development") throw new Error("Development start was superseded by another command");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "development", owner: "lead", allowedCommands: ["cancel_development", "reject_plan", "cancel_issue"], pendingAction: "Developer execution", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: executionId, activeOperation: { commandId: command.commandId, kind: "development", startedRevision: state.revision + 1 } });
      markCommandProcessed(command.commandId);
    });
    await projectIssueState(state);
    const recoverDeveloperFailures = patched(developerFailureRecoveryPatch);
    let result: Awaited<ReturnType<typeof runDeveloperExecution>>;
    try {
      result = await runDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, executionId });
    } catch (error) {
      if (!recoverDeveloperFailures) throw error;
      const applied = await withStateMutation(() => {
        if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Developer execution failed; retry is available", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null });
        if (shouldContinueAsNew(state.revision)) continuationRequested = true;
        return true;
      });
      if (applied) await projectIssueState(state);
      return state;
    }
    const applied = await withStateMutation(() => {
      if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["retry_development", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, activeOperation: null });
      if (shouldContinueAsNew(state.revision)) continuationRequested = true;
      return true;
    });
    if (applied) await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "ready_for_development") throw new Error("Development can only start after plan approval");
    if (!state.planMaterial || !state.leadOutputArtifactId || !state.leadSessionRef) throw new Error("An approved material Lead plan is required before development");
  } });
  setHandler(retryDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("retry development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    const executionId = `developer_${state.workflowId}_${command.commandId}`.slice(0, 256);
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || (state.phase !== "development" && state.phase !== "delivery_blocked")) throw new Error("Developer retry was superseded by another command");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "development", owner: "lead", allowedCommands: ["cancel_development", "reject_plan", "cancel_issue"], pendingAction: "Developer retry", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: { commandId: command.commandId, kind: "development", startedRevision: state.revision + 1 } });
      markCommandProcessed(command.commandId);
    });
    await projectIssueState(state);
    const result = await runDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, supersedesExecutionId: state.developerExecutionId!, reuseWorktree: true, executionId });
    const applied = await withStateMutation(() => {
      if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["retry_development", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome });
      if (shouldContinueAsNew(state.revision)) continuationRequested = true;
      return true;
    });
    if (applied) await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "development" && state.phase !== "delivery_blocked") throw new Error("Developer retry is not available in the current phase");
    if (!state.developerExecutionId || !state.planMaterial || !state.leadOutputArtifactId || !state.leadSessionRef) throw new Error("A preserved Developer attempt and approved plan are required before retry");
  } });
  setHandler(reviewDeliveryUpdate, async (rawInput) => {
    assertPayloadWithinLimit("delivery review command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    const reviewing = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "reviewing_delivery", owner: "lead", allowedCommands: [], pendingAction: "Lead delivery review", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    state = reviewing;
    await projectIssueState(state);
    const result = await reviewDelivery({
      taskId: validatedInput.issueId,
      companyId: validatedInput.companyId,
      workflowId: validatedInput.workflowId,
      projectId: validatedInput.projectId,
      projectRevisionId: validatedInput.projectRevisionId,
      briefArtifactId: validatedInput.briefArtifactId,
      planRevision: state.planRevision ?? state.revision,
      roleProfiles: validatedInput.roleProfiles,
      leadSessionRef: state.leadSessionRef!,
      leadOutputArtifactId: state.leadOutputArtifactId!,
      developerExecutionId: state.developerExecutionId!,
      deliveryArtifactId: state.deliveryArtifactId!,
      evidenceArtifactId: state.developerEvidenceArtifactId!,
      branchName: state.branchName!,
      targetBaseSha: state.targetBaseSha!,
      subjectCommit: state.resultCommit!,
      subjectTree: state.resultTree!,
    });
    const legacyReview = !patched(artifactBackedReviewPatch);
    const legacyResult = result as typeof result & { findings?: Array<{ severity: "blocking" | "advisory"; disposition: "open" | "accepted" | "repaired" }>; repairPlan?: string | null; reviewArtifact?: typeof result.reviewArtifact };
    if (!legacyReview && !legacyResult.reviewArtifact) throw ApplicationFailure.nonRetryable("Delivery review artifact is missing", "delivery_review_artifact_missing");
    const legacyFindings = legacyResult.findings ?? [];
    const openBlocking = legacyFindings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    const canRepair = result.outcome === "blocking" && (legacyReview ? legacyResult.repairPlan !== null && openBlocking.length > 0 : true) && (state.repairCycle ?? 0) < validatedInput.repairCycleLimit;
    const nextPhase = result.outcome === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "delivery_blocked";
    state = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      phase: nextPhase,
      owner: nextPhase === "repair_required" ? "lead" : "human",
      allowedCommands: nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"],
      pendingAction: nextPhase === "repair_required" ? "Developer repair of blocking findings" : nextPhase === "delivery_blocked" ? "Member decision required" : "Publish draft pull request",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      deliveryReviewId: result.reviewId,
      deliveryReviewOutcome: result.outcome,
      deliveryReviewSummary: result.summary,
      deliveryBlockingFindings: openBlocking,
      deliveryRepairPlan: legacyResult.repairPlanArtifactId ? null : legacyResult.repairPlan ?? null,
      deliveryRepairPlanArtifactId: legacyResult.repairPlanArtifactId ?? null,
      deliveryRepairPlanSha256: legacyResult.repairPlanSha256 ?? null,
      deliveryRepairAuthority: result.outcome === "blocking" ? "delivery_review" : null,
      ...(!legacyReview ? { deliveryReviewArtifact: legacyResult.reviewArtifact } : {}),
      repairCycle: state.repairCycle ?? 0,
    });
    if (legacyReview) continuationRequested = true;
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "delivery_ready") throw new Error("Delivery review is not available in the current phase");
    if (!state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.deliveryArtifactId || !state.developerEvidenceArtifactId || !state.leadSessionRef || !state.leadOutputArtifactId) throw new Error("An exact Developer delivery and Lead session are required before review");
  } });
  setHandler(repairDeliveryUpdate, async (rawInput) => {
    assertPayloadWithinLimit("delivery repair command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    const cycle = (state.repairCycle ?? 0) + 1;
    const repairing = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer repair cycle ${cycle}`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    state = repairing;
    await projectIssueState(state);
    const result = await runDeveloperRepair({
      taskId: validatedInput.issueId,
      companyId: validatedInput.companyId,
      workflowId: validatedInput.workflowId,
      projectId: validatedInput.projectId,
      projectRevisionId: validatedInput.projectRevisionId,
      planRevision: state.planRevision ?? state.revision,
      roleProfiles: validatedInput.roleProfiles,
      leadSessionRef: state.leadSessionRef!,
      developerSessionRef: state.developerSessionRef!,
      developerExecutionId: state.developerExecutionId!,
      reviewId: state.deliveryReviewId!,
      cycle,
      repairCycleLimit: validatedInput.repairCycleLimit,
      branchName: state.branchName!,
      targetBaseSha: state.targetBaseSha!,
      subjectCommit: state.resultCommit!,
      subjectTree: state.resultTree!,
      blockingFindings: state.deliveryBlockingFindings ?? [],
      repairAuthority: state.deliveryRepairAuthority ?? "delivery_review",
      ...(state.deliveryRepairAuthority === "delivery_review" && state.deliveryReviewArtifact ? { reviewArtifact: state.deliveryReviewArtifact } : state.deliveryRepairPlanArtifactId && state.deliveryRepairPlanSha256 ? { repairPlanArtifactId: state.deliveryRepairPlanArtifactId, repairPlanSha256: state.deliveryRepairPlanSha256 } : { repairPlan: state.deliveryRepairPlan! }),
    });
    const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
    state = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      phase: nextPhase,
      owner: result.outcome === "completed" ? "lead" : "human",
      allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"],
      pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required" : "Member decision required",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      developerExecutionId: result.developerExecutionId,
      developerSessionRef: result.developerSessionRef,
      branchName: result.branchName,
      targetBaseSha: result.targetBaseSha,
      resultCommit: result.resultCommit,
      resultTree: result.resultTree,
      dirtyState: result.dirtyState,
      deliveryArtifactId: result.deliveryArtifactId,
      developerEvidenceArtifactId: result.evidenceArtifactId,
      deliverySummary: result.deliverySummary,
      developerOutcome: result.outcome,
      repairCycle: result.cycle,
      deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId,
      deliveryReviewOutcome: result.outcome === "completed" ? null : state.deliveryReviewOutcome,
      deliveryReviewSummary: result.outcome === "completed" ? null : state.deliveryReviewSummary,
      ...(result.outcome === "completed" ? { deliveryBlockingFindings: [], deliveryRepairPlan: null, deliveryRepairAuthority: null } : {}),
    });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "repair_required") throw new Error("Delivery repair is not available in the current phase");
    if (!state.deliveryReviewId || (!state.deliveryReviewArtifact && (!state.deliveryRepairPlan && !state.deliveryRepairPlanArtifactId || !(state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open")))) throw new Error("Open blocking findings and a bounded repair plan are required");
    if ((state.repairCycle ?? 0) >= validatedInput.repairCycleLimit) throw new Error("Delivery repair limit is exhausted");
    if (!state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.leadSessionRef) throw new Error("The prior Developer delivery must be preserved before repair");
  } });
  setHandler(recordDeliveryDecisionUpdate, async (rawInput) => {
    assertPayloadWithinLimit("delivery decision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    const decision = await recordDeliveryDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, actorUserId: command.actorUserId, note: command.note?.trim() || "Member decision recorded for blocked delivery" });
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: [], pendingAction: "Member decision recorded", lastEventId: `${state.workflowId}:${state.revision + 1}`, deliveryDecisionArtifactId: decision.artifactId });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "delivery_blocked" || !state.allowedCommands.includes("record_delivery_decision")) throw new Error("A member decision is not available in the current phase");
  } });
  const runFinalReviewTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.releaseId || !state.deliveryReviewId || !state.ciRunId || !state.leadSessionRef || !state.leadOutputArtifactId || !state.developerExecutionId || !state.deliveryArtifactId || !state.developerEvidenceArtifactId || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("Exact release, pull request, delivery review, CI, Lead, and Developer evidence is required for final review");
    if (!(await runTargetBaseCheckpoint("pre_final_review"))) return state;
    let result;
    try {
      result = await finalReview({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, roleProfiles: validatedInput.roleProfiles, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId!, ciRunId: state.ciRunId, ...(state.releaseRepository && state.baseBranch && state.pullRequestNumber ? { pullRequestNumber: state.pullRequestNumber, repository: state.releaseRepository, baseBranch: state.baseBranch } : {}), planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef, leadOutputArtifactId: state.leadOutputArtifactId, developerExecutionId: state.developerExecutionId, deliveryArtifactId: state.deliveryArtifactId, evidenceArtifactId: state.developerEvidenceArtifactId, ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}), branchName: state.branchName, targetBaseSha: state.targetBaseSha, subjectCommit: state.resultCommit, subjectTree: state.resultTree });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["final_review", "request_delivery_changes", "cancel_issue"], pendingAction: "Final review is temporarily unavailable; retry the exact review or request changes", finalReviewFailureCode: "final_review_unavailable", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    let repairPlan = result.outcome === "blocking" ? {
      planArtifactId: result.repairPlanArtifactId,
      planSha256: result.repairPlanSha256,
      findings: result.findings,
    } : undefined;
    if (result.outcome === "blocking") {
      try {
        const planned = await planDeliveryRepair({
          taskId: validatedInput.issueId,
          companyId: validatedInput.companyId,
          workflowId: validatedInput.workflowId,
          projectId: validatedInput.projectId,
          projectRevisionId: validatedInput.projectRevisionId,
          source: "final_review_blocking",
          leadSessionRef: state.leadSessionRef,
          planRevision: state.planRevision ?? state.revision,
          releaseId: state.releaseId,
          deliveryReviewId: state.deliveryReviewId,
          finalReviewId: result.finalReviewId,
          ciRunId: state.ciRunId,
          evidenceArtifactIds: [result.evidenceArtifactId, result.opinionArtifactId],
          branchName: state.branchName,
          worktreePath: state.worktreePath ?? ".",
          targetBaseSha: state.targetBaseSha,
          subjectCommit: state.resultCommit,
          subjectTree: state.resultTree,
          findings: result.findings,
        });
        repairPlan = { planArtifactId: planned.planArtifactId, planSha256: planned.planSha256, findings: planned.findings };
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["record_delivery_decision", "cancel_issue"], pendingAction: "Final-review repair planning failed; inspect the recorded evidence", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, finalReviewSummary: result.summary, finalReviewOpinionArtifactId: result.opinionArtifactId, finalReviewEvidenceArtifactId: result.evidenceArtifactId, finalReviewFindings: result.findings, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
    }
    const nextPhase = result.outcome === "approved" ? "accepted" : "repair_required";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: result.outcome === "approved" ? "human" : "lead", allowedCommands: result.outcome === "approved" ? ["accept_delivery", "request_delivery_changes", "cancel_issue"] : ["repair_delivery", "cancel_issue"], pendingAction: result.outcome === "approved" ? "Member acceptance required" : "Lead repair plan required", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, finalReviewSummary: result.summary, finalReviewOpinionArtifactId: result.opinionArtifactId, finalReviewEvidenceArtifactId: result.evidenceArtifactId, finalReviewFailureCode: null, finalReviewFindings: result.findings, finalReviewRepairPlanArtifactId: repairPlan?.planArtifactId ?? null, finalReviewRepairPlanSha256: repairPlan?.planSha256 ?? null, deliveryBlockingFindings: result.outcome === "blocking" ? repairPlan?.findings ?? result.findings : state.deliveryBlockingFindings, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan?.planArtifactId ?? null, deliveryRepairPlanSha256: repairPlan?.planSha256 ?? null, deliveryRepairAuthority: result.outcome === "blocking" ? "final_review" : null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  const runExactCiRepairTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.ciRepairPlanId || !state.ciRepairPlanArtifactId || !state.ciRepairPlanEvidenceArtifactId || !state.ciAttemptId || !state.ciRunId || !state.expectedHeadSha || !state.resultCommit || !state.resultTree || !state.developerExecutionId || !state.developerSessionRef || !state.branchName) throw new Error("The exact CI repair plan and prior Developer delivery are required");
    const ciRunId = state.ciRunId;
    const ciAttemptId = state.ciAttemptId;
    const repairPlanId = state.ciRepairPlanId;
    const repairPlanArtifactId = state.ciRepairPlanArtifactId;
    const repairPlanEvidenceArtifactId = state.ciRepairPlanEvidenceArtifactId;
    const failedHeadSha = state.expectedHeadSha;
    const priorDeveloperExecutionId = state.developerExecutionId;
    const priorDeveloperSessionRef = state.developerSessionRef;
    const branchName = state.branchName;
    const priorCommit = state.resultCommit;
    const priorTree = state.resultTree;
    const releaseId = state.releaseId;
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repairing", owner: "lead", allowedCommands: [], pendingAction: "Developer repairing the exact failed CI result", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    try {
      const result = await runCiRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, ...(releaseId ? { releaseId } : {}), projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, ciRunId, ciAttemptId, repairPlanId, repairPlanArtifactId, repairPlanEvidenceArtifactId, failedHeadSha, priorDeveloperExecutionId, priorDeveloperSessionRef, branchName, priorCommit, priorTree });
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required after CI repair" : "CI repair is blocked", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.outcome === "completed" ? "clean" : "dirty", deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.summary, developerOutcome: result.outcome === "completed" ? "completed" : "blocked", deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId, releaseId: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, ciRepairDeveloperExecutionId: result.developerExecutionId, ciRepairDeveloperSessionRef: result.developerSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_required", owner: "human", allowedCommands: ["repair_ci", "cancel_issue"], pendingAction: "CI repair failed; retry the same exact repair", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    }
    await projectIssueState(state);
    return state;
  };
  const reconcileCiTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.releaseId || !state.expectedHeadSha) throw new Error("Exact release head is required for CI reconciliation");
    const attempt = (state.ciAttempt ?? 0) + 1;
    const expectedReleaseId = state.releaseId;
    const expectedHeadSha = state.expectedHeadSha;
    const expectedRevision = state.revision;
    let result;
    try {
      result = await reconcileCi({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, releaseId: state.releaseId, expectedHeadSha: state.expectedHeadSha, attemptNumber: attempt });
    } catch {
      if (state.phase !== "ci_waiting" || state.revision !== expectedRevision || state.releaseId !== expectedReleaseId || state.expectedHeadSha !== expectedHeadSha) return state;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ciAttempt: attempt, ciOutcome: "provider_unavailable", ciReason: "provider_failure_budget_exhausted", ciOwner: "human", ciRepairable: false, ciNextPollAt: null, phase: "delivery_blocked", owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], pendingAction: "CI provider reconciliation failed", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (state.phase !== "ci_waiting" || state.revision !== expectedRevision || state.releaseId !== expectedReleaseId || state.expectedHeadSha !== expectedHeadSha) return state;
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ciAttempt: result.attemptNumber, ciAttemptId: result.attemptId, ciRunId: result.runId, ciOutcome: result.outcome, ciReason: result.reason, ciOwner: result.owner, ciRepairable: result.repairable, ciEvidenceArtifactId: result.evidenceArtifactId, ciPolicyHash: result.policyHash, ciPropagationDeadline: result.propagationDeadline, ciOverallDeadline: result.overallDeadline, ciNextPollAt: result.nextPollAt, pendingAction: result.outcome === "waiting" || result.outcome === "rate_limited" ? "Waiting for required CI" : result.summary, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    if (result.outcome === "passed") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "final_review", owner: "lead", allowedCommands: [], pendingAction: "Final Lead review", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return runFinalReviewTurn();
    }
    if (result.outcome === "failed" && result.repairable && result.owner === "lead" && result.evidenceArtifactId && state.leadSessionRef && state.ciAttemptId) {
      const leadSessionRef = state.leadSessionRef;
      const ciAttemptId = state.ciAttemptId;
      const evidenceArtifactId = result.evidenceArtifactId;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_planning", owner: "lead", allowedCommands: [], pendingAction: "Lead diagnosis of exact-head CI failure", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await planCiRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, leadSessionRef, ciRunId: result.runId, ciAttemptId, failedHeadSha: expectedHeadSha, evidenceArtifactId, requiredChecks: [], localVerification: [] });
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_required", owner: "lead", allowedCommands: [], pendingAction: "Developer repairing the exact failed CI result", ciRepairPlanId: plan.planId, ciRepairPlanArtifactId: plan.planArtifactId, ciRepairPlanEvidenceArtifactId: plan.evidenceArtifactId, ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return runExactCiRepairTurn();
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Lead CI repair planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      await projectIssueState(state);
    } else if (!(result.owner === "system" && result.retryAt)) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], pendingAction: result.summary, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    }
    return state;
  };
  const reconcileMergeTurn = async (): Promise<IssueWorkflowState> => {
    const exactAcceptanceReceipts = patched(exactAcceptanceReceiptPatch);
    if (!state.releaseId || !state.expectedHeadSha || !state.acceptanceId) throw new Error("Exact accepted release head is required for merge reconciliation");
    const attempt = (state.mergeAttempt ?? 0) + 1;
    if (attempt > MAX_RECONCILIATION_ATTEMPTS) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "reconcile_merge", "cancel_issue"], pendingAction: "Merge reconciliation retry limit exhausted", mergeAttempt: attempt, mergeBlockerCode: "merge_reconciliation_exhausted", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    let result;
    try {
      result = await reconcileMerge({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, acceptanceId: state.acceptanceId });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "manual_merge", owner: "human", allowedCommands: ["reconcile_merge", "cancel_issue"], pendingAction: "GitHub merge state is temporarily unavailable", mergeAttempt: attempt, mergeOutcome: "provider_unavailable", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (exactAcceptanceReceipts && result.outcome === "merged" && (!result.mergeObservationId || !result.completionReceiptId || !result.mergedAt)) throw new Error("Merged reconciliation requires an immutable observation and completion receipt");
    const nextPhase = result.outcome === "merged" ? "done" : result.outcome === "open" || result.outcome === "provider_unavailable" ? "manual_merge" : "delivery_blocked";
    if (!exactAcceptanceReceipts) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "reconcile_merge", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "done" ? "Merged pull request confirmed" : "Pull request changed or closed without merge", mergeOutcome: result.outcome, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "reconcile_merge", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "done" ? "Merged pull request confirmed" : "Pull request changed or closed without merge", mergeAttempt: attempt, mergeOutcome: result.outcome, mergeObservationId: result.mergeObservationId, completionReceiptId: result.completionReceiptId, mergeRetryAt: result.retryAt, mergeBlockerCode: result.blockerCode ?? null, mergeBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, pullRequestNumber: result.pullRequestNumber || state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || state.pullRequestUrl, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  const runPublishTurn = async (): Promise<IssueWorkflowState> => {
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "releasing", owner: "lead", allowedCommands: [], pendingAction: "Publishing one exact draft pull request", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    if (!state.deliveryReviewId || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("Approved exact delivery is required before publishing");
    if (!(await runTargetBaseCheckpoint("pre_release"))) return state;
    const typedReleaseResult = patched(typedReleaseResultPatch);
    const publishInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, reviewId: state.deliveryReviewId, developerExecutionId: state.developerExecutionId!, branchName: state.branchName, targetBaseSha: state.targetBaseSha, subjectCommit: state.resultCommit, subjectTree: state.resultTree, ...(state.releaseId ? { releaseId: state.releaseId } : {}) };
    const rawResult = await publishRelease((typedReleaseResult ? publishInput : { ...publishInput, planSummary: state.leadSummary ?? "Approved Forge plan", deliverySummary: state.deliverySummary ?? "Exact Developer delivery", verificationSummary: "Lead delivery review approved", ...(state.pullRequestNumber ? { expectedPullRequestNumber: state.pullRequestNumber } : {}) }) as PublishReleaseActivityInput);
    let result: PublishReleaseActivityResult = rawResult;
    if (!typedReleaseResult) {
      const legacy = rawResult as unknown as Omit<PublishReleaseActivityResult, "outcome" | "attempt"> & { baseDriftMerged?: boolean; baseDriftConflict?: boolean };
      result = { ...legacy, outcome: legacy.baseDriftConflict ? "base-drift-conflict" : legacy.baseDriftMerged ? "base-drift-merged" : "completed", attempt: 0 } as PublishReleaseActivityResult;
    }
    if (result.outcome === "blocked") {
      if (result.code === "stale-reviewed-revision") {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead review required for the exact Developer revision", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseStatus: "blocked", releaseFailureCode: result.code, releaseFailureSummary: result.summary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
      const retryable = isRetryableReleaseFailure(result.code);
      const waitingForRateLimit = result.code === "provider-rate-limited" && result.retryAt !== null;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: waitingForRateLimit ? "releasing" : "delivery_blocked", owner: waitingForRateLimit ? "lead" : "human", allowedCommands: waitingForRateLimit ? ["cancel_issue"] : [...(retryable ? ["publish_draft"] : []), "cancel_issue"], pendingAction: waitingForRateLimit ? "Waiting for GitHub rate-limit reset" : result.summary ?? "Release provider reconciliation requires attention", releaseStatus: waitingForRateLimit ? "reconciling" : "blocked", releaseFailureCode: result.code ?? "provider-unavailable", releaseFailureSummary: result.summary ?? "Release provider reconciliation requires attention", releaseRetryAt: result.retryAt ?? null, releaseOperationAttempt: result.attempt, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (result.outcome === "base-drift-conflict") {
      const legacyConflict = !patched(artifactBackedConflictPatch);
      if (!legacyConflict && !result.mergeConflictEvidence) throw ApplicationFailure.nonRetryable("Merge-conflict evidence is missing", "merge_conflict_evidence_missing");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: [], pendingAction: "Lead conflict-resolution plan", targetBaseSha: result.targetBaseSha ?? state.targetBaseSha, forwardMergeId: result.forwardMergeId ?? null, forwardMergePriorHead: result.priorHead ?? state.resultCommit, forwardMergeTargetBaseSha: result.targetBaseSha ?? state.targetBaseSha, ...(result.mergeConflictEvidence ? { mergeConflictEvidence: result.mergeConflictEvidence } : {}), ...(legacyConflict ? { forwardMergeConflictFiles: result.conflictFiles ?? [], forwardMergeConflictDiff: result.conflictDiff ?? null } : {}), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const legacyPlanInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, branchName: state.branchName!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, ...(state.mergeConflictEvidence ? { conflictEvidence: state.mergeConflictEvidence } : { conflictFiles: state.forwardMergeConflictFiles ?? [], conflictDiff: state.forwardMergeConflictDiff ?? "" }), ...(state.forwardMergeId ? { forwardMergeId: state.forwardMergeId } : {}) } as unknown as Parameters<typeof planMergeConflict>[0];
        const plan = await planMergeConflict(legacyPlanInput);
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Lead conflict-resolution planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      if (legacyConflict) continuationRequested = true;
      await projectIssueState(state);
      return state;
    }
    if (result.outcome === "base-drift-merged") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery"], pendingAction: "Fresh Lead review required after target-base forward merge", targetBaseSha: result.targetBaseSha ?? state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (result.outcome !== "completed" || !result.releaseId || result.pullRequestNumber === null || result.pullRequestUrl === null) throw new Error("Release completion result is incomplete");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Waiting for required CI", releaseStatus: "draft", releaseFailureCode: null, releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, ciAttempt: 0, ciOutcome: "waiting", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  setHandler(publishDraftUpdate, async (rawInput) => {
    StartPlanningInputSchema.parse(rawInput);
    return runPublishTurn();
  }, { validator(rawInput) { const command = StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision"); if (!(state.phase === "delivery_reviewed" || (state.phase === "delivery_blocked" && state.releaseStatus === "blocked" && state.allowedCommands.includes("publish_draft"))) || !state.deliveryReviewId) throw new Error("Draft publication is not available in the current phase"); } });
  setHandler(resolveMergeConflictUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "merge_conflict_required") throw new Error("Merge-conflict resolution is not available in the current phase");
    if (!state.mergeResolutionPlanArtifactId || !state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.forwardMergeId || !state.forwardMergePriorHead || !state.forwardMergeTargetBaseSha || !state.forwardMergeConflictArtifact || typeof state.forwardMergeConflictFileCount !== "number") throw new Error("A Lead conflict plan and owned Developer worktree are required");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_resolving", owner: "lead", allowedCommands: [], pendingAction: "Developer resolving forward-merge conflicts", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    try {
      const result = await resolveMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision: state.planRevision ?? state.revision, forwardMergeId: state.forwardMergeId!, developerExecutionId: state.developerExecutionId!, developerSessionRef: state.developerSessionRef!, branchName: state.branchName!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, conflictArtifact: state.forwardMergeConflictArtifact!, conflictFileCount: state.forwardMergeConflictFileCount!, planArtifactId: state.mergeResolutionPlanArtifactId! });
      if ("outcome" in result && result.outcome === "verification_blocked") {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: result.summary, targetBaseOutcome: "blocked", targetBaseBlockerCode: result.code, targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", developerEvidenceArtifactId: result.verificationArtifact.id, developerOutcome: "blocked", lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        void command;
        return state;
      }
      const successfulResult = result as Extract<typeof result, { deliveryArtifactId: string }>;
      state = applyTargetBaseRevalidation(state, { outcome: "revalidated", checkId: state.forwardMergeId!, checkpoint: state.targetBaseCheckpoint ?? "pre_release", expectedBaseSha: state.targetBaseSha!, observedBaseSha: state.forwardMergeTargetBaseSha!, priorHead: state.forwardMergePriorHead!, priorTree: state.forwardMergePriorTree!, headSha: successfulResult.resultCommit, headTree: successfulResult.resultTree, developerExecutionId: successfulResult.developerExecutionId, deliveryArtifact: { id: successfulResult.deliveryArtifactId, sha256: successfulResult.deliveryArtifactSha256, kind: "forward-merge-delivery" }, verificationArtifact: { id: successfulResult.verificationArtifactId, sha256: successfulResult.verificationArtifactSha256, kind: "forward-merge-verification" } });
      state = IssueWorkflowStateSchema.parse({ ...state, developerSessionRef: successfulResult.developerSessionRef, deliverySummary: successfulResult.summary, developerEvidenceArtifactId: successfulResult.verificationArtifactId, mergeResolutionDeveloperExecutionId: successfulResult.developerExecutionId, mergeResolutionDeveloperSessionRef: successfulResult.developerSessionRef });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution is incomplete; retry the same owned turn", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    }
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "merge_conflict_required" || !state.allowedCommands.includes("resolve_merge_conflict")) throw new Error("Merge-conflict resolution is not available in the current phase");
  } });
  const retryTargetBase = async (rawInput: StartPlanningInput, verificationOnly: boolean): Promise<IssueWorkflowState> => {
    const command = StartPlanningInputSchema.parse(rawInput);
    const checkpoint = state.targetBaseCheckpoint;
    if (command.expectedRevision !== state.revision || state.phase !== "delivery_blocked" || !checkpoint) throw new Error("Target-base reconciliation retry is not available in the current phase");
    if (verificationOnly && !["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(state.targetBaseBlockerCode ?? "")) throw new Error("Verification retry is not available for the current blocker");
    if (!verificationOnly && !state.targetBaseBlockerRetryable) throw new Error("Target-base reconciliation is not retryable");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: verificationOnly ? "Retrying pinned forward-merge verification" : "Retrying target-base reconciliation", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    await runTargetBaseCheckpoint(checkpoint, verificationOnly);
    void command;
    return state;
  };
  setHandler(retryTargetBaseReconciliationUpdate, (rawInput) => retryTargetBase(rawInput, false));
  setHandler(retryForwardMergeVerificationUpdate, (rawInput) => retryTargetBase(rawInput, true));
  setHandler(reconcileCIUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || !["ci_waiting", "delivery_blocked"].includes(state.phase) || !state.allowedCommands.includes("reconcile_ci")) throw new Error("CI reconciliation is not available in the current phase");
    if (state.phase === "delivery_blocked") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Retrying CI reconciliation", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    }
    return reconcileCiTurn();
  });
  setHandler(repairCIUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "ci_repair_required") throw new Error("CI repair is not available in the current phase");
    if (state.ciRepairPlanId && state.ciRepairPlanArtifactId && state.ciRepairPlanEvidenceArtifactId && state.ciAttemptId && state.ciRunId && state.expectedHeadSha && state.resultCommit && state.resultTree && state.developerExecutionId && state.developerSessionRef && state.branchName) return runExactCiRepairTurn();
    if (!state.deliveryReviewId || !state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.leadSessionRef) throw new Error("The exact prior Developer delivery is required for CI repair");
    const cycle = (state.repairCycle ?? 0) + 1;
    if (cycle > validatedInput.repairCycleLimit) throw new Error("CI repair limit is exhausted");
    const priorDelivery = { leadSessionRef: state.leadSessionRef!, developerSessionRef: state.developerSessionRef!, developerExecutionId: state.developerExecutionId!, reviewId: state.deliveryReviewId!, worktreePath: state.worktreePath!, branchName: state.branchName!, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, ciOutcome: state.ciOutcome };
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer CI repair cycle ${cycle}`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    const ciFindings = (state.deliveryBlockingFindings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    const repairFindings = ciFindings.length ? ciFindings : [{ findingId: `ci_failure_${state.revision}`, severity: "blocking" as const, rationale: `Required CI did not pass: ${priorDelivery.ciOutcome ?? "failed"}`, evidenceRef: state.ciRunId ?? "CI reconciliation", disposition: "open" as const, repairInstruction: "Resolve the exact-head CI failure and rerun the required checks." }];
    const repairPlan = await planDeliveryRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, source: "ci_failure", leadSessionRef: priorDelivery.leadSessionRef, planRevision: state.planRevision ?? state.revision, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId, ciRunId: state.ciRunId, evidenceArtifactIds: [state.developerEvidenceArtifactId, state.finalReviewEvidenceArtifactId].filter((id): id is string => Boolean(id)), branchName: priorDelivery.branchName, worktreePath: priorDelivery.worktreePath, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, findings: repairFindings });
    const result = await runDeveloperRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: priorDelivery.leadSessionRef, developerSessionRef: priorDelivery.developerSessionRef, developerExecutionId: priorDelivery.developerExecutionId, reviewId: priorDelivery.reviewId, repairAuthority: "ci_failure", cycle, repairCycleLimit: validatedInput.repairCycleLimit, worktreePath: priorDelivery.worktreePath, branchName: priorDelivery.branchName, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, blockingFindings: repairFindings, repairPlanArtifactId: repairPlan.planArtifactId, repairPlanSha256: repairPlan.planSha256 });
    const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required" : "Member decision required", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: state.worktreePath, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan.planArtifactId, deliveryRepairPlanSha256: repairPlan.planSha256, deliveryRepairAuthority: result.outcome === "completed" ? null : "ci_failure", releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) { const command = StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision"); if (state.phase !== "ci_repair_required" || !state.developerExecutionId) throw new Error("CI repair is not available in the current phase"); } });
  setHandler(finalReviewUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || (state.phase !== "final_review" && !(state.phase === "delivery_blocked" && state.finalReviewFailureCode === "final_review_unavailable"))) throw new Error("Final review is not available in the current phase");
    return runFinalReviewTurn();
  });
  const accept = async (rawInput: PlanCommandInput, decision: "accept" | "request_changes"): Promise<IssueWorkflowState> => {
    const command = PlanCommandInputSchema.parse(rawInput);
    const exactAcceptanceReceipts = patched(exactAcceptanceReceiptPatch);
    const requestChangesFromBlockingReview = decision === "request_changes" && state.phase === "repair_required" && state.finalReviewOutcome === "blocking";
    const preIntentProviderRetry = decision === "accept" && state.phase === "delivery_blocked" && (state.acceptanceId ?? null) === null && state.acceptanceBlockerCode === "provider_unavailable" && state.allowedCommands.includes("accept_delivery");
    if (command.expectedRevision !== state.revision || (decision === "accept" ? state.phase !== "accepted" && !preIntentProviderRetry : state.phase !== "accepted" && !requestChangesFromBlockingReview)) throw new Error("Delivery acceptance is not available in the current phase");
    if (!state.releaseId || !state.finalReviewId || !state.ciRunId || !state.expectedHeadSha || !state.expectedHeadTree) throw new Error("Exact final review, CI, release, and pinned GitHub evidence is required for acceptance");
    if (exactAcceptanceReceipts && (!state.deliveryReviewId || !state.pullRequestNumber || !state.releaseRepository || !state.baseBranch || !state.targetBaseSha || !state.leadSessionRef)) throw new Error("Exact final review, CI, release, and pinned GitHub evidence is required for acceptance");
    if (!(await runTargetBaseCheckpoint("pre_acceptance"))) return state;
    const result = exactAcceptanceReceipts
      ? await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId!, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, pullRequestNumber: state.pullRequestNumber!, repository: state.releaseRepository!, baseBranch: state.baseBranch!, baseSha: state.targetBaseSha!, leadSessionRef: state.leadSessionRef!, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision, ...(command.note !== undefined ? { note: command.note } : {}) })
      : await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, releaseId: state.releaseId, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision } as unknown as AcceptDeliveryActivityInput);
    if (!exactAcceptanceReceipts) {
      const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "requested_changes" ? "repair_required" : "cancelled";
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "repair_required" ? "Lead repair plan required" : "Issue cancelled", acceptanceId: result.acceptanceId, acceptedHeadSha: result.status === "accepted" ? state.expectedHeadSha : null, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    let memberRepairPlan: { planArtifactId: string; planSha256: string; findings: typeof state.deliveryBlockingFindings } | undefined;
    if (decision === "request_changes" && result.status === "requested_changes") {
      const note = command.note?.trim() || "Member requested changes to the exact delivery";
      const finding = { findingId: `member_requested_changes_${state.revision}`, severity: "blocking" as const, rationale: note, evidenceRef: result.reasonArtifactId ?? "member acceptance decision", disposition: "open" as const, repairInstruction: note };
      try {
        const planned = await planDeliveryRepair({
          taskId: validatedInput.issueId,
          companyId: validatedInput.companyId,
          workflowId: validatedInput.workflowId,
          projectId: validatedInput.projectId,
          projectRevisionId: validatedInput.projectRevisionId,
          source: "member_requested_changes",
          leadSessionRef: state.leadSessionRef!,
          planRevision: state.planRevision ?? state.revision,
          releaseId: state.releaseId,
          deliveryReviewId: state.deliveryReviewId,
          finalReviewId: state.finalReviewId,
          ciRunId: state.ciRunId,
          acceptanceId: result.acceptanceId,
          reasonArtifactId: result.reasonArtifactId ?? null,
          evidenceArtifactIds: [state.finalReviewEvidenceArtifactId, state.finalReviewOpinionArtifactId, ...(result.reasonArtifactId ? [result.reasonArtifactId] : [])].filter((id): id is string => Boolean(id)),
          branchName: state.branchName ?? "delivery",
          worktreePath: state.worktreePath ?? ".",
          targetBaseSha: state.targetBaseSha!,
          subjectCommit: state.expectedHeadSha,
          subjectTree: state.expectedHeadTree,
          findings: [finding],
        });
        memberRepairPlan = planned;
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Member-requested repair planning failed; inspect the recorded evidence", acceptanceId: result.acceptanceId, acceptanceStatus: result.status, acceptanceReasonArtifactId: result.reasonArtifactId ?? null, acceptanceBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
    }
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "pending_ready" ? "ready_reconciliation" : result.status === "requested_changes" ? "repair_required" : result.status === "blocked" ? "delivery_blocked" : "cancelled";
    const preIntentProviderFailure = result.status === "blocked" && result.acceptanceId === null && result.outcome === "provider_unavailable";
    const clearReviewAuthority = decision === "request_changes" && result.status === "requested_changes" && memberRepairPlan ? { releaseId: null, releaseRepository: null, baseBranch: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciAttempt: 0, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, finalReviewSummary: null, finalReviewOpinionArtifactId: null, finalReviewEvidenceArtifactId: null, finalReviewFailureCode: null, finalReviewFindings: [], finalReviewRepairPlanArtifactId: null, finalReviewRepairPlanSha256: null, acceptanceId: null, acceptanceStatus: null, acceptanceAttempt: 0, acceptanceRetryAt: null, acceptanceBlockerCode: null, acceptanceBlockerEvidenceArtifactId: null, acceptanceReasonArtifactId: null, acceptedAt: null, readyAt: null, acceptedHeadSha: null, mergeAttempt: 0, mergeRetryAt: null, mergeObservationId: null, mergeBlockerCode: null, mergeBlockerEvidenceArtifactId: null, completionReceiptId: null, mergeOutcome: null, deliveryRepairAuthority: "member_requested_changes" as const } : {};
    state = IssueWorkflowStateSchema.parse({ ...state, ...clearReviewAuthority, revision: state.revision + 1, phase: nextPhase, owner: nextPhase === "repair_required" ? "lead" : "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ready_reconciliation" ? ["reconcile_acceptance", "cancel_issue"] : nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextPhase === "delivery_blocked" ? (preIntentProviderFailure ? ["accept_delivery", "cancel_issue"] : result.acceptanceId ? ["reconcile_merge", "request_delivery_changes", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"]) : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ready_reconciliation" ? "Reconciling ready-for-review" : nextPhase === "repair_required" ? "Lead repair plan required" : nextPhase === "delivery_blocked" ? (preIntentProviderFailure ? "GitHub acceptance evidence unavailable; retry acceptance" : result.blockerSummary ?? "Delivery is blocked") : "Issue cancelled", acceptanceId: clearReviewAuthority.acceptanceId !== undefined ? clearReviewAuthority.acceptanceId : result.acceptanceId, acceptanceStatus: clearReviewAuthority.acceptanceStatus !== undefined ? clearReviewAuthority.acceptanceStatus : result.status, acceptanceAttempt: clearReviewAuthority.acceptanceAttempt !== undefined ? clearReviewAuthority.acceptanceAttempt : (state.acceptanceAttempt ?? 0) + 1, acceptanceRetryAt: clearReviewAuthority.acceptanceRetryAt !== undefined ? clearReviewAuthority.acceptanceRetryAt : result.retryAt ?? null, acceptanceBlockerCode: clearReviewAuthority.acceptanceBlockerCode !== undefined ? clearReviewAuthority.acceptanceBlockerCode : result.blockerCode ?? null, acceptanceBlockerEvidenceArtifactId: clearReviewAuthority.acceptanceBlockerEvidenceArtifactId !== undefined ? clearReviewAuthority.acceptanceBlockerEvidenceArtifactId : result.evidenceArtifactId ?? null, acceptanceReasonArtifactId: clearReviewAuthority.acceptanceReasonArtifactId !== undefined ? clearReviewAuthority.acceptanceReasonArtifactId : result.reasonArtifactId ?? state.acceptanceReasonArtifactId ?? null, acceptedAt: clearReviewAuthority.acceptedAt !== undefined ? clearReviewAuthority.acceptedAt : (decision === "accept" && exactAcceptanceReceipts ? result.acceptedAt ?? null : null), readyAt: clearReviewAuthority.readyAt !== undefined ? clearReviewAuthority.readyAt : result.readyAt ?? null, acceptedHeadSha: clearReviewAuthority.acceptedHeadSha !== undefined ? clearReviewAuthority.acceptedHeadSha : (decision === "accept" ? state.expectedHeadSha : null), pullRequestNumber: clearReviewAuthority.pullRequestNumber !== undefined ? clearReviewAuthority.pullRequestNumber : result.pullRequestNumber ?? state.pullRequestNumber, pullRequestUrl: clearReviewAuthority.pullRequestUrl !== undefined ? clearReviewAuthority.pullRequestUrl : result.pullRequestUrl ?? state.pullRequestUrl, deliveryBlockingFindings: memberRepairPlan?.findings ?? state.deliveryBlockingFindings, deliveryRepairPlan: memberRepairPlan ? null : state.deliveryRepairPlan, deliveryRepairPlanArtifactId: memberRepairPlan?.planArtifactId ?? state.deliveryRepairPlanArtifactId, deliveryRepairPlanSha256: memberRepairPlan?.planSha256 ?? state.deliveryRepairPlanSha256, deliveryRepairAuthority: memberRepairPlan ? "member_requested_changes" : state.deliveryRepairAuthority, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  const reconcileAcceptanceTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.acceptanceId) throw new Error("Acceptance reconciliation requires an acceptance intent");
    if ((state.acceptanceAttempt ?? 0) >= MAX_RECONCILIATION_ATTEMPTS) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Ready reconciliation retry limit exhausted", acceptanceBlockerCode: "acceptance_reconciliation_exhausted", acceptanceRetryAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    const result = await reconcileAcceptance({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, acceptanceId: state.acceptanceId });
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "blocked" ? "delivery_blocked" : "ready_reconciliation";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ready_reconciliation" ? ["reconcile_acceptance", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ready_reconciliation" ? "Waiting for ready-for-review" : (result.blockerSummary ?? "Ready reconciliation is blocked"), acceptanceStatus: result.status, acceptanceAttempt: (state.acceptanceAttempt ?? 0) + 1, acceptanceRetryAt: result.retryAt, acceptanceBlockerCode: result.blockerCode ?? null, acceptanceBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, acceptedAt: result.acceptedAt, readyAt: result.readyAt, pullRequestNumber: result.pullRequestNumber || state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || state.pullRequestUrl, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  setHandler(acceptDeliveryUpdate, (rawInput) => accept(rawInput, "accept"));
  setHandler(requestDeliveryChangesUpdate, (rawInput) => accept(rawInput, "request_changes"));
  setHandler(reconcileAcceptanceUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "ready_reconciliation" || !state.acceptanceId) throw new Error("Acceptance reconciliation is not available in the current phase");
    return reconcileAcceptanceTurn();
  });
  setHandler(reconcileMergeUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "manual_merge") throw new Error("Merge reconciliation is not available in the current phase");
    return reconcileMergeTurn();
  });
  setHandler(cancelIssueUpdate, async (rawInput) => {
    if (captureInitialProjectionState) await condition(() => initialProjectionComplete);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || ["done", "cancelled"].includes(state.phase)) throw new Error("Issue cancellation is not available in the current phase");
    if (state.phase === "development" && state.developerExecutionId) await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId: state.developerExecutionId });
    let acceptanceStatus = state.acceptanceStatus;
    let acceptanceReasonArtifactId = state.acceptanceReasonArtifactId;
    if (state.acceptanceId && state.releaseId && state.deliveryReviewId && state.finalReviewId && state.ciRunId && state.pullRequestNumber && state.releaseRepository && state.baseBranch && state.targetBaseSha && state.expectedHeadSha && state.expectedHeadTree && state.leadSessionRef) {
      const result = await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, pullRequestNumber: state.pullRequestNumber, repository: state.releaseRepository, baseBranch: state.baseBranch, baseSha: state.targetBaseSha, leadSessionRef: state.leadSessionRef, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision: "cancel", ...(command.note !== undefined ? { note: command.note } : {}) });
      acceptanceStatus = result.status;
      acceptanceReasonArtifactId = result.reasonArtifactId ?? acceptanceReasonArtifactId;
    } else if (command.note?.trim()) {
      const decision = await recordDeliveryDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, actorUserId: command.actorUserId, note: command.note });
      state = IssueWorkflowStateSchema.parse({ ...state, deliveryDecisionArtifactId: decision.artifactId });
    }
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Issue cancelled", acceptanceStatus, acceptanceReasonArtifactId, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  });
  setHandler(cancelDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("cancel development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    if (!state.developerExecutionId) {
      await withStateMutation(() => {
        if (state.revision !== command.expectedRevision || state.phase !== "development") throw new Error("Developer cancellation was superseded by another command");
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null });
        markCommandProcessed(command.commandId);
        if (shouldContinueAsNew(state.revision)) continuationRequested = true;
      });
      await projectIssueState(state);
      return state;
    }
    const executionId = state.developerExecutionId;
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || state.phase !== "development") throw new Error("Developer cancellation was superseded by another command");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: [], pendingAction: "Cancelling Developer turn", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null });
      markCommandProcessed(command.commandId);
    });
    await projectIssueState(state);
    const result = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId });
    await withStateMutation(() => {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: result.status === "cancelled" ? ["retry_development"] : [], pendingAction: result.status === "cancelled" ? "Developer turn cancelled; retry or continue" : "Operator must verify Developer ownership", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerOutcome: null, activeOperation: null });
      if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    });
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "development") throw new Error("Developer cancellation is not available in the current phase");
  } });
  setHandler(rejectPlanUpdate, async (rawInput) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (state.phase === "development") {
      const cancellation = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId: state.developerExecutionId! });
      if (cancellation.status !== "cancelled") throw new Error("Developer ownership must be precisely cancelled before plan revision");
    }
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${state.workflowId}:${state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null });
    const decision = await recordPlanDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision: state.revision - 1, actorUserId: command.actorUserId, decision: "reject", note: `${command.note ?? "Member requested an explicit plan revision"}; worktree=${command.worktreeDecision ?? "new"}; exactBase=${command.exactBaseSha ?? "recorded-current-base"}` });
    state = IssueWorkflowStateSchema.parse({ ...state, decisionId: decision.decisionId, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_blocked", "delivery_ready", "delivery_reviewed", "repair_required"].includes(state.phase)) throw new Error("Plan revision is not available in the current phase");
    if (!state.planMaterial) throw new Error("Routine plans do not require revision");
    if (state.phase === "development" && !state.developerExecutionId) throw new Error("Active Developer execution is unavailable for cancellation");
  } });
  setHandler(recordProgressUpdate, async (rawInput) => {
    assertPayloadWithinLimit("recordProgress command", rawInput);
    const command = RecordProgressInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      allowedCommands: continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      continuationCount: state.continuationCount,
      lastSummaryHash: command.summaryHash,
    });
    state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    if (shouldContinueAsNew(next.revision)) continuationRequested = true;
    await projectIssueState(next);
    return next;
  }, {
    validator(rawInput) {
      const command = RecordProgressInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "planning") throw new Error("Progress can only be recorded during Planning");
    },
  });
  assertPayloadWithinLimit("Issue Workflow result", state);
  // Continue-As-New carries the last business revision into a fresh run. The
  // previous run already projected that revision, so emitting it again with a
  // different continuationCount would correctly look like conflicting
  // authoritative history to the projection boundary.
  if (!continuation) await projectIssueState(captureInitialProjectionState ? initialProjectionState : state);
  initialProjectionComplete = true;
  while (true) {
    if (state.phase === "cancelled" || state.phase === "done") return state;
    if (state.phase === "releasing" && state.releaseRetryAt) {
      const delay = Math.max(0, Date.parse(state.releaseRetryAt) - Date.now());
      if (delay > 0) await sleep(delay);
      if (state.phase === "releasing") await runPublishTurn();
      continue;
    }
    if (state.phase === "ci_waiting") {
      const sleepingRevision = state.revision;
      const sleepingReleaseId = state.releaseId;
      const sleepingHeadSha = state.expectedHeadSha;
      const pollAt = state.ciNextPollAt ? Date.parse(state.ciNextPollAt) : Date.now();
      const delay = Math.max(0, pollAt - Date.now());
      if (delay > 0) await sleep(delay);
      if (state.phase !== "ci_waiting" || state.revision !== sleepingRevision || state.releaseId !== sleepingReleaseId || state.expectedHeadSha !== sleepingHeadSha) continue;
      await reconcileCiTurn();
      continue;
    }
    if (state.phase === "ready_reconciliation") {
      await sleepUntil(state.acceptanceRetryAt);
      if (state.phase === "ready_reconciliation") await reconcileAcceptanceTurn();
      continue;
    }
    if (state.phase === "manual_merge") {
      await sleepUntil(state.mergeRetryAt);
      if (state.phase === "manual_merge") await reconcileMergeTurn();
      continue;
    }
    await condition(() => (continuationRequested && allHandlersFinished()) || (state.phase === "releasing" && Boolean(state.releaseRetryAt)) || state.phase === "ci_waiting" || state.phase === "ready_reconciliation" || state.phase === "manual_merge");
    if (continuationRequested && allHandlersFinished()) {
      if (stateMutationLocked || state.activeOperation !== null) continue;
      const compact = compactStateForContinuation(state);
      assertContinuationStateWithinLimit(compact);
      await continueAsNew<typeof issueWorkflow>({ ...validatedInput, continuationState: compact, continueAsNewAfter: continueAfter });
    }
  }
}
