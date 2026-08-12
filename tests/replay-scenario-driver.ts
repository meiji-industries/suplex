import { ApplicationFailure } from "@temporalio/common";
import type { WorkflowClient, WorkflowHandle } from "@temporalio/client";
import type { NativeConnection } from "@temporalio/worker";
import { Worker } from "@temporalio/worker";

import type { DurableArtifactReference, IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { acceptDeliveryUpdate, approvePlanUpdate, cancelDevelopmentUpdate, issueStateQuery, issueWorkflow, publishDraftUpdate, reconcileAcceptanceUpdate, reconcileMergeUpdate, repairDeliveryUpdate, requestDeliveryChangesUpdate, reviewDeliveryUpdate, startDevelopmentUpdate, startPlanningUpdate } from "../src/temporal/workflows.js";
import { buildProductionWorkflowBundle, temporalDataConverter } from "../src/temporal/workflow-bundle.js";

export const replayScenarios = [
  "normal_success",
  "implementation_repair",
  "active_cancellation",
  "blocked_authentication_resume",
  "continue_as_new",
  "release_base_drift_merged",
  "release_base_drift_conflict",
  "ci_wait_retry",
  "acceptance_ready_timeout",
  "acceptance_requested_changes",
  "acceptance_provider_outage",
  "manual_merge_open",
  "manual_merge_closed",
  "manual_merge_changed",
  "final_review_failure",
] as const;

export type ReplayScenario = typeof replayScenarios[number];

export interface ScenarioExecution {
  scenario: ReplayScenario;
  workflowId: string;
  firstRunId: string;
  currentPhase: IssueWorkflowState["phase"];
  finalState: IssueWorkflowState;
  projections: IssueWorkflowState[];
}

function artifact(kind: DurableArtifactReference["kind"], id: string): DurableArtifactReference {
  return { artifactId: id, companyId: "fixture-company", kind, sha256: "a".repeat(64), byteSize: 1, mimeType: "application/json" };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value) => resolve(value as T) };
}

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

export async function runReplayScenarioCorpus(input: { client: WorkflowClient; connection: NativeConnection; namespace: string; taskQueue: string }): Promise<ScenarioExecution[]> {
  const projections = new Map<string, IssueWorkflowState[]>();
  const developerGates = new Map<string, ReturnType<typeof deferred>>();
  const planningAttempts = new Map<string, number>();
  const reviewAttempts = new Map<string, number>();
  const ciAttempts = new Map<string, number>();
  const scenarioFor = (workflowId: string): ReplayScenario => replayScenarios.find((scenario) => workflowId.endsWith(scenario))!;
  const activities: IssueActivities = {
    async projectIssueState(event) {
      projections.get(event.state.workflowId)?.push(structuredClone(event.state));
      return event.state;
    },
    async reconcileTargetBase(activityInput) {
      return { outcome: "no_drift", checkId: `target-base-${activityInput.taskId}`, checkpoint: activityInput.checkpoint, expectedBaseSha: activityInput.expectedBaseSha, observedBaseSha: activityInput.expectedBaseSha, headSha: activityInput.expectedHeadSha, headTree: activityInput.expectedHeadTree };
    },
    async runLeadPlanning(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      const attempt = (planningAttempts.get(activityInput.workflowId) ?? 0) + 1;
      planningAttempts.set(activityInput.workflowId, attempt);
      if (scenario === "blocked_authentication_resume" && attempt === 1) {
        throw ApplicationFailure.nonRetryable("Authentication expired", "login-expired", { code: "login-expired", summary: "Authentication expired; sign in and retry." });
      }
      return { leadSessionRef: `lead-session-${scenario}`, leadExecutionId: `lead-execution-${scenario}-${attempt}`, leadEvidenceArtifactId: `lead-evidence-${scenario}`, leadOutputArtifactId: `lead-plan-${scenario}`, leadOutputKind: "plan", leadSummary: "Controlled fixture plan", materialCategories: ["security_permissions"], material: true };
    },
    async runSupplementalReview() { throw new Error("Supplemental review is not used by replay scenarios"); },
    async consolidateLeadPlan() { throw new Error("Plan consolidation is not used by replay scenarios"); },
    async planDeliveryRepair(activityInput) { return { planId: `repair-plan-${activityInput.workflowId}`, planArtifactId: `repair-plan-artifact-${activityInput.workflowId}`, planSha256: "a".repeat(64), evidenceArtifactId: `repair-plan-evidence-${activityInput.workflowId}`, leadSessionRef: activityInput.leadSessionRef, summary: "Controlled repair plan", findings: activityInput.findings }; },
    async recordPlanDecision(activityInput) { return { decisionId: `decision-${activityInput.workflowId}-${activityInput.planRevision}` }; },
    async runDeveloperExecution(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      if (scenario === "active_cancellation" || scenario === "continue_as_new") await developerGates.get(activityInput.workflowId)!.promise;
      return { developerExecutionId: activityInput.executionId!, developerSessionRef: `developer-session-${scenario}`, branchName: `forge/issue/${scenario}`, targetBaseSha: "b".repeat(40), currentStep: 1, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean", deliveryArtifactId: `delivery-${scenario}`, evidenceArtifactId: `developer-evidence-${scenario}`, deliverySummary: "Controlled fixture delivery", outcome: "completed" };
    },
    async reviewDelivery(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      const attempt = (reviewAttempts.get(activityInput.workflowId) ?? 0) + 1;
      reviewAttempts.set(activityInput.workflowId, attempt);
      const blocking = scenario === "implementation_repair" && attempt === 1;
      return { outcome: "completed" as const, attemptId: `review-attempt-${scenario}-${attempt}`, correctionAttempts: 0, subject: activityInput.subject, review: { reviewId: `review-${scenario}-${attempt}`, leadExecutionId: `review-execution-${scenario}-${attempt}`, leadSessionRef: `lead-session-${scenario}`, opinionArtifactId: `review-artifact-${scenario}-${attempt}`, evidenceArtifactId: `review-evidence-${scenario}-${attempt}`, reviewArtifact: artifact("delivery-review", `review-artifact-${scenario}-${attempt}`), opinion: blocking ? "blocking" as const : "approved" as const, summary: blocking ? "Controlled repair required" : "Controlled review approved", repairPlan: blocking ? "Apply the controlled repair" : null, findings: blocking ? [{ findingId: `finding-${scenario}-${attempt}`, severity: "blocking" as const, rationale: "Controlled fixture defect", evidenceRef: "fixture", disposition: "open" as const, repairInstruction: "Apply the controlled repair" }] : [], supersedesReviewId: activityInput.supersedesReviewId ?? null } };
    },
    async runDeveloperRepair(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      return { outcome: "completed" as const, repairAttemptId: `repair-attempt-${scenario}-${activityInput.cycle}`, cycle: activityInput.cycle, reviewId: activityInput.reviewId, subject: { planRevision: activityInput.planRevision, targetBaseSha: activityInput.targetBaseSha, subjectCommit: activityInput.subjectCommit, subjectTree: activityInput.subjectTree, developerExecutionId: activityInput.developerExecutionId, deliveryArtifactId: `delivery-${scenario}`, developerEvidenceArtifactId: `developer-evidence-${scenario}`, leadSessionRef: activityInput.leadSessionRef, developerSessionRef: activityInput.developerSessionRef }, developerExecutionId: `repair-${activityInput.workflowId}`, developerSessionRef: `developer-session-${scenario}`, branchName: activityInput.branchName, resultCommit: "e".repeat(40), resultTree: "f".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: `repaired-delivery-${activityInput.workflowId}`, evidenceArtifactId: `repaired-evidence-${activityInput.workflowId}`, summary: "Controlled repaired delivery" };
    },
    async recordDeliveryDecision() { return { artifactId: "delivery-decision" }; },
    async cancelDeveloperExecution() { return { status: "cancelled" }; },
    async publishRelease(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      const base = { outcome: "completed" as const, releaseId: `release-${scenario}`, repository: "example/forge", branchName: activityInput.branchName, baseBranch: "main", headSha: activityInput.subjectCommit, headTree: activityInput.subjectTree, pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1", isDraft: true as const, reused: false, attempt: 1, targetBaseSha: activityInput.targetBaseSha };
      if (scenario === "release_base_drift_merged") return { ...base, outcome: "base-drift-merged" as const, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false as const, baseDriftMerged: true as const, priorHead: activityInput.subjectCommit, targetBaseSha: "9".repeat(40), headSha: "8".repeat(40), headTree: "7".repeat(40) };
      if (scenario === "release_base_drift_conflict") return { ...base, outcome: "base-drift-conflict" as const, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false as const, baseDriftConflict: true as const, forwardMergeId: "forward-merge-conflict", priorHead: activityInput.subjectCommit, targetBaseSha: "9".repeat(40), mergeConflictEvidence: artifact("merge-conflict-evidence", "merge-conflict-evidence") };
      return base;
    },
    async reconcileCi(activityInput) {
      const scenario = scenarioFor(projectionsForRelease(activityInput.releaseId));
      const attempt = (ciAttempts.get(activityInput.releaseId) ?? 0) + 1;
      ciAttempts.set(activityInput.releaseId, attempt);
      const common = { attemptId: `ci-attempt-${scenario}-${attempt}`, attemptNumber: activityInput.attemptNumber, expectedHeadSha: activityInput.expectedHeadSha, observedHeadSha: activityInput.expectedHeadSha, evidenceArtifactId: `ci-evidence-${scenario}-${attempt}`, policyHash: "f".repeat(64), propagationDeadline: "2099-01-01T00:05:00.000Z", overallDeadline: "2099-01-01T01:00:00.000Z" };
      if (scenario === "ci_wait_retry" && attempt === 1) return { ...common, runId: "ci-waiting", outcome: "waiting", reason: "checks_pending", owner: "system", repairable: false, summary: "Controlled CI wait", retryAt: "2026-08-11T00:00:00.000Z", nextPollAt: "2026-08-11T00:00:00.000Z" };
      return { ...common, runId: `ci-${scenario}`, outcome: "passed", reason: "checks_passed", owner: null, repairable: false, summary: "Controlled CI passed", retryAt: null, nextPollAt: null };
    },
    async planCiRepair() { throw new Error("CI repair planning is not used by replay scenarios"); },
    async runCiRepair() { throw new Error("CI repair execution is not used by replay scenarios"); },
    async finalReview(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      if (scenario === "final_review_failure") throw ApplicationFailure.nonRetryable("Final review provider unavailable", "final-review-unavailable");
      return { finalReviewId: `final-review-${scenario}`, leadExecutionId: `final-review-execution-${scenario}`, leadSessionRef: `lead-session-${scenario}`, opinionArtifactId: `final-review-artifact-${scenario}`, evidenceArtifactId: `final-review-evidence-${scenario}`, reviewArtifact: artifact("delivery-review", `final-review-artifact-${scenario}`), outcome: "approved", summary: "Controlled final review approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null };
    },
    async acceptDelivery(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      const common = { pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1" };
      if (scenario === "acceptance_ready_timeout") return { ...common, acceptanceId: `acceptance-${scenario}`, status: "pending_ready", outcome: "provider_unavailable", retryAt: null, blockerCode: "provider_unavailable", blockerSummary: "Controlled ready mutation timeout" };
      if (scenario === "acceptance_requested_changes") return { ...common, acceptanceId: `acceptance-${scenario}`, status: "requested_changes", reasonArtifactId: `reason-${scenario}` };
      if (scenario === "acceptance_provider_outage") return { ...common, acceptanceId: null, status: "blocked", outcome: "provider_unavailable", retryAt: null, blockerCode: "provider_unavailable", blockerSummary: "Controlled pre-intent provider outage" };
      return { ...common, acceptanceId: `acceptance-${scenario}`, status: "accepted", acceptedAt: "2026-08-11T00:00:00.000Z", readyAt: "2026-08-11T00:00:00.000Z" };
    },
    async reconcileAcceptance(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      if (scenario === "acceptance_ready_timeout") return { acceptanceId: activityInput.acceptanceId, status: "pending_ready", outcome: "provider_unavailable", retryAt: null, readyAt: null, acceptedAt: "2026-08-11T00:00:00.000Z", blockerCode: "provider_unavailable", blockerSummary: "Controlled ready observation timeout", pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1" };
      return { acceptanceId: activityInput.acceptanceId, status: "accepted", outcome: "ready", retryAt: null, readyAt: "2026-08-11T00:00:00.000Z", acceptedAt: "2026-08-11T00:00:00.000Z", pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1" };
    },
    async reconcileMerge(activityInput) {
      const scenario = scenarioFor(activityInput.workflowId);
      const common = { pullRequestNumber: 1, pullRequestUrl: "https://example.test/pull/1", mergeObservationId: `merge-observation-${scenario}`, completionReceiptId: null, observedAt: "2026-08-11T00:00:00.000Z", mergedAt: null, retryAt: null };
      if (scenario === "manual_merge_open") return { ...common, outcome: "open" };
      if (scenario === "manual_merge_closed") return { ...common, outcome: "closed_without_merge", blockerCode: "closed_without_merge", blockerSummary: "Controlled pull request closure" };
      if (scenario === "manual_merge_changed") return { ...common, outcome: "changed_head", blockerCode: "changed_head", blockerSummary: "Controlled pull request head change" };
      return { ...common, outcome: "merged", completionReceiptId: "completion-receipt", mergedAt: "2026-08-11T00:00:00.000Z" };
    },
    async planMergeConflict(activityInput) { return { planId: "conflict-plan", planArtifactId: "conflict-plan-artifact", evidenceArtifactId: "conflict-plan-evidence", leadExecutionId: "conflict-plan-execution", leadSessionRef: activityInput.leadSessionRef, summary: "Controlled conflict plan" }; },
    async resolveMergeConflict() { throw new Error("Conflict resolution is not used by replay scenarios"); },
  };

  function projectionsForRelease(releaseId: string): string {
    return [...projections.keys()].find((workflowId) => releaseId.endsWith(scenarioFor(workflowId)))!;
  }

  const worker = await Worker.create({ connection: input.connection, namespace: input.namespace, taskQueue: input.taskQueue, workflowBundle: await buildProductionWorkflowBundle(), dataConverter: temporalDataConverter, activities });
  const workerRun = worker.run();
  const executions: ScenarioExecution[] = [];
  try {
    for (const scenario of replayScenarios) {
      const workflowId = `fixture-${scenario}`;
      projections.set(workflowId, []);
      developerGates.set(workflowId, deferred());
      const workflowInput: IssueWorkflowInput = { workflowId, companyId: "fixture-company", projectId: "fixture-project", issueId: `fixture-issue-${scenario}`, projectRevisionId: "fixture-project-revision", briefArtifactId: "fixture-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, ...(scenario === "continue_as_new" ? { continueAsNewAfter: 2 } : {}) };
      const handle = await input.client.start(issueWorkflow, { workflowId, taskQueue: input.taskQueue, args: [workflowInput] });
      let state = await waitForState(handle, (candidate) => candidate.phase === "backlog");
      state = await handle.executeUpdate(startPlanningUpdate, { args: [command(state.revision, `${scenario}-plan-1`)], updateId: `${scenario}-plan-1` });
      if (scenario === "blocked_authentication_resume") state = await handle.executeUpdate(startPlanningUpdate, { args: [command(state.revision, `${scenario}-plan-2`)], updateId: `${scenario}-plan-2` });
      state = await handle.executeUpdate(approvePlanUpdate, { args: [command(state.revision, `${scenario}-approve`)], updateId: `${scenario}-approve` });
      if (scenario === "continue_as_new") state = await waitForState(handle, (candidate) => candidate.continuationCount === 1);
      const development = await handle.startUpdate(startDevelopmentUpdate, { args: [command(state.revision, `${scenario}-develop`)], updateId: `${scenario}-develop`, waitForStage: "ACCEPTED" });
      if (scenario === "active_cancellation" || scenario === "continue_as_new") {
        state = await waitForState(handle, (candidate) => candidate.phase === "development");
        const cancelCommand = command(state.revision, `${scenario}-cancel`);
        const cancelled = await handle.executeUpdate(cancelDevelopmentUpdate, { args: [cancelCommand], updateId: `${scenario}-cancel` });
        developerGates.get(workflowId)!.resolve();
        await development.result();
        state = cancelled;
        if (scenario === "continue_as_new") state = await waitForState(handle, (candidate) => candidate.continuationCount === 2);
        const revisionBeforeRetry = state.revision;
        const projectionCountBeforeRetry = projections.get(workflowId)!.length;
        state = await handle.executeUpdate(cancelDevelopmentUpdate, { args: [cancelCommand], updateId: `${scenario}-cancel-transport-retry` });
        if (state.revision !== revisionBeforeRetry || projections.get(workflowId)!.length !== projectionCountBeforeRetry) throw new Error("A duplicate durable cancellation command mutated Workflow state");
      } else {
        state = await development.result();
      }
      if (!["active_cancellation", "continue_as_new", "blocked_authentication_resume"].includes(scenario)) {
        state = await handle.executeUpdate(reviewDeliveryUpdate, { args: [command(state.revision, `${scenario}-review`)], updateId: `${scenario}-review` });
        if (scenario === "implementation_repair") state = await handle.executeUpdate(repairDeliveryUpdate, { args: [command(state.revision, `${scenario}-repair`)], updateId: `${scenario}-repair` });
        else state = await handle.executeUpdate(publishDraftUpdate, { args: [command(state.revision, `${scenario}-publish`)], updateId: `${scenario}-publish` });
        if (["normal_success", "acceptance_ready_timeout", "acceptance_requested_changes", "acceptance_provider_outage", "manual_merge_open", "manual_merge_closed", "manual_merge_changed"].includes(scenario)) {
          state = await waitForState(handle, (candidate) => candidate.phase === "accepted");
          if (scenario === "acceptance_requested_changes") state = await handle.executeUpdate(requestDeliveryChangesUpdate, { args: [{ ...command(state.revision, `${scenario}-request-changes`), note: "Controlled member repair request" }], updateId: `${scenario}-request-changes` });
          else state = await handle.executeUpdate(acceptDeliveryUpdate, { args: [{ ...command(state.revision, `${scenario}-accept`), decision: "accept" }], updateId: `${scenario}-accept` });
          if (scenario === "acceptance_ready_timeout") state = await handle.executeUpdate(reconcileAcceptanceUpdate, { args: [command(state.revision, `${scenario}-reconcile-ready`)], updateId: `${scenario}-reconcile-ready` });
          if (["normal_success", "manual_merge_open", "manual_merge_closed", "manual_merge_changed"].includes(scenario)) state = await handle.executeUpdate(reconcileMergeUpdate, { args: [command(state.revision, `${scenario}-merge`)], updateId: `${scenario}-merge` });
        } else if (scenario === "ci_wait_retry") state = await waitForState(handle, (candidate) => candidate.phase === "accepted" && candidate.ciRunId === "ci-ci_wait_retry");
        else if (scenario === "final_review_failure") state = await waitForState(handle, (candidate) => candidate.phase === "delivery_blocked" && candidate.finalReviewFailureCode === "final_review_unavailable");
      }
      executions.push({ scenario, workflowId, firstRunId: handle.firstExecutionRunId, currentPhase: state.phase, finalState: state, projections: projections.get(workflowId)! });
    }
    return executions;
  } finally {
    worker.shutdown();
    await workerRun;
  }
}
