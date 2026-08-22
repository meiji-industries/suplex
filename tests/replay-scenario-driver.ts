import type { WorkflowClient, WorkflowHandle } from "@temporalio/client";
import type { NativeConnection } from "@temporalio/worker";
import { Worker } from "@temporalio/worker";

import type { CapacityRequestSnapshot, WorkflowCapacityState } from "../src/capacity-contracts.js";
import type { IssueActivities } from "../src/temporal/contracts/activities/index.js";
import type { DurableArtifactReference, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { acceptDeliveryUpdate, approvePlanUpdate, cancelDevelopmentUpdate, cancelIssueUpdate, continueWorkUpdate, issueStateQuery, issueWorkflow, reconcileAcceptanceUpdate, reconcileMergeUpdate, requestDeliveryChangesUpdate, revisePlanUpdate, retryDevelopmentUpdate, startDevelopmentUpdate, startPlanningUpdate } from "../src/temporal/workflows.js";
import { buildProductionWorkflowBundle, temporalDataConverter } from "../src/temporal/workflow-bundle.js";
import { createIssueActivitiesFake } from "./fakes/issue-activities.js";
import { replayScenarios } from "./replay-scenarios/index.js";

export { replayScenarios };

export type ReplayScenario =
  | "normal_success"
  | "implementation_repair"
  | "active_cancellation"
  | "blocked_authentication_resume"
  | "continue_as_new"
  | "release_base_drift_merged"
  | "release_base_drift_conflict"
  | "ci_wait_retry"
  | "acceptance_ready_timeout"
  | "acceptance_requested_changes"
  | "acceptance_provider_outage"
  | "manual_merge_open"
  | "manual_merge_closed"
  | "manual_merge_changed"
  | "final_review_failure"
  | "plan_revision"
  | "successor_creation"
  | "developer_active_worker_loss"
  | "developer_cancellation"
  | "developer_linked_retry"
  | "developer_ownership_ambiguous"
  | "developer_result_claim"
  | "developer_reconciliation_recovery"
  | "developer_blocked_cancellation";

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value?: T): void;
}

export interface ReplayScenarioActivityContext {
  scenario: ReplayScenario;
  projections: Map<string, IssueWorkflowState[]>;
  developerGate: Deferred;
  planningAttempts: Map<string, number>;
  reviewAttempts: Map<string, number>;
  ciAttempts: Map<string, number>;
  developmentAttempts: Map<string, number>;
  scenarioByExecutionId: Map<string, ReplayScenario>;
  capacityRequests: Map<string, CapacityRequestSnapshot>;
  capacityState(request: CapacityRequestSnapshot): WorkflowCapacityState;
}

export interface ReplayScenarioScriptOptions {
  planningRetry?: boolean;
  continueAsNew?: boolean;
  cancellation?: "development" | "successor";
  planRevision?: boolean;
  developerRetry?: boolean;
  skipReview?: boolean;
  repair?: boolean;
  acceptance?: "accept" | "request-changes" | "ready-timeout" | "provider-outage";
  merge?: boolean;
  ciWait?: boolean;
  finalReviewFailure?: boolean;
}

export interface ReplayScenarioScriptHelpers {
  scenario: ReplayScenario;
  workflowId: string;
  projections: IssueWorkflowState[];
  developerGate: Deferred;
  command: typeof command;
  waitForState: typeof waitForState;
  drive(handle: WorkflowHandle<typeof issueWorkflow>, options: ReplayScenarioScriptOptions): Promise<IssueWorkflowState>;
}

export interface ReplayScenarioDefinition<Name extends string = string> {
  name: Name;
  captureId: string;
  workflowInput?: Pick<IssueWorkflowInput, "continueAsNewAfter">;
  activityOverrides?: Partial<IssueActivities> | ((context: ReplayScenarioActivityContext, shared: Partial<IssueActivities>) => Partial<IssueActivities>);
  script(handle: WorkflowHandle<typeof issueWorkflow>, helpers: ReplayScenarioScriptHelpers): Promise<IssueWorkflowState>;
}

export interface ScenarioExecution {
  scenario: ReplayScenario;
  workflowId: string;
  firstRunId: string;
  currentPhase: IssueWorkflowState["phase"];
  finalState: IssueWorkflowState;
  projections: IssueWorkflowState[];
}

type ReplayScenarioScriptBaseHelpers = Omit<ReplayScenarioScriptHelpers, "drive">;
type ReplayScenarioDefinitionUnion = typeof replayScenarios[number];

function artifact(kind: DurableArtifactReference["kind"], id: string): DurableArtifactReference {
  return { artifactId: id, companyId: "fixture-company", kind, byteSize: 1, mimeType: "application/json" };
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value) => resolve(value as T) };
}

const HUMAN_OWNED_PHASES = new Set<IssueWorkflowState["phase"]>(["accepted", "merge_conflict_required", "delivery_blocked", "manual_merge", "ready_reconciliation", "done", "cancelled", "failed", "blocked"]);

function command(expectedRevision: number, id: string) {
  return { expectedRevision, actorUserId: "fixture-user", commandId: id };
}

async function waitForState(handle: WorkflowHandle<typeof issueWorkflow>, predicate: (state: IssueWorkflowState) => boolean): Promise<IssueWorkflowState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await handle.query(issueStateQuery);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${handle.workflowId}`);
}

function createSharedActivities(context: ReplayScenarioActivityContext): Partial<IssueActivities> {
  const { scenario } = context;
  return {
    async projectIssueState(event) {
      context.projections.get(event.state.workflowId)?.push(structuredClone(event.state));
      return event.state;
    },
    async reconcileTargetBase(activityInput) {
      return { outcome: "no_drift", checkId: `target-base-${activityInput.taskId}`, checkpoint: activityInput.checkpoint, expectedBaseSha: activityInput.expectedBaseSha, observedBaseSha: activityInput.expectedBaseSha, headSha: activityInput.expectedHeadSha, headTree: activityInput.expectedHeadTree };
    },
    async runLeadPlanning(activityInput) {
      const attempt = (context.planningAttempts.get(activityInput.workflowId) ?? 0) + 1;
      context.planningAttempts.set(activityInput.workflowId, attempt);
      return { leadSessionRef: `lead-session-${scenario}`, leadExecutionId: `lead-execution-${scenario}-${attempt}`, leadEvidenceArtifactId: `lead-evidence-${scenario}`, leadOutputArtifactId: `lead-plan-${scenario}`, leadOutputKind: "plan", leadSummary: "Controlled fixture plan", materialCategories: ["security_permissions"], material: true };
    },
    async planDeliveryRepair(activityInput) { return { planId: `repair-plan-${activityInput.workflowId}`, leadExecutionId: `repair-plan-execution-${activityInput.workflowId}`, planArtifactId: `repair-plan-artifact-${activityInput.workflowId}`, planSha256: "a".repeat(64), evidenceArtifactId: `repair-plan-evidence-${activityInput.workflowId}`, leadSessionRef: activityInput.leadSessionRef, summary: "Controlled repair plan", findings: activityInput.findings }; },
    async recordPlanDecision(activityInput) { return { decisionId: `decision-${activityInput.workflowId}-${activityInput.planRevision}` }; },
    async recordDecisionBlockerResolution(activityInput) { return { resolutionId: `decision-resolution-${activityInput.workflowId}` }; },
    async runDeveloperExecution(activityInput) {
      return { developerExecutionId: activityInput.executionId!, developerSessionRef: `developer-session-${scenario}`, branchName: `forge/issue/${scenario}`, targetBaseSha: "b".repeat(40), currentStep: 1, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean", deliveryArtifactId: `delivery-${scenario}`, evidenceArtifactId: `developer-evidence-${scenario}`, deliverySummary: "Controlled fixture delivery", outcome: "completed" };
    },
    async runDeveloperExecutionSupervised(activityInput) {
      context.scenarioByExecutionId.set(activityInput.developerTurnExecutionId, scenario);
      const attempt = (context.developmentAttempts.get(activityInput.workflowId) ?? 0) + 1;
      context.developmentAttempts.set(activityInput.workflowId, attempt);
      const result = { developerExecutionId: activityInput.developerTurnExecutionId, developerSessionRef: `developer-session-${scenario}`, branchName: `forge/issue/${scenario}`, targetBaseSha: "b".repeat(40), currentStep: 1, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: `delivery-${scenario}`, evidenceArtifactId: `developer-evidence-${scenario}`, deliverySummary: "Controlled fixture delivery", outcome: "completed" as const };
      return { status: "completed" as const, result, resultHash: "a".repeat(64) };
    },
    async reviewDelivery(activityInput) {
      const attempt = (context.reviewAttempts.get(activityInput.workflowId) ?? 0) + 1;
      context.reviewAttempts.set(activityInput.workflowId, attempt);
      return { outcome: "completed" as const, attemptId: `review-attempt-${scenario}-${attempt}`, correctionAttempts: 0, subject: activityInput.subject, review: { reviewId: `review-${scenario}-${attempt}`, leadExecutionId: `review-execution-${scenario}-${attempt}`, leadSessionRef: `lead-session-${scenario}`, opinionArtifactId: `review-artifact-${scenario}-${attempt}`, evidenceArtifactId: `review-evidence-${scenario}-${attempt}`, reviewArtifact: artifact("delivery-review", `review-artifact-${scenario}-${attempt}`), opinion: "approved" as const, summary: "Controlled review approved", repairPlan: null, findings: [], supersedesReviewId: activityInput.supersedesReviewId ?? null } };
    },
    async runDeveloperRepair(activityInput) { return { outcome: "completed" as const, repairAttemptId: `repair-attempt-${scenario}-${activityInput.cycle}`, cycle: activityInput.cycle, reviewId: activityInput.reviewId, subject: { planRevision: activityInput.planRevision, targetBaseSha: activityInput.targetBaseSha, subjectCommit: activityInput.subjectCommit, subjectTree: activityInput.subjectTree, developerExecutionId: activityInput.developerExecutionId, deliveryArtifactId: `delivery-${scenario}`, developerEvidenceArtifactId: `developer-evidence-${scenario}`, leadSessionRef: activityInput.leadSessionRef, developerSessionRef: activityInput.developerSessionRef }, developerExecutionId: `repair-${activityInput.workflowId}`, developerSessionRef: `developer-session-${scenario}`, branchName: activityInput.branchName, resultCommit: "e".repeat(40), resultTree: "f".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: `repaired-delivery-${activityInput.workflowId}`, evidenceArtifactId: `repaired-evidence-${activityInput.workflowId}`, summary: "Controlled repaired delivery" }; },
    async runDeveloperRepairSupervised(activityInput) {
      const result = { outcome: "completed" as const, repairAttemptId: `repair-attempt-${scenario}-${activityInput.cycle}`, cycle: activityInput.cycle, reviewId: activityInput.reviewId, subject: { planRevision: activityInput.planRevision, targetBaseSha: activityInput.targetBaseSha, subjectCommit: activityInput.subjectCommit, subjectTree: activityInput.subjectTree, developerExecutionId: activityInput.developerExecutionId, deliveryArtifactId: `delivery-${scenario}`, developerEvidenceArtifactId: `developer-evidence-${scenario}`, leadSessionRef: activityInput.leadSessionRef, developerSessionRef: activityInput.developerSessionRef }, developerExecutionId: activityInput.developerTurnExecutionId, developerSessionRef: `developer-session-${scenario}`, branchName: activityInput.branchName, resultCommit: "e".repeat(40), resultTree: "f".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: `repaired-delivery-${activityInput.workflowId}`, evidenceArtifactId: `repaired-evidence-${activityInput.workflowId}`, summary: "Controlled repaired delivery" };
      return { status: "completed" as const, result, resultHash: "b".repeat(64) };
    },
    async recordDeliveryDecision() { return { artifactId: "delivery-decision" }; },
    async findActiveDeveloperExecution() { return null; },
    async preparePlanRevision(input) { return { status: "accepted" as const, revisionRequestId: `revision-${input.workflowId}-${input.requestRevision}`, coordinates: { disposition: "new" as const, revisionRequestId: `revision-${input.workflowId}-${input.requestRevision}`, exactBaseSha: input.exactBaseSha! } }; },
    async authorizePlanRevision() {},
    async createSuccessor(input) { return { successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: "project-revision", creationRevision: input.acceptedRevision }; },
    async cancelDeveloperExecution(activityInput) {
      return { status: "cancelled_confirmed" as const, executionId: activityInput.executionId, exitCode: null, exitSignal: "SIGTERM", evidenceArtifactId: null };
    },
    async publishRelease(activityInput) {
      return { outcome: "completed" as const, releaseId: `release-${scenario}`, repository: "example/forge", branchName: activityInput.branchName, baseBranch: "main", headSha: activityInput.subjectCommit, headTree: activityInput.subjectTree, pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1", isDraft: true as const, reused: false, attempt: 1, targetBaseSha: activityInput.targetBaseSha };
    },
    async reconcileCi(activityInput) {
      const attempt = (context.ciAttempts.get(activityInput.releaseId) ?? 0) + 1;
      context.ciAttempts.set(activityInput.releaseId, attempt);
      return { attemptId: `ci-attempt-${scenario}-${attempt}`, attemptNumber: activityInput.attemptNumber, expectedHeadSha: activityInput.expectedHeadSha, observedHeadSha: activityInput.expectedHeadSha, evidenceArtifactId: `ci-evidence-${scenario}-${attempt}`, policyHash: "f".repeat(64), propagationDeadline: "2099-01-01T00:05:00.000Z", overallDeadline: "2099-01-01T01:00:00.000Z", runId: `ci-${scenario}`, outcome: "passed" as const, reason: "checks_passed", owner: null, repairable: false, summary: "Controlled CI passed", retryAt: null, nextPollAt: null };
    },
    async finalReview() { return { finalReviewId: `final-review-${scenario}`, leadExecutionId: `final-review-execution-${scenario}`, leadSessionRef: `lead-session-${scenario}`, opinionArtifactId: `final-review-artifact-${scenario}`, evidenceArtifactId: `final-review-evidence-${scenario}`, reviewArtifact: artifact("delivery-review", `final-review-artifact-${scenario}`), outcome: "approved" as const, summary: "Controlled final review approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }; },
    async acceptDelivery() { return { acceptanceId: `acceptance-${scenario}`, status: "accepted" as const, acceptedAt: "2026-08-11T00:00:00.000Z", readyAt: "2026-08-11T00:00:00.000Z", pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1" }; },
    async reconcileAcceptance(activityInput) { return { acceptanceId: activityInput.acceptanceId, status: "accepted" as const, outcome: "ready" as const, retryAt: null, readyAt: "2026-08-11T00:00:00.000Z", acceptedAt: "2026-08-11T00:00:00.000Z", pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1" }; },
    async reconcileMerge() { return { outcome: "merged" as const, pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1", mergeObservationId: `merge-observation-${scenario}`, completionReceiptId: "completion-receipt", observedAt: "2026-08-11T00:00:00.000Z", mergedAt: "2026-08-11T00:00:00.000Z", retryAt: null }; },
    async planMergeConflict() { return { planId: "conflict-plan", planArtifactId: "conflict-plan-artifact", evidenceArtifactId: "conflict-plan-evidence", leadExecutionId: "conflict-plan-execution", leadSessionRef: "lead-session", summary: "Controlled conflict plan" }; },
    async requestCapacity(activityInput) {
      const requestedAt = "2026-08-12T00:00:00.000Z";
      const request: CapacityRequestSnapshot = { id: `capacity-${activityInput.logicalTurnKey}`, logicalTurnKey: activityInput.logicalTurnKey, companyId: activityInput.companyId, taskId: activityInput.taskId, workflowId: activityInput.workflowId, projectRevisionId: activityInput.projectRevisionId, workflowRevision: activityInput.workflowRevision, operation: activityInput.operation, role: activityInput.role, profileId: activityInput.profileId, provider: "codex", model: "fixture-model", reasoningLevel: "medium", servicePriority: "standard", laneKey: `codex:${activityInput.profileId}`, requestedCapacity: 2, status: "queued", waitReason: null, skipReason: null, sessionRef: activityInput.sessionRef ?? null, worktreePath: activityInput.worktreePath ?? null, executionKind: null, executionId: null, requestedAt, deadlineAt: "2099-01-01T00:00:00.000Z", acquiredAt: null, heartbeatAt: null, retryAt: null, cancelledAt: null, releasedAt: null, updatedAt: requestedAt, rateLimitAttempts: 0, terminalReason: null };
      context.capacityRequests.set(request.id, request);
      return request;
    },
    async tryAcquireCapacity(activityInput) {
      const request = context.capacityRequests.get(activityInput.requestId)!;
      const active = { ...request, status: "active" as const, acquiredAt: request.requestedAt };
      context.capacityRequests.set(active.id, active);
      return { status: "active" as const, publicState: context.capacityState(active) };
    },
    async inspectCapacity(activityInput) { return context.capacityRequests.get(activityInput.requestId)!; },
    async requeueCapacity(activityInput) { const request = context.capacityRequests.get(activityInput.requestId)!; const queued = { ...request, status: "queued" as const, waitReason: null, retryAt: null }; context.capacityRequests.set(queued.id, queued); return queued; },
    async cancelCapacity(activityInput) { const request = context.capacityRequests.get(activityInput.requestId)!; const cancelled = { ...request, status: "cancelled" as const, cancelledAt: request.updatedAt, releasedAt: request.updatedAt, terminalReason: "cancelled" as const }; context.capacityRequests.set(cancelled.id, cancelled); return cancelled; },
    async finalizeCapacity(activityInput) { const request = context.capacityRequests.get(activityInput.requestId)!; const released = { ...request, status: "released" as const, releasedAt: request.updatedAt, terminalReason: activityInput.terminalReason }; context.capacityRequests.set(released.id, released); return released; },
    async rateLimitCapacity(activityInput) { const request = context.capacityRequests.get(activityInput.requestId)!; const limited = { ...request, status: "rate_limited" as const, retryAt: activityInput.retryAt ?? "2099-01-01T00:00:00.000Z", rateLimitAttempts: request.rateLimitAttempts + 1, terminalReason: "rate_limited" as const }; context.capacityRequests.set(limited.id, limited); return limited; },
    async reconcileCapacityOwnership() { return []; },
    async cancelCapacityExecution(activityInput) { const request = context.capacityRequests.get(activityInput.requestId); if (!request) return { status: "cancelled" as const }; const cancelled = { ...request, status: "cancelled" as const, cancelledAt: request.updatedAt, releasedAt: request.updatedAt, terminalReason: "cancelled" as const }; context.capacityRequests.set(cancelled.id, cancelled); return { status: "cancelled" as const, ...(request.executionId ? { executionId: request.executionId } : {}) }; },
  };
}

async function driveScenarioScript(handle: WorkflowHandle<typeof issueWorkflow>, helpers: ReplayScenarioScriptBaseHelpers, options: ReplayScenarioScriptOptions): Promise<IssueWorkflowState> {
  const { scenario } = helpers;
  let state = await helpers.waitForState(handle, (candidate) => candidate.phase === "backlog");
  state = await handle.executeUpdate(startPlanningUpdate, { args: [helpers.command(state.revision, `${scenario}-plan-1`)], updateId: `${scenario}-plan-1` });
  if (options.planningRetry) state = await handle.executeUpdate(startPlanningUpdate, { args: [helpers.command(state.revision, `${scenario}-plan-2`)], updateId: `${scenario}-plan-2` });
  state = await handle.executeUpdate(approvePlanUpdate, { args: [helpers.command(state.revision, `${scenario}-approve`)], updateId: `${scenario}-approve` });
  if (options.continueAsNew) state = await helpers.waitForState(handle, (candidate) => candidate.continuationCount === 1);
  const development = await handle.startUpdate(startDevelopmentUpdate, { args: [helpers.command(state.revision, `${scenario}-develop`)], updateId: `${scenario}-develop`, waitForStage: "ACCEPTED" });
  if (options.cancellation) {
    state = await helpers.waitForState(handle, (candidate) => candidate.phase === "development");
    const cancelCommand = helpers.command(state.revision, `${scenario}-cancel`);
    const cancelled = await handle.executeUpdate(cancelDevelopmentUpdate, { args: [cancelCommand], updateId: `${scenario}-cancel` });
    helpers.developerGate.resolve();
    await development.result();
    state = cancelled;
    if (options.cancellation === "successor") {
      state = await handle.executeUpdate(cancelIssueUpdate, { args: [helpers.command(state.revision, `${scenario}-cancel-issue`)], updateId: `${scenario}-cancel-issue` });
      state = await handle.executeUpdate(continueWorkUpdate, { args: [{ expectedRevision: state.revision, actorUserId: "fixture-user", reason: "Continue the bounded fixture work." }], updateId: `${scenario}-continue` });
    }
    if (options.continueAsNew) state = await helpers.waitForState(handle, (candidate) => candidate.continuationCount === 2);
    const revisionBeforeRetry = state.revision;
    state = await handle.executeUpdate(cancelDevelopmentUpdate, { args: [cancelCommand], updateId: `${scenario}-cancel-transport-retry` });
    // The duplicate must be a no-op. Lead-owned phases chain themselves, so the Workflow may
    // legitimately have moved on by itself; what must never appear is a second cancellation.
    if (helpers.projections.some((projected) => projected.revision > revisionBeforeRetry && projected.pendingAction === "Cancelling Developer turn")) throw new Error(`A duplicate durable cancellation command re-cancelled the Developer turn in ${scenario}`);
  } else {
    state = await development.result();
  }
  if (options.planRevision) {
    state = await helpers.waitForState(handle, (candidate) => candidate.phase === "delivery_blocked");
    state = await handle.executeUpdate(revisePlanUpdate, { args: [{ expectedRevision: state.revision, actorUserId: "fixture-user", reason: "Revise the bounded fixture plan.", worktreeDisposition: "new", exactBaseSha: "9".repeat(40) }], updateId: `${scenario}-revise` });
    return handle.executeUpdate(startPlanningUpdate, { args: [helpers.command(state.revision, `${scenario}-replan`)], updateId: `${scenario}-replan` });
  }
  if (options.developerRetry) state = await handle.executeUpdate(retryDevelopmentUpdate, { args: [helpers.command(state.revision, `${scenario}-retry`)], updateId: `${scenario}-retry` });
  if (options.skipReview) return state;
  // Lead-owned phases (review, repair, publish, conflict resolution) chain themselves:
  // the fixture only waits for the next state that genuinely belongs to a member.
  state = await helpers.waitForState(handle, (candidate) => HUMAN_OWNED_PHASES.has(candidate.phase));
  if (options.acceptance) {
    state = await helpers.waitForState(handle, (candidate) => candidate.phase === "accepted");
    if (options.acceptance === "request-changes") state = await handle.executeUpdate(requestDeliveryChangesUpdate, { args: [{ ...helpers.command(state.revision, `${scenario}-request-changes`), note: "Controlled member repair request" }], updateId: `${scenario}-request-changes` });
    else state = await handle.executeUpdate(acceptDeliveryUpdate, { args: [{ ...helpers.command(state.revision, `${scenario}-accept`), decision: "accept" }], updateId: `${scenario}-accept` });
    if (options.acceptance === "ready-timeout") state = await handle.executeUpdate(reconcileAcceptanceUpdate, { args: [helpers.command(state.revision, `${scenario}-reconcile-ready`)], updateId: `${scenario}-reconcile-ready` });
    if (options.merge) state = await handle.executeUpdate(reconcileMergeUpdate, { args: [helpers.command(state.revision, `${scenario}-merge`)], updateId: `${scenario}-merge` });
  } else if (options.ciWait) {
    state = await helpers.waitForState(handle, (candidate) => candidate.phase === "accepted" && candidate.ciRunId === "ci-ci_wait_retry");
  } else if (options.finalReviewFailure) {
    state = await helpers.waitForState(handle, (candidate) => candidate.phase === "delivery_blocked" && candidate.finalReviewFailureCode === "final_review_unavailable");
  }
  return state;
}

async function driveScenario(definition: ReplayScenarioDefinitionUnion, input: { client: WorkflowClient; connection: NativeConnection; namespace: string; taskQueue: string; workflowBundle: Awaited<ReturnType<typeof buildProductionWorkflowBundle>>; projections: Map<string, IssueWorkflowState[]> }): Promise<ScenarioExecution> {
  const workflowId = `fixture-${definition.name}`;
  const projections = input.projections;
  const projectionHistory: IssueWorkflowState[] = [];
  projections.set(workflowId, projectionHistory);
  const context: ReplayScenarioActivityContext = {
    scenario: definition.name,
    projections,
    developerGate: deferred(),
    planningAttempts: new Map(),
    reviewAttempts: new Map(),
    ciAttempts: new Map(),
    developmentAttempts: new Map(),
    scenarioByExecutionId: new Map(),
    capacityRequests: new Map(),
    capacityState: (request) => ({ requestId: request.id, logicalTurnKey: request.logicalTurnKey, workflowRevision: request.workflowRevision, operation: request.operation, role: request.role, profileId: request.profileId, laneKey: request.laneKey, status: request.status, position: null, reason: request.waitReason, requestedAt: request.requestedAt, retryAt: request.retryAt, rateLimitAttempts: request.rateLimitAttempts }),
  };
  const shared = createSharedActivities(context);
  const overrides = typeof definition.activityOverrides === "function" ? definition.activityOverrides(context, shared) : definition.activityOverrides ?? {};
  const worker = await Worker.create({ connection: input.connection, namespace: input.namespace, taskQueue: input.taskQueue, workflowBundle: input.workflowBundle, dataConverter: temporalDataConverter, activities: createIssueActivitiesFake({ ...shared, ...overrides }) });
  const workerRun = worker.run();
  try {
    const workflowInput: IssueWorkflowInput = { workflowId, companyId: "fixture-company", projectId: "fixture-project", issueId: `fixture-issue-${definition.name}`, projectRevisionId: "fixture-project-revision", briefArtifactId: "fixture-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { planner: "fixture-profile", builder: "fixture-profile" }, supplementalReview: false, ...( "workflowInput" in definition ? definition.workflowInput : {}) };
    const handle = await input.client.start(issueWorkflow, { workflowId, taskQueue: input.taskQueue, args: [workflowInput] });
    const helpers: ReplayScenarioScriptHelpers = {
      scenario: definition.name,
      workflowId,
      projections: projectionHistory,
      developerGate: context.developerGate,
      command,
      waitForState,
      drive: (scenarioHandle, options) => driveScenarioScript(scenarioHandle, { scenario: definition.name, workflowId, projections: projectionHistory, developerGate: context.developerGate, command, waitForState }, options),
    };
    const state = await definition.script(handle, helpers);
    return { scenario: definition.name, workflowId, firstRunId: handle.firstExecutionRunId, currentPhase: state.phase, finalState: state, projections: projectionHistory };
  } finally {
    worker.shutdown();
    await workerRun;
  }
}

export async function runReplayScenarioCorpus(input: { client: WorkflowClient; connection: NativeConnection; namespace: string; taskQueue: string }): Promise<ScenarioExecution[]> {
  const projections = new Map<string, IssueWorkflowState[]>();
  const workflowBundle = await buildProductionWorkflowBundle();
  const executions: ScenarioExecution[] = [];
  for (const definition of replayScenarios) executions.push(await driveScenario(definition, { ...input, workflowBundle, projections }));
  return executions;
}
