import { join } from "node:path";

import { expect, test } from "vitest";

import { ProjectionRebuildService } from "../src/projection-rebuild.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { connectTemporal, continueIssueWork, executeIssueCommand, queryIssueWorkflow, rejectIssuePlan, reviseIssuePlan, startIssueWorkflow } from "../src/temporal/service.js";
import { replayIssueHistory, type ReplayHistory } from "../src/temporal/replay.js";
import { createTemporalHarness } from "./helpers/temporal-harness.js";
import { developerExecutionId } from "../src/temporal/deterministic-id.js";

test("Temporal retries with rewound attempt numbers get distinct Developer execution IDs", () => {
  const firstRetry = developerExecutionId("workflow-reset", 1, 2, "implementation", "retry-before-reset");
  const replayedRetry = developerExecutionId("workflow-reset", 1, 2, "implementation", "retry-after-reset");

  expect(replayedRetry).not.toBe(firstRetry);
  expect(replayedRetry).toMatch(/^developer_[a-f0-9]{24}$/);
});

test("runs the issue lifecycle, governance, recovery, CI, continuation, and rebuild scenarios", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  const { config, database, artifacts } = harness;
  const { state } = harness;
  try {
    // 100 attempts (~5s): the auto-chain now tacks a real capacity-service review call onto
    // delivery_ready/delivery_reviewed/repair_required, so settling can take longer than before.
    const waitForPhase = async (fixtureWorkflowId: string, phase: string) => {
      let fixtureState = await queryIssueWorkflow(config, fixtureWorkflowId);
      for (let attempt = 0; attempt < 100 && fixtureState.phase !== phase; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        fixtureState = await queryIssueWorkflow(config, fixtureWorkflowId);
      }
      return fixtureState;
    };

    // repairCycleLimit: 0 so the auto-chain's one blocking review lands directly in delivery_blocked
    // instead of looping review -> repair -> review through the real capacity service.
    const startedIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0 });
    const duplicateIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false });
    expect(duplicateIssue).toMatchObject({ workflowId: startedIssue.workflowId, runId: startedIssue.runId, existing: true });
    let issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    for (let attempt = 0; attempt < 20 && issueState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    }
    expect(issueState).toMatchObject({ issueId: "issue-restart", phase: "backlog", revision: 0, allowedCommands: ["start_planning", "cancel_issue"] });
    state.holdPlanning = true;
    state.planningGate = new Promise<void>((resolve) => { state.releasePlanning = resolve; });
    const plannedIssuePromise = executeIssueCommand(config, startedIssue.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "issue-admin" });
    let projectedPlanning: { revision: number; phase: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      projectedPlanning = database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get()) as { revision: number; phase: string } | undefined;
      if (projectedPlanning?.phase === "planning" && projectedPlanning.revision >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(projectedPlanning).toEqual({ revision: 2, phase: "planning" });
    state.releasePlanning();
    state.holdPlanning = false;
    const plannedIssue = await plannedIssuePromise;
    expect(plannedIssue).toMatchObject({ phase: "approval", revision: 4, owner: "human", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], blocker: { category: "member_authorization", evidence: { artifactId: artifacts.integrationLeadOutputArtifactId, sha256: expect.any(String), kind: "lead-plan" }, actions: expect.arrayContaining([expect.objectContaining({ command: "approve_plan" }), expect.objectContaining({ command: "reject_plan" })]) } });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get())).toEqual({ revision: 4, phase: "approval" });
    const revisionRequested = await rejectIssuePlan(config, startedIssue.workflowId, { expectedRevision: 4, actorUserId: "issue-admin", note: "Please address the security boundary" });
    expect(revisionRequested).toMatchObject({ phase: "planning", revision: 5, allowedCommands: ["start_planning", "cancel_issue"], planRevision: null, planMaterial: null });
    const replannedIssue = await executeIssueCommand(config, startedIssue.workflowId, "start_planning", { expectedRevision: 5, actorUserId: "issue-admin" });
    expect(replannedIssue).toMatchObject({ phase: "approval", revision: 9, planRevision: 6, planMaterial: true });
    const approvedIssue = await executeIssueCommand(config, startedIssue.workflowId, "approve_plan", { expectedRevision: 9, actorUserId: "issue-admin", note: "Approve revised plan" });
    expect(approvedIssue).toMatchObject({ phase: "ready_for_development", revision: 10, allowedCommands: ["start_development", "cancel_issue", "revise_plan"], blocker: null });
    // ready_for_development and delivery_ready are both auto-chained onward now (no human "Start
    // development" or "Review delivery" click), so a manual command sent right after approval, or
    // polling for the transient delivery_ready landing itself, would lose the race with the
    // Workflow's own next turn. The auto-chain runs the blocking review on its own; repairCycleLimit
    // 0 means it lands directly in delivery_blocked (no manual click, no repair loop).
    const blockedDelivery = await waitForPhase(startedIssue.workflowId, "delivery_blocked");
    expect(blockedDelivery).toMatchObject({ phase: "delivery_blocked", allowedCommands: ["record_delivery_decision", "cancel_issue", "revise_plan"], deliveryReviewId: "delivery_review_integration", deliveryReviewOutcome: "blocking", repairCycle: 0, developerExecutionId: expect.stringMatching(/^developer_[a-f0-9]{24}$/), developerSessionRef: "session_developer_integration", branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40) });
    // record_delivery_decision is the only safe way out of here: every other landing state that
    // revise_plan accepts (delivery_ready, delivery_reviewed, repair_required) is itself
    // auto-chained onward, so a manual command sent right after loses the race with the Workflow's
    // own next turn ("Stale workflow revision"). record_delivery_decision is not auto-chained and
    // explicitly clears the human blocker, landing safely on delivery_reviewed.
    const decidedDelivery = await executeIssueCommand(config, startedIssue.workflowId, "record_delivery_decision", { expectedRevision: blockedDelivery.revision, actorUserId: "issue-admin", note: "Continue past the blocking review" });
    expect(decidedDelivery).toMatchObject({ phase: "delivery_reviewed", blocker: null, allowedCommands: ["publish_draft", "cancel_issue"] });

    const ciContinuation = (issueId: string, extra: Record<string, unknown> = {}) => ({ phase: "ci_waiting" as const, revision: 20, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for required CI", lastEventId: `${issueId}-20`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: new Date().toISOString(), leadSessionRef: "session_ci_lead", leadExecutionId: "agent_ci_lead", leadOutputArtifactId: "artifact_ci_lead_output", deliveryReviewId: `delivery_${issueId}`, planRevision: 1, developerExecutionId: "developer_ci_original", developerSessionRef: "session_ci_developer", worktreePath: join(harness.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_ci_delivery", developerEvidenceArtifactId: "artifact_ci_developer_evidence", releaseId: `release_${issueId}`, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", expectedHeadSha: "b".repeat(40), expectedHeadTree: "c".repeat(40), ciAttempt: 0, ciOutcome: "waiting" as const, ciNextPollAt: null, ...extra });
    // repairCycleLimit: 0 here too -- the fixture reviewer always returns blocking, so without
    // this every fixture that lands on delivery_ready would loop review -> repair -> review
    // through the real capacity service and blow the test time budget.
    const startCiFixture = (issueId: string, extra: Record<string, unknown> = {}) => startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId, projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: ciContinuation(issueId, extra) });

    state.planningMaterial = false;
    // ready_for_development for a routine plan is now auto-chained straight into start_development
    // (no human "Start development" click), and delivery_ready/delivery_reviewed chain onward too --
    // a manual command sent right after the workflow starts would lose the race with the Workflow's
    // own next turn. Confirm the auto-chain actually drove start_development (development runs a real
    // developer-execution activity, so it holds long enough to observe), then wait for the settled
    // delivery_blocked landing (repairCycleLimit 0, always-blocking review fixture).
    const routine = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-routine", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: { ...ciContinuation("ci-routine"), phase: "ready_for_development", revision: 4, owner: "lead", allowedCommands: ["start_development", "cancel_issue", "revise_plan"], pendingAction: "Start development", lastEventId: "ci-routine-4", planMaterial: false, materialCategories: [], releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, developerExecutionId: null, developerSessionRef: null, resultCommit: null, resultTree: null, deliveryArtifactId: null, developerEvidenceArtifactId: null } });
    expect(await waitForPhase(routine.workflowId, "development")).toMatchObject({ phase: "development", planMaterial: false });
    expect(await waitForPhase(routine.workflowId, "delivery_blocked")).toMatchObject({ phase: "delivery_blocked", planMaterial: false });

    state.planningMaterial = true;
    state.preservedWorktreeCompatibility = false;
    state.revisionDisposition = "reuse";
    // Starts already at delivery_blocked (not delivery_ready): delivery_ready is auto-chained to
    // review_delivery, so a manual command sent right after the workflow starts would lose the
    // race with the Workflow's own next turn. delivery_blocked is not auto-chained, and this
    // fixture's blocker is null (never populated), so revise_plan is safe to call immediately.
    const incompatible = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-incompatible", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: { ...ciContinuation("ci-incompatible"), phase: "delivery_blocked", revision: 8, owner: "human", allowedCommands: ["revise_plan", "cancel_issue"], pendingAction: "Lead delivery review", lastEventId: "ci-incompatible-8" } });
    const incompatibleRequested = await reviseIssuePlan(config, incompatible.workflowId, { expectedRevision: 8, actorUserId: "issue-admin", reason: "The preserved implementation conflicts with the revised plan.", worktreeDisposition: "reuse" });
    const callsBeforeIncompatiblePlan = state.revisionAuthorizationCalls;
    const incompatiblePlan = await executeIssueCommand(config, incompatible.workflowId, "start_planning", { expectedRevision: incompatibleRequested.revision, actorUserId: "issue-admin" });
    expect(incompatiblePlan).toMatchObject({ phase: "delivery_blocked", owner: "human", blockerCode: "preserved-worktree-incompatible", allowedCommands: ["revise_plan", "cancel_issue"] });
    expect(state.revisionAuthorizationCalls).toBe(callsBeforeIncompatiblePlan);
    state.preservedWorktreeCompatibility = null;
    state.revisionDisposition = "new";

    const ciPass = await startCiFixture("ci-pass");
    expect(await waitForPhase(ciPass.workflowId, "accepted")).toMatchObject({ phase: "accepted", ciOutcome: "passed", finalReviewId: "final_review_ci-pass", leadSessionRef: "session_ci_lead", blocker: { category: "member_authorization", evidence: { artifactId: artifacts.integrationFinalReviewArtifactId, sha256: artifacts.integrationFinalReviewArtifactSha256, kind: "delivery-review" }, actions: expect.arrayContaining([expect.objectContaining({ command: "accept_delivery" }), expect.objectContaining({ command: "request_delivery_changes" })]) } });
    expect(harness.ciCalls.get("ci-pass")).toBe(1);

    const ciRate = await startCiFixture("ci-rate");
    expect(await waitForPhase(ciRate.workflowId, "accepted")).toMatchObject({ phase: "accepted", ciOutcome: "passed", ciAttempt: 2, blocker: { category: "member_authorization" } });
    expect(harness.ciCalls.get("ci-rate")).toBe(2);

    const ciProviderFailure = await startCiFixture("ci-provider-failure");
    const providerFailureState = await waitForPhase(ciProviderFailure.workflowId, "delivery_blocked");
    expect(providerFailureState).toMatchObject({ phase: "delivery_blocked", ciOutcome: "provider_unavailable", blocker: { category: "provider_connectivity_exhausted", evidence: { artifactId: artifacts.ciProviderEvidence.id, sha256: artifacts.ciProviderEvidence.sha256, kind: "ci-evidence" }, actions: expect.arrayContaining([expect.objectContaining({ command: "reconcile_ci" }), expect.objectContaining({ command: "cancel_issue" })]) } });
    let providerFailureAttention = database.authQuery((db) => db.prepare("SELECT active, category, evidence_artifact_id FROM forge_attention_items WHERE task_id = 'ci-provider-failure'").get());
    for (let attempt = 0; attempt < 40 && !providerFailureAttention; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      providerFailureAttention = database.authQuery((db) => db.prepare("SELECT active, category, evidence_artifact_id FROM forge_attention_items WHERE task_id = 'ci-provider-failure'").get());
    }
    expect(providerFailureAttention).toMatchObject({ active: 1, category: "provider_connectivity_exhausted", evidence_artifact_id: artifacts.ciProviderEvidence.id });

    const ciRepair = await startCiFixture("ci-repair");
    // The CI repair itself lands delivery_ready, but the auto-chain immediately runs the review
    // from there too; repairCycleLimit 0 settles it in delivery_blocked right after. Whether that
    // auto review actually completes (opinion "blocking") or its capacity acquisition trips on the
    // just-finished CI-repair turn (infrastructure-failure blocked path, outcome null) is not the
    // point of this fixture -- either way it must land in delivery_blocked, not loop.
    const ciRepairBlocked = await waitForPhase(ciRepair.workflowId, "delivery_blocked");
    expect(ciRepairBlocked).toMatchObject({ phase: "delivery_blocked", developerExecutionId: "developer_ci_repair", developerSessionRef: "session_ci_developer", resultCommit: "d".repeat(40), releaseId: null, ciRunId: null, finalReviewId: null });
    expect([null, "blocking"]).toContain(ciRepairBlocked.deliveryReviewOutcome);
    expect(harness.ciPlanInputs).toEqual([{ leadSessionRef: "session_ci_lead", ciAttemptId: "ci_attempt_ci-repair_1" }]);
    expect(harness.ciRepairInputs).toEqual([{ priorDeveloperSessionRef: "session_ci_developer", ciAttemptId: "ci_attempt_ci-repair_1" }]);

    const ciCancel = await startCiFixture("ci-cancel", { ciNextPollAt: new Date(Date.now() + 10_000).toISOString() });
    const waitingToCancel = await waitForPhase(ciCancel.workflowId, "ci_waiting");
    expect(waitingToCancel.blocker).toBeNull();
    const cancelledIssue = await executeIssueCommand(config, ciCancel.workflowId, "cancel_issue", { expectedRevision: waitingToCancel.revision, actorUserId: "issue-admin" });
    expect(cancelledIssue).toMatchObject({ phase: "cancelled", allowedCommands: ["continue_work"] });
    const continuedIssue = await continueIssueWork(config, ciCancel.workflowId, { expectedRevision: cancelledIssue.revision, actorUserId: "issue-admin", reason: "Continue the bounded work after cancellation." });
    expect(continuedIssue).toMatchObject({ phase: "cancelled", revision: cancelledIssue.revision + 1, allowedCommands: [], successorReference: { predecessorTaskId: "ci-cancel" }, successorTaskId: "ci-cancel-successor-" + cancelledIssue.revision });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(harness.ciCalls.get("ci-cancel") ?? 0).toBe(0);
    const ciReplayClient = await connectTemporal(config);
    try {
      for (const [name, fixtureWorkflowId] of [["pass", ciPass.workflowId], ["rate-limit", ciRate.workflowId], ["repair", ciRepair.workflowId], ["cancel", ciCancel.workflowId]] as const) {
        const history = await ciReplayClient.client.workflow.getHandle(fixtureWorkflowId).fetchHistory();
        await replayIssueHistory(history as ReplayHistory, `ci-${name}-replay`);
      }
    } finally { ciReplayClient.connection.close(); }

    const recoveryWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-start-failure`;
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-start-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: { phase: "development", revision: 4, owner: "lead", allowedCommands: ["cancel_development", "reject_plan", "cancel_issue"], pendingAction: "Developer execution", lastEventId: `${recoveryWorkflowId}:4`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0 } });
    const recoveredStart = await executeIssueCommand(config, recoveryWorkflowId, "cancel_development", { expectedRevision: 4, actorUserId: "issue-admin" });
    expect(recoveredStart).toMatchObject({ phase: "ready_for_development", revision: 6, owner: "lead", allowedCommands: ["start_development", "cancel_issue", "revise_plan"], pendingAction: "Start development" });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-start-failure'").get())).toEqual({ revision: 6, phase: "ready_for_development" });

    const developerFailureWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-developer-failure`;
    // Set before the workflow starts: ready_for_development is now auto-chained straight into
    // start_development, so the failure must already be armed before the Workflow's own turn fires
    // rather than raced with a manual send afterward.
    state.developerFailure = true;
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-developer-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: { phase: "ready_for_development", revision: 3, owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${developerFailureWorkflowId}:3`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0 } });
    const recoveredDeveloperFailure = await waitForPhase(developerFailureWorkflowId, "delivery_blocked");
    expect(recoveredDeveloperFailure).toMatchObject({ phase: "delivery_blocked", revision: 7, owner: "human", allowedCommands: ["retry_development", "cancel_issue", "revise_plan"], pendingAction: "The agent invocation did not complete.", developerRecoveryStatus: "failed", developerRecoveryReasonCode: "process-exited" });
    await expect.poll(() => database!.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = 'issue-developer-failure'").get()), { timeout: 10_000 }).toEqual({ revision: 7, phase: "delivery_blocked", pending_action: "The agent invocation did not complete." });
    state.developerFailure = false;

    const failedRetryWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-failed-retry`;
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-failed-retry", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: { phase: "failed", revision: 8, owner: "human", allowedCommands: ["retry_development", "start_planning", "continue_work", "cancel_issue"], pendingAction: "Developer retry is required", lastEventId: `${failedRetryWorkflowId}:8`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0, developerExecutionId: "developer_failed_retry", developerAttempt: 1, branchName: "forge/issue/failed-retry" } });
    state.holdDeveloper = true;
    state.developerGate = new Promise<void>((resolve) => { state.releaseDeveloper = resolve; });
    const retriedFailedDevelopmentPromise = executeIssueCommand(config, failedRetryWorkflowId, "retry_development", { expectedRevision: 8, actorUserId: "issue-admin" });
    const retriedFailedDevelopment = await waitForPhase(failedRetryWorkflowId, "development");
    expect(retriedFailedDevelopment).toMatchObject({ phase: "development", owner: "lead", developerAttempt: 2, pendingAction: "Developer retry" });
    state.releaseDeveloper();
    state.holdDeveloper = false;
    await retriedFailedDevelopmentPromise;

    const blockedRetryWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-ci-retry-development`;
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-retry-development", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: { phase: "delivery_blocked", revision: 13, owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer delivery was blocked", lastEventId: `${blockedRetryWorkflowId}:13`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0, developerExecutionId: "developer_prior_blocked", developerAttempt: 1, branchName: "forge/issue/ci-retry-development" } });
    state.holdDeveloper = true;
    state.developerGate = new Promise<void>((resolve) => { state.releaseDeveloper = resolve; });
    const retryBlockedDevelopment = executeIssueCommand(config, blockedRetryWorkflowId, "retry_development", { expectedRevision: 13, actorUserId: "issue-admin", commandId: "retry-delivery-blocked-0001" });
    const retryStarted = await waitForPhase(blockedRetryWorkflowId, "development");
    expect(retryStarted).toMatchObject({ phase: "development", revision: 14, developerAttempt: 2, developerExecutionId: expect.any(String) });
    expect(retryStarted.developerExecutionId).not.toBe("developer_prior_blocked");
    state.releaseDeveloper();
    state.holdDeveloper = false;
    await retryBlockedDevelopment;

    const deadBuilderWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-ci-dead-builder`;
    state.deadBuilderOnce = true;
    state.holdDeveloper = true;
    state.developerGate = new Promise<void>((resolve) => { state.releaseDeveloper = resolve; });
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-dead-builder", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: { phase: "ready_for_development", revision: 3, owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${deadBuilderWorkflowId}:3`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0 } });
    let deadBuilderRetry = await waitForPhase(deadBuilderWorkflowId, "development");
    for (let attempt = 0; attempt < 100 && deadBuilderRetry.developerAttempt !== 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      deadBuilderRetry = await queryIssueWorkflow(config, deadBuilderWorkflowId);
    }
    expect(deadBuilderRetry).toMatchObject({ phase: "development", owner: "lead", developerAttempt: 2, developerRecoveryStatus: "starting" });
    expect(deadBuilderRetry.allowedCommands).not.toContain("retry_development");
    state.releaseDeveloper();
    state.holdDeveloper = false;
    await waitForPhase(deadBuilderWorkflowId, "delivery_blocked");

    state.planningFailure = true;
    const startedPlanningFailure = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-planning-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false });
    const retryablePlanningFailure = await executeIssueCommand(config, startedPlanningFailure.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "issue-admin" });
    expect(retryablePlanningFailure).toMatchObject({ phase: "failed", owner: "human", allowedCommands: ["start_planning", "continue_work", "cancel_issue"], pendingAction: "Planning failed; retry is available" });
    state.planningFailure = false;
    const continuedFailedPlanning = await continueIssueWork(config, startedPlanningFailure.workflowId, { expectedRevision: retryablePlanningFailure.revision, actorUserId: "issue-admin", reason: "Continue the failed planning work in a fresh successor." });
    expect(continuedFailedPlanning).toMatchObject({ phase: "failed", revision: retryablePlanningFailure.revision + 1, allowedCommands: ["cancel_issue"], successorReference: { predecessorTaskId: "ci-planning-failure" }, successorTaskId: "ci-planning-failure-successor-" + retryablePlanningFailure.revision });

    state.permanentPlanningFailure = true;
    const startedPermanentFailure = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-permanent-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false });
    const failedIssue = await executeIssueCommand(config, startedPermanentFailure.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "issue-admin" });
    expect(failedIssue).toMatchObject({ phase: "failed", revision: 3, owner: "human", allowedCommands: ["start_planning", "continue_work", "cancel_issue"], pendingAction: "The configured model is unavailable for the active provider account. Select a supported model, then retry.", blocker: { category: "provider_ambiguity", actions: expect.arrayContaining([expect.objectContaining({ command: "start_planning" }), expect.objectContaining({ command: "cancel_issue" })]), evidence: { kind: "attention-evidence" } } });
    expect(state.permanentPlanningCalls).toBe(1);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = 'issue-permanent-failure'").get())).toEqual({ revision: 3, phase: "failed", pending_action: "The configured model is unavailable for the active provider account. Select a supported model, then retry." });
    expect(database.authQuery((db) => db.prepare("SELECT active, category, evidence_artifact_id FROM forge_attention_items WHERE task_id = 'issue-permanent-failure'").get())).toMatchObject({ active: 1, category: "provider_ambiguity" });
    state.permanentPlanningFailure = false;
    const recoveredIssue = await executeIssueCommand(config, startedPermanentFailure.workflowId, "start_planning", { expectedRevision: 3, actorUserId: "issue-admin" });
    expect(recoveredIssue).toMatchObject({ phase: "approval", revision: 7, planRevision: 4 });

    const startedContinuation = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continueAsNewAfter: 2 });
    let continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    for (let attempt = 0; attempt < 20 && continuationState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    }
    expect(continuationState).toMatchObject({ phase: "backlog", revision: 0, continuationCount: 0 });
    await expect.poll(() => database!.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = 'issue-continuation' AND revision = 0").get())).toEqual({ count: 1 });
    await executeIssueCommand(config, startedContinuation.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "issue-admin" });
    const progressState = await executeIssueCommand(config, startedContinuation.workflowId, "approve_plan", { expectedRevision: 4, actorUserId: "issue-admin", note: "Approved for development" });
    expect(progressState).toMatchObject({ phase: "ready_for_development", revision: 5, continuationCount: 0 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
      if (continuationState.continuationCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // ready_for_development is now auto-chained straight into start_development, so the resumed run
    // (after continueAsNew) proceeds past its revision-5 landing before a live query can reliably
    // catch it there -- by the time continuationCount flips to 1 it may already be a revision or two
    // further on. Assert on the fields that prove state carried across the continuation correctly
    // (identity, lead/plan metadata, the decision) rather than pinning the exact landing revision.
    expect(continuationState).toMatchObject({ workflowId: startedContinuation.workflowId, companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", owner: "lead", continuationCount: 1, lastSummaryHash: null, leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: artifacts.integrationLeadEvidenceArtifactId, leadOutputArtifactId: artifacts.integrationLeadOutputArtifactId, leadOutputKind: "plan", leadSummary: "Integration plan", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false });
    expect(continuationState.revision).toBeGreaterThanOrEqual(5);
    expect(continuationState.decisionId).toMatch(/^decision_/);
    const settledRevision = continuationState.revision;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const projection = database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get()) as { revision: number } | undefined;
      if ((projection?.revision ?? -1) >= settledRevision) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const projectedAfterContinuation = database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get()) as { revision: number; phase: string };
    expect(projectedAfterContinuation.revision).toBeGreaterThanOrEqual(settledRevision);
    // The pre-continuation history (revisions 0-5) is append-only and must still be intact across
    // the continuation boundary, whatever the resumed run has gone on to do since.
    const timelineRevisions = (database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = 'issue-continuation' ORDER BY revision").all()) as Array<{ revision: number }>).map((row) => row.revision);
    expect(timelineRevisions.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await new ProjectionRebuildService(database, config).rebuild({ companyId: "issue-company", taskId: "issue-continuation" })).toEqual({ rebuilt: 1, findings: [] });
    const rebuiltProjection = database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get()) as { revision: number; phase: string };
    expect(rebuiltProjection.revision).toBeGreaterThanOrEqual(settledRevision);

  } finally {
    await harness.stop();
  }
}, 120_000);

test("cancel_issue cancels a Lead activity despite a stale revision and late result", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  const { config, database, state } = harness;
  try {
    const started = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false });
    let issueState = await queryIssueWorkflow(config, started.workflowId);
    for (let attempt = 0; attempt < 20 && issueState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issueState = await queryIssueWorkflow(config, started.workflowId);
    }
    expect(issueState.allowedCommands).toContain("cancel_issue");

    state.holdPlanning = true;
    state.planningGate = new Promise<void>((resolve) => { state.releasePlanning = resolve; });
    const plannedIssuePromise = executeIssueCommand(config, started.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "issue-admin" });
    let planning = await queryIssueWorkflow(config, started.workflowId);
    for (let attempt = 0; attempt < 20 && planning.phase !== "planning"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      planning = await queryIssueWorkflow(config, started.workflowId);
    }
    // The bug under test: a lead-owned phase mid-turn (allowedCommands used to be []) must
    // still offer cancel_issue to a single operator.
    expect(planning).toMatchObject({ phase: "planning", owner: "lead" });
    expect(planning.allowedCommands).toContain("cancel_issue");

    const staleRevision = planning.revision - 1;
    expect(staleRevision).toBeGreaterThanOrEqual(0);
    const cancelled = await executeIssueCommand(config, started.workflowId, "cancel_issue", { expectedRevision: staleRevision, actorUserId: "issue-admin" });
    expect(cancelled).toMatchObject({ phase: "cancelled", owner: "human" });

    // Release the held Lead turn now that cancellation was requested: its stale result must
    // not resurrect a cancelled issue (the capacity turn is rejected as stale and discarded).
    state.releasePlanning();
    state.holdPlanning = false;
    await plannedIssuePromise.catch(() => undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      issueState = await queryIssueWorkflow(config, started.workflowId);
      if (issueState.phase === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(issueState).toMatchObject({ phase: "cancelled", owner: "human" });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get())).toEqual({ revision: issueState.revision, phase: "cancelled" });
  } finally {
    await harness.stop();
  }
}, 60_000);
