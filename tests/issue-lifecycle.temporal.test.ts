import { join } from "node:path";

import { expect, test } from "vitest";

import { ProjectionRebuildService } from "../src/projection-rebuild.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { connectTemporal, continueIssueWork, executeIssueCommand, queryIssueWorkflow, rejectIssuePlan, reviseIssuePlan, startIssueWorkflow } from "../src/temporal/service.js";
import { replayIssueHistory, type ReplayHistory } from "../src/temporal/replay.js";
import { createTemporalHarness } from "./helpers/temporal-harness.js";

test("runs the issue lifecycle, governance, recovery, CI, continuation, and rebuild scenarios", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  const { config, database, artifacts } = harness;
  const { state } = harness;
  try {
    const startedIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false });
    const duplicateIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false });
    expect(duplicateIssue).toMatchObject({ workflowId: startedIssue.workflowId, runId: startedIssue.runId, existing: true });
    let issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    for (let attempt = 0; attempt < 20 && issueState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    }
    expect(issueState).toMatchObject({ issueId: "issue-restart", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
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
    expect(revisionRequested).toMatchObject({ phase: "planning", revision: 5, allowedCommands: ["start_planning"], planRevision: null, planMaterial: null });
    const replannedIssue = await executeIssueCommand(config, startedIssue.workflowId, "start_planning", { expectedRevision: 5, actorUserId: "issue-admin" });
    expect(replannedIssue).toMatchObject({ phase: "approval", revision: 9, planRevision: 6, planMaterial: true });
    const approvedIssue = await executeIssueCommand(config, startedIssue.workflowId, "approve_plan", { expectedRevision: 9, actorUserId: "issue-admin", note: "Approve revised plan" });
    expect(approvedIssue).toMatchObject({ phase: "ready_for_development", revision: 10, allowedCommands: ["start_development", "cancel_issue", "revise_plan"], blocker: null });
    const deliveredIssue = await executeIssueCommand(config, startedIssue.workflowId, "start_development", { expectedRevision: 10, actorUserId: "issue-admin" });
    expect(deliveredIssue).toMatchObject({ phase: "delivery_ready", revision: 14, allowedCommands: ["review_delivery", "cancel_issue", "revise_plan"], developerExecutionId: expect.stringMatching(/^developer_[a-f0-9]{24}$/), developerSessionRef: "session_developer_integration", branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40) });
    const repairRequired = await executeIssueCommand(config, startedIssue.workflowId, "review_delivery", { expectedRevision: 14, actorUserId: "issue-admin" });
    expect(repairRequired).toMatchObject({ phase: "repair_required", revision: 18, allowedCommands: ["repair_delivery", "cancel_issue", "revise_plan"], deliveryReviewId: "delivery_review_integration", deliveryReviewOutcome: "blocking", repairCycle: 0 });
    const repairedIssue = await executeIssueCommand(config, startedIssue.workflowId, "repair_delivery", { expectedRevision: 18, actorUserId: "issue-admin" });
    expect(repairedIssue).toMatchObject({ phase: "delivery_ready", revision: 22, allowedCommands: ["review_delivery", "cancel_issue", "revise_plan"], developerExecutionId: "developer_repair_integration", developerSessionRef: "session_developer_integration", resultCommit: "d".repeat(40), repairCycle: 1, deliveryReviewId: null, deliveryReviewOutcome: null });
    const revisedIssue = await reviseIssuePlan(config, startedIssue.workflowId, { expectedRevision: 22, actorUserId: "issue-admin", reason: "The accepted delivery needs a bounded follow-up plan.", worktreeDisposition: "new", exactBaseSha: "a".repeat(40) });
    expect(revisedIssue).toMatchObject({ phase: "planning", revision: 23, revisionRequestId: `revision_${startedIssue.workflowId}_22`, revisedExecutionCoordinates: { disposition: "new", exactBaseSha: "a".repeat(40) } });
    const replannedWithNewCoordinates = await executeIssueCommand(config, startedIssue.workflowId, "start_planning", { expectedRevision: 23, actorUserId: "issue-admin" });
    expect(replannedWithNewCoordinates).toMatchObject({ phase: "approval", revisionRequestId: `revision_${startedIssue.workflowId}_22`, planRevision: 24 });

    const ciContinuation = (issueId: string, extra: Record<string, unknown> = {}) => ({ phase: "ci_waiting" as const, revision: 20, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for required CI", lastEventId: `${issueId}-20`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: new Date().toISOString(), leadSessionRef: "session_ci_lead", leadExecutionId: "agent_ci_lead", leadOutputArtifactId: "artifact_ci_lead_output", deliveryReviewId: `delivery_${issueId}`, planRevision: 1, developerExecutionId: "developer_ci_original", developerSessionRef: "session_ci_developer", worktreePath: join(harness.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_ci_delivery", developerEvidenceArtifactId: "artifact_ci_developer_evidence", releaseId: `release_${issueId}`, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", expectedHeadSha: "b".repeat(40), expectedHeadTree: "c".repeat(40), ciAttempt: 0, ciOutcome: "waiting" as const, ciNextPollAt: null, ...extra });
    const startCiFixture = (issueId: string, extra: Record<string, unknown> = {}) => startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId, projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: ciContinuation(issueId, extra) });
    const waitForPhase = async (fixtureWorkflowId: string, phase: string) => {
      let fixtureState = await queryIssueWorkflow(config, fixtureWorkflowId);
      for (let attempt = 0; attempt < 40 && fixtureState.phase !== phase; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        fixtureState = await queryIssueWorkflow(config, fixtureWorkflowId);
      }
      return fixtureState;
    };

    state.planningMaterial = false;
    const routine = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-routine", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: { ...ciContinuation("ci-routine"), phase: "ready_for_development", revision: 4, owner: "lead", allowedCommands: ["start_development", "cancel_issue", "revise_plan"], pendingAction: "Start development", lastEventId: "ci-routine-4", planMaterial: false, materialCategories: [], releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, developerExecutionId: null, developerSessionRef: null, resultCommit: null, resultTree: null, deliveryArtifactId: null, developerEvidenceArtifactId: null } });
    expect(await executeIssueCommand(config, routine.workflowId, "start_development", { expectedRevision: 4, actorUserId: "issue-admin" })).toMatchObject({ phase: "delivery_ready", planMaterial: false });

    state.planningMaterial = true;
    state.preservedWorktreeCompatibility = false;
    state.revisionDisposition = "reuse";
    const incompatible = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-incompatible", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: { ...ciContinuation("ci-incompatible"), phase: "delivery_ready", revision: 8, owner: "lead", allowedCommands: ["review_delivery", "cancel_issue", "revise_plan"], pendingAction: "Lead delivery review", lastEventId: "ci-incompatible-8" } });
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
    expect(await waitForPhase(ciRepair.workflowId, "delivery_ready")).toMatchObject({ phase: "delivery_ready", developerExecutionId: "developer_ci_repair", developerSessionRef: "session_ci_developer", resultCommit: "d".repeat(40), releaseId: null, ciRunId: null, finalReviewId: null });
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
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-developer-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false, continuationState: { phase: "ready_for_development", revision: 3, owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${developerFailureWorkflowId}:3`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0 } });
    state.developerFailure = true;
    const recoveredDeveloperFailure = await executeIssueCommand(config, developerFailureWorkflowId, "start_development", { expectedRevision: 3, actorUserId: "issue-admin" });
    expect(recoveredDeveloperFailure).toMatchObject({ phase: "delivery_blocked", revision: 7, owner: "human", allowedCommands: ["retry_development", "cancel_issue", "revise_plan"], pendingAction: "The agent invocation did not complete.", developerRecoveryStatus: "failed", developerRecoveryReasonCode: "process-exited" });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = 'issue-developer-failure'").get())).toEqual({ revision: 7, phase: "delivery_blocked", pending_action: "The agent invocation did not complete." });
    state.developerFailure = false;

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
    expect(continuationState).toMatchObject({ workflowId: startedContinuation.workflowId, companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", phase: "ready_for_development", revision: 5, owner: "lead", allowedCommands: ["start_development", "cancel_issue", "revise_plan"], pendingAction: "Start development", lastEventId: `${startedContinuation.workflowId}:5`, continuationCount: 1, lastSummaryHash: null, leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: artifacts.integrationLeadEvidenceArtifactId, leadOutputArtifactId: artifacts.integrationLeadOutputArtifactId, leadOutputKind: "plan", leadSummary: "Integration plan", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false });
    expect(continuationState.decisionId).toMatch(/^decision_/);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const projection = database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get()) as { revision: number } | undefined;
      if (projection?.revision === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get())).toEqual({ revision: 5, phase: "ready_for_development" });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = 'issue-continuation' ORDER BY revision").all())).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }, { revision: 3 }, { revision: 4 }, { revision: 5 }]);
    expect(await new ProjectionRebuildService(database, config).rebuild({ companyId: "issue-company", taskId: "issue-continuation" })).toEqual({ rebuilt: 1, findings: [] });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get())).toEqual({ revision: 5, phase: "ready_for_development" });

  } finally {
    await harness.stop();
  }
}, 120_000);
