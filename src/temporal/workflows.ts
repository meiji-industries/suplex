import { ActivityFailure, allHandlersFinished, ApplicationFailure, condition, continueAsNew, defineQuery, defineUpdate, patched, proxyActivities, setHandler, sleep, workflowInfo } from "@temporalio/workflow";

import { ProbeWorkflowInputSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { createInitialIssueWorkflowState, IssueWorkflowInputSchema, IssueWorkflowStateSchema, PlanCommandInputSchema, RecordProgressInputSchema, StartPlanningInputSchema, type IssueActivities, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type RecordProgressInput, type StartPlanningInput } from "./issue-contracts.js";
import { assertContinuationStateWithinLimit, assertPayloadWithinLimit, WORKFLOW_HISTORY_EVENT_LIMIT } from "./policy.js";

const { recordProbeStarted } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
});

const { projectIssueState } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});
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
const { acceptDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});
const { reconcileMerge } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

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
export const reconcileCIUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileCI");
export const repairCIUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("repairCI");
export const finalReviewUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("finalReview");
export const acceptDeliveryUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("acceptDelivery");
export const requestDeliveryChangesUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("requestDeliveryChanges");
export const cancelIssueUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("cancelIssue");
export const reconcileMergeUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileMerge");
const leadPlanningPatch = "forge-lead-planning-v1";
const planGovernancePatch = "forge-plan-governance-v1";
const planningProjectionIntegrityPatch = "forge-planning-projection-integrity-v1";
const distinctPlanningStatesPatch = "forge-distinct-planning-states-v1";
const artifactBackedConflictPatch = "forge-artifact-backed-conflict-evidence-v1";
const artifactBackedReviewPatch = "forge-artifact-backed-review-evidence-v1";

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
    ...createInitialIssueWorkflowState(validatedInput),
    activeOperation: null,
    processedCommandIds: [],
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  let continuationRequested = false;
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
  setHandler(issueStateQuery, () => state);
  setHandler(startPlanningUpdate, async (rawInput) => {
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
    const result = await runDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, executionId });
    const applied = await withStateMutation(() => {
      if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Resolve Developer blocker", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, activeOperation: null });
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
    const canRepair = result.outcome === "blocking" && (!legacyReview || (legacyResult.repairPlan !== null && openBlocking.length > 0)) && (state.repairCycle ?? 0) < validatedInput.repairCycleLimit;
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
      ...(!legacyReview ? { deliveryReviewArtifact: legacyResult.reviewArtifact } : { deliveryBlockingFindings: openBlocking, deliveryRepairPlan: legacyResult.repairPlan }),
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
      ...(state.deliveryReviewArtifact ? { reviewArtifact: state.deliveryReviewArtifact } : { blockingFindings: state.deliveryBlockingFindings ?? [], repairPlan: state.deliveryRepairPlan! }),
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
      ...(result.outcome === "completed" ? { deliveryBlockingFindings: [], deliveryRepairPlan: null } : {}),
    });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "repair_required") throw new Error("Delivery repair is not available in the current phase");
    if (!state.deliveryReviewId || (!state.deliveryReviewArtifact && (!state.deliveryRepairPlan || !(state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open")))) throw new Error("Open blocking findings and a bounded repair plan are required");
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
    if (!state.releaseId || !state.ciRunId || !state.leadSessionRef || !state.leadOutputArtifactId || !state.developerExecutionId || !state.deliveryArtifactId || !state.developerEvidenceArtifactId || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("Exact release, CI, Lead, and Developer evidence is required for final review");
    let result;
    try {
      result = await finalReview({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, roleProfiles: validatedInput.roleProfiles, releaseId: state.releaseId, ciRunId: state.ciRunId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef, leadOutputArtifactId: state.leadOutputArtifactId, developerExecutionId: state.developerExecutionId, deliveryArtifactId: state.deliveryArtifactId, evidenceArtifactId: state.developerEvidenceArtifactId, branchName: state.branchName, targetBaseSha: state.targetBaseSha, subjectCommit: state.resultCommit, subjectTree: state.resultTree });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_required", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Final review could not be completed", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    const nextPhase = result.outcome === "approved" ? "accepted" : "ci_repair_required";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: result.outcome === "approved" ? "human" : "lead", allowedCommands: result.outcome === "approved" ? ["accept_delivery", "request_delivery_changes", "cancel_issue"] : ["repair_ci", "request_delivery_changes", "cancel_issue"], pendingAction: result.outcome === "approved" ? "Member acceptance required" : "Final review changes required", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, lastEventId: `${state.workflowId}:${state.revision + 1}` });
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
    if (!state.releaseId || !state.expectedHeadSha) throw new Error("Exact release head is required for merge reconciliation");
    let result;
    try {
      result = await reconcileMerge({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, releaseId: state.releaseId, expectedHeadSha: state.expectedHeadSha });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "manual_merge", owner: "human", allowedCommands: ["reconcile_merge", "cancel_issue"], pendingAction: "GitHub merge state is temporarily unavailable", mergeOutcome: "provider_unavailable", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    const nextPhase = result.outcome === "merged" ? "done" : result.outcome === "open" ? "manual_merge" : "delivery_blocked";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: nextPhase === "manual_merge" ? "human" : "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "done" ? "Merged pull request confirmed" : "Pull request changed or closed without merge", mergeOutcome: result.outcome, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  setHandler(publishDraftUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "releasing", owner: "lead", allowedCommands: [], pendingAction: "Publishing one exact draft pull request", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    if (!state.deliveryReviewId || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("Approved exact delivery is required before publishing");
    let result;
    try {
      result = await publishRelease({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, reviewId: state.deliveryReviewId, developerExecutionId: state.developerExecutionId!, branchName: state.branchName, targetBaseSha: state.targetBaseSha, subjectCommit: state.resultCommit, subjectTree: state.resultTree, planSummary: state.leadSummary ?? "Approved Forge plan", deliverySummary: state.deliverySummary ?? "Exact Developer delivery", verificationSummary: "Lead delivery review approved", ...(state.pullRequestNumber ? { expectedPullRequestNumber: state.pullRequestNumber } : {}) });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Release provider reconciliation requires attention", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (result.baseDriftConflict) {
      const legacyConflict = !patched(artifactBackedConflictPatch);
      if (!legacyConflict && !result.mergeConflictEvidence) throw ApplicationFailure.nonRetryable("Merge-conflict evidence is missing", "merge_conflict_evidence_missing");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: [], pendingAction: "Lead conflict-resolution plan", targetBaseSha: result.targetBaseSha ?? state.targetBaseSha, forwardMergeId: result.forwardMergeId ?? null, forwardMergePriorHead: result.priorHead ?? state.resultCommit, forwardMergeTargetBaseSha: result.targetBaseSha ?? state.targetBaseSha, ...(result.mergeConflictEvidence ? { mergeConflictEvidence: result.mergeConflictEvidence } : {}), ...(legacyConflict ? { forwardMergeConflictFiles: result.conflictFiles ?? [], forwardMergeConflictDiff: result.conflictDiff ?? null } : {}), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await planMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, branchName: state.branchName!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, ...(state.mergeConflictEvidence ? { conflictEvidence: state.mergeConflictEvidence } : { conflictFiles: state.forwardMergeConflictFiles ?? [], conflictDiff: state.forwardMergeConflictDiff ?? "" }), ...(state.forwardMergeId ? { forwardMergeId: state.forwardMergeId } : {}) });
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Lead conflict-resolution planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      if (legacyConflict) continuationRequested = true;
      await projectIssueState(state);
      void command;
      return state;
    }
    if (result.baseDriftMerged) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery"], pendingAction: "Fresh Lead review required after target-base forward merge", targetBaseSha: result.targetBaseSha ?? state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Waiting for required CI", releaseId: result.releaseId, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, ciAttempt: 0, ciOutcome: "waiting", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) { const command = StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision"); if (state.phase !== "delivery_reviewed" || !state.deliveryReviewId) throw new Error("Draft publication is only available after an approved delivery review"); } });
  setHandler(resolveMergeConflictUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "merge_conflict_required") throw new Error("Merge-conflict resolution is not available in the current phase");
    if (!state.mergeResolutionPlanArtifactId || !state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.forwardMergePriorHead || !state.forwardMergeTargetBaseSha) throw new Error("A Lead conflict plan and owned Developer execution are required");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_resolving", owner: "lead", allowedCommands: [], pendingAction: "Developer resolving forward-merge conflicts", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    try {
      const result = await resolveMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision: state.planRevision ?? state.revision, developerExecutionId: state.developerExecutionId!, developerSessionRef: state.developerSessionRef!, branchName: state.branchName!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, planArtifactId: state.mergeResolutionPlanArtifactId! });
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead delivery review required after conflict resolution", targetBaseSha: state.forwardMergeTargetBaseSha, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.summary, developerOutcome: "completed", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, mergeResolutionDeveloperExecutionId: result.developerExecutionId, mergeResolutionDeveloperSessionRef: result.developerSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
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
    const priorDelivery = { leadSessionRef: state.leadSessionRef, developerSessionRef: state.developerSessionRef, developerExecutionId: state.developerExecutionId, reviewId: state.deliveryReviewId, branchName: state.branchName, targetBaseSha: state.targetBaseSha, subjectCommit: state.resultCommit, subjectTree: state.resultTree, ciOutcome: state.ciOutcome };
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer CI repair cycle ${cycle}`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    const result = await runDeveloperRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: priorDelivery.leadSessionRef, developerSessionRef: priorDelivery.developerSessionRef, developerExecutionId: priorDelivery.developerExecutionId, reviewId: priorDelivery.reviewId, cycle, repairCycleLimit: validatedInput.repairCycleLimit, branchName: priorDelivery.branchName, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, ...(state.deliveryReviewArtifact ? { reviewArtifact: state.deliveryReviewArtifact } : { blockingFindings: state.deliveryBlockingFindings ?? [], repairPlan: `Repair the exact-head verification outcome ${priorDelivery.ciOutcome ?? "failed"}; preserve the branch and create a new normal commit.` }) });
    const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required" : "Member decision required", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, activeOperation: null, deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) { const command = StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision"); if (state.phase !== "ci_repair_required" || !state.developerExecutionId) throw new Error("CI repair is not available in the current phase"); } });
  setHandler(finalReviewUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "final_review") throw new Error("Final review is not available in the current phase");
    return runFinalReviewTurn();
  });
  const accept = async (rawInput: PlanCommandInput, decision: "accept" | "request_changes"): Promise<IssueWorkflowState> => {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || (decision === "accept" ? state.phase !== "accepted" : !["accepted", "ci_repair_required"].includes(state.phase))) throw new Error("Delivery acceptance is not available in the current phase");
    if (decision === "request_changes" && state.phase === "ci_repair_required" && !state.finalReviewId) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["record_delivery_decision", "cancel_issue"], pendingAction: "Member requested delivery changes", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (!state.releaseId || !state.finalReviewId || !state.ciRunId || !state.expectedHeadSha || !state.expectedHeadTree) throw new Error("Exact final review, CI, and release evidence is required for acceptance");
    const result = await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, releaseId: state.releaseId, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision });
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "requested_changes" ? "ci_repair_required" : "cancelled";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ci_repair_required" ? ["request_delivery_changes", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ci_repair_required" ? "Delivery changes requested" : "Issue cancelled", acceptanceId: result.acceptanceId, acceptedHeadSha: result.status === "accepted" ? state.expectedHeadSha : null, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  setHandler(acceptDeliveryUpdate, (rawInput) => accept(rawInput, "accept"));
  setHandler(requestDeliveryChangesUpdate, (rawInput) => accept(rawInput, "request_changes"));
  setHandler(reconcileMergeUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "manual_merge") throw new Error("Merge reconciliation is not available in the current phase");
    return reconcileMergeTurn();
  });
  setHandler(cancelIssueUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || ["done", "cancelled"].includes(state.phase)) throw new Error("Issue cancellation is not available in the current phase");
    if (state.phase === "development" && state.developerExecutionId) await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId: state.developerExecutionId });
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "cancelled", owner: "human", allowedCommands: [], pendingAction: "Issue cancelled", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  });
  setHandler(cancelDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("cancel development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    const executionId = state.developerExecutionId!;
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
    if (state.phase !== "development" || !state.developerExecutionId) throw new Error("Developer cancellation is not available in the current phase");
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
  if (!continuation) await projectIssueState(state);
  while (true) {
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
    if (state.phase === "manual_merge") {
      await sleep("30 seconds");
      await reconcileMergeTurn();
      continue;
    }
    await condition(() => (continuationRequested && allHandlersFinished()) || state.phase === "ci_waiting" || state.phase === "manual_merge");
    if (continuationRequested && allHandlersFinished()) {
      if (stateMutationLocked || state.activeOperation !== null) continue;
      const compact = compactStateForContinuation(state);
      assertContinuationStateWithinLimit(compact);
      await continueAsNew<typeof issueWorkflow>({ ...validatedInput, continuationState: compact, continueAsNewAfter: continueAfter });
    }
  }
}
