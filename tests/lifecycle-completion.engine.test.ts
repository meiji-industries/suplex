import { join } from "node:path";
import { expect, test } from "vitest";
import { ProjectionRebuildService } from "../src/projection-rebuild.js";
import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { continueIssueWork, executeIssueCommand, queryIssueWorkflow, recoverClosedProjection, rejectIssuePlan, resyncIssueProjection, resolveIssueDecisionBlocker, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture, type EngineHarness } from "./helpers/engine-harness.js";

const sha = "9".repeat(64), nextBase = "d".repeat(40), mergedHead = "e".repeat(40), mergedTree = "f".repeat(40);
const input = (issueId: string, continuationState: IssueWorkflowInput["continuationState"], extra: Partial<IssueWorkflowInput> = {}) => ({ companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState, ...extra });
const baseState = (h: EngineHarness, issueId: string, phase: IssueWorkflowState["phase"], revision = 20) => ({ phase, revision, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: phase, lastEventId: `${issueId}:${revision}`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: new Date(h.clock.now()).toISOString() });

test("plan rejection revises, a planner decision blocker resolves, and a done task continues", async () => {
  let plans = 0;
  const plan = (material = true) => ({ leadExecutionId: `lead-${++plans}`, leadSessionRef: "lead-session", leadOutputArtifactId: `plan-${plans}`, leadEvidenceArtifactId: `evidence-${plans}`, leadOutputArtifactSha256: sha, leadOutputKind: "plan" as const, leadSummary: "Revised plan", materialCategories: material ? ["security_permissions" as const] : [], material });
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    recordPlanDecision: async () => ({ decisionId: `decision-${plans}`, noteArtifactId: "revision-note" }),
    runLeadPlanning: async () => plan(true),
    recordDecisionBlockerResolution: async () => ({ resolutionId: "resolution-1" }),
    createSuccessor: async (value) => ({ successorTaskId: value.successorTaskId, successorWorkflowId: value.successorWorkflowId, predecessorTaskId: value.predecessorTaskId, projectRevisionId: engineFixture.projectRevisionId, creationRevision: value.acceptedRevision }),
  });
  for (const id of ["governance", "blocker", "continued"]) h.seedTask(id);
  try {
    const approval = { ...baseState(h, "governance", "approval", 4), owner: "human" as const, allowedCommands: ["approve_plan" as const, "reject_plan" as const, "cancel_issue" as const], planRevision: 1, planMaterial: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-original" };
    const governed = await startIssueWorkflow(h.config, input("governance", approval));
    const rejected = await rejectIssuePlan(h.config, governed.workflowId, { expectedRevision: 4, actorUserId: engineFixture.actorUserId, note: "Address the boundary" });
    expect(rejected).toMatchObject({ phase: "planning", planRevision: null, planMaterial: null });
    const revised = await executeIssueCommand(h.config, governed.workflowId, "start_planning", { expectedRevision: rejected.revision, actorUserId: engineFixture.actorUserId });
    expect(revised).toMatchObject({ phase: "approval", planMaterial: true, leadSummary: "Revised plan" });
    expect(await executeIssueCommand(h.config, governed.workflowId, "approve_plan", { expectedRevision: revised.revision, actorUserId: engineFixture.actorUserId })).toMatchObject({ phase: "ready_for_development", planApproved: true });

    const blocked = { ...baseState(h, "blocker", "blocked", 7), owner: "human" as const, allowedCommands: ["resolve_decision_blocker" as const, "cancel_issue" as const], blockedCategory: "human_decision" as const, blockedResumePhase: "planning" as const, blockerArtifactId: "blocker-artifact", leadSessionRef: "lead-session" };
    const blocker = await startIssueWorkflow(h.config, input("blocker", blocked));
    expect(await resolveIssueDecisionBlocker(h.config, blocker.workflowId, { expectedRevision: 7, actorUserId: engineFixture.actorUserId, answerArtifactId: "answer-artifact" })).toMatchObject({ phase: "approval", blockerResolutionId: "resolution-1", leadSessionRef: "lead-session" });

    const done = { ...baseState(h, "continued", "done", 9), owner: "human" as const, allowedCommands: ["continue_work" as const], pendingAction: "Done" };
    const terminal = await startIssueWorkflow(h.config, input("continued", done));
    const continued = await continueIssueWork(h.config, terminal.workflowId, { expectedRevision: 9, actorUserId: engineFixture.actorUserId, reason: "Follow-up" });
    expect(continued).toMatchObject({ phase: "done", revision: 10, allowedCommands: [], successorTaskId: "continued-successor-9", successorReference: { predecessorTaskId: "continued" } });
  } finally { await h.stop(); }
});

test("cancelling a queued Developer turn prevents its start and retry starts exactly one", async () => {
  let starts = 0;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    runDeveloperExecutionSupervised: async (value) => { starts += 1; return { status: "completed", resultHash: sha, result: { developerExecutionId: value.developerTurnExecutionId, developerSessionRef: "developer-session", branchName: "forge/issue/queued", targetBaseSha: engineFixture.base, currentStep: 1, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean", deliveryArtifactId: "delivery", evidenceArtifactId: "evidence", deliverySummary: "Done", outcome: "completed" } }; },
    cancelDeveloperExecution: async () => ({ status: "cancelled_confirmed", executionId: "queued-execution", exitCode: null, exitSignal: null, evidenceArtifactId: null }),
  });
  h.seedTask("queued");
  try {
    const activeState = { ...baseState(h, "queued", "development", 2), allowedCommands: ["cancel_development" as const, "cancel_issue" as const], planRevision: 1, planMaterial: true, planApproved: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan", developerExecutionId: "queued-execution", developerAttempt: 1 };
    const started = await startIssueWorkflow(h.config, input("queued", activeState));
    const active = await queryIssueWorkflow(h.config, started.workflowId);
    const cancelled = await executeIssueCommand(h.config, started.workflowId, "cancel_development", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-queued" });
    expect(cancelled).toMatchObject({ phase: "delivery_blocked", developerRecoveryStatus: "cancelled" });
    expect(starts).toBe(0);
    const retried = await executeIssueCommand(h.config, started.workflowId, "retry_development", { expectedRevision: cancelled.revision, actorUserId: engineFixture.actorUserId });
    expect(["delivery_ready", "reviewing_delivery"]).toContain(retried.phase); expect(starts).toBe(1); expect(h.calls.get("runDeveloperExecutionSupervised")).toBe(1);
  } finally { await h.stop(); }
});

test("projection rebuild replaces a lagged projection with the latest engine snapshot", async () => {
  const h = await createEngineHarness(); h.seedTask("rebuild"); h.activities.projectIssueState = async (event) => { h.database.projectIssueEvent(event); h.database.observeIssueProjection(event); return event.state; };
  try {
    const started = await startIssueWorkflow(h.config, input("rebuild", undefined));
    const cancelled = await executeIssueCommand(h.config, started.workflowId, "cancel_issue", { expectedRevision: 0, actorUserId: engineFixture.actorUserId });
    h.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET revision=0, authoritative_revision=0, phase='backlog' WHERE task_id='rebuild'").run());
    expect(await new ProjectionRebuildService(h.database, h.config).rebuild({ taskId: "rebuild" })).toEqual({ rebuilt: 1, findings: [] });
    expect(h.database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id='rebuild'").get())).toEqual({ revision: cancelled.revision, phase: "cancelled" });
  } finally { await h.stop(); }
});

for (const branch of ["mechanical", "human"] as const) test(`release conflict chain resolves the ${branch} branch and republishes`, async () => {
  let plans = 0, publishes = 0; const phases: string[] = [];
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { phases.push(event.state.phase); return event.state; },
    planMergeConflict: async () => ++plans === 1 && branch === "human"
      ? { disposition: "product_decision", planId: "conflict-plan", planArtifactId: "conflict-plan-artifact", evidenceArtifactId: "conflict-evidence", leadExecutionId: "integrator-plan", leadSessionRef: "lead-session", summary: "Choose behavior", question: "Which behavior?", choices: [{ id: "keep", label: "Keep", detail: "Keep both" }, { id: "replace", label: "Replace", detail: "Use upstream" }], recommendedChoiceId: "keep" }
      : { disposition: "mechanical", planId: "conflict-plan", planArtifactId: "conflict-plan-artifact", evidenceArtifactId: "conflict-evidence", leadExecutionId: "integrator-plan", leadSessionRef: "lead-session", summary: "Keep both" },
    recordPlannerNote: async () => ({ noteId: "note", createdAt: new Date().toISOString() }),
    resolveMergeConflictSupervised: async () => ({ status: "completed", resultHash: sha, result: { developerExecutionId: "developer-resolution", developerSessionRef: "developer-session", resultCommit: mergedHead, resultTree: mergedTree, deliveryArtifactId: "merged-delivery", deliveryArtifactSha256: sha, evidenceArtifactId: "merged-evidence", evidenceArtifactSha256: sha, verificationArtifactId: "verification", verificationArtifactSha256: sha, summary: "Resolved" } }),
    reviewDelivery: async (value) => ({ outcome: "completed", attemptId: "review-attempt", correctionAttempts: 0, subject: value.subject, review: { reviewId: "review-new", leadExecutionId: "lead-review", leadSessionRef: "lead-session", opinionArtifactId: "opinion", evidenceArtifactId: "review-evidence", opinion: "approved", summary: "Approved", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: sha, byteSize: 1, mimeType: "application/json" } } }),
    reconcileTargetBase: async (value) => ({ outcome: "no_drift", checkId: `check-${value.checkpoint}`, checkpoint: value.checkpoint, expectedBaseSha: value.expectedBaseSha, observedBaseSha: value.expectedBaseSha, headSha: value.expectedHeadSha, headTree: value.expectedHeadTree }),
    pushDeliveryBranch: async (value) => ({ repository: "acme/forge", branchName: value.branchName, commitSha: value.commitSha }),
    publishRelease: async () => ({ outcome: "completed", releaseId: `release-${++publishes}`, repository: "acme/forge", branchName: "forge/issue/conflict", baseBranch: "main", headSha: mergedHead, headTree: mergedTree, pullRequestNumber: 42, pullRequestUrl: "https://github.test/42", isDraft: false, reused: false, attempt: publishes, targetBaseSha: nextBase }),
  };
  const h = await createEngineHarness(activities); const issueId = `conflict-${branch}`; h.seedTask(issueId, { deliveryTarget: "merged" });
  try {
    const conflict = { ...baseState(h, issueId, "merge_conflict_required", 20), allowedCommands: ["resolve_merge_conflict" as const, "cancel_issue" as const], leadSessionRef: "lead-session", leadOutputArtifactId: "plan", planRevision: 1, developerExecutionId: "developer-original", developerSessionRef: "developer-session", worktreePath: join(h.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean" as const, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "evidence", deliveryReviewId: "review-old", forwardMergeId: "forward", forwardMergePriorHead: engineFixture.commit, forwardMergePriorTree: engineFixture.tree, forwardMergeTargetBaseSha: nextBase, forwardMergeConflictArtifact: { id: "conflict", kind: "forward-merge-conflict" as const }, forwardMergeConflictFileCount: 1 };
    const started = await startIssueWorkflow(h.config, input(issueId, conflict, { deliveryTarget: "merged", pullRequestMode: "ready" }));
    let result = await h.settle(started.workflowId, (state) => branch === "human" ? state.phase === "merge_conflict_required" && state.owner === "human" : state.phase === "delivery_ready");
    if (branch === "human") {
      expect(result).toMatchObject({ phase: "merge_conflict_required", owner: "human", mergeDecision: { question: "Which behavior?" } });
      result = await executeIssueCommand(h.config, started.workflowId, "send_planner_note", { expectedRevision: result.revision, actorUserId: engineFixture.actorUserId, note: "Keep both", commandId: "decision-note" });
    }
    if (result.phase !== "delivery_ready") result = await h.settle(started.workflowId, (state) => state.phase === "delivery_ready");
    const reviewed = await executeIssueCommand(h.config, started.workflowId, "review_delivery", { expectedRevision: result.revision, actorUserId: engineFixture.actorUserId });
    if (reviewed.phase === "delivery_reviewed") await executeIssueCommand(h.config, started.workflowId, "publish_draft", { expectedRevision: reviewed.revision, actorUserId: engineFixture.actorUserId });
    const waiting = await h.settle(started.workflowId, (state) => state.phase === "ci_waiting");
    expect(waiting).toMatchObject({ phase: "ci_waiting", targetBaseSha: nextBase, resultCommit: mergedHead, resultTree: mergedTree });
    expect(phases).toEqual(expect.arrayContaining(["merge_conflict_reviewing", "merge_conflict_resolving", "delivery_ready", "releasing", "ci_waiting"]));
    expect(publishes).toBe(1); expect(plans).toBe(branch === "human" ? 2 : 1); void result;
  } finally { await h.stop(); }
});

const restartCases = {
  lifecycle: ["development", "delivery_blocked", "done"],
  repair: ["delivery_ready", "repair_required", "delivery_blocked"],
  merge: ["merge_conflict_required", "merge_conflict_reviewing", "merge_conflict_resolving"],
} as const;
for (const [matrix, phases] of Object.entries(restartCases)) test(`interruption matrix: ${matrix}`, async () => {
  for (const [index, phase] of phases.entries()) {
    const issueId = `${matrix}-${index}`; const h = await createEngineHarness({ projectIssueState: async (event) => { h.database.projectIssueEvent(event); h.database.observeIssueProjection(event); return event.state; } }); h.seedTask(issueId);
    try {
      const terminal = phase === "done"; const state = { ...baseState(h, issueId, phase as IssueWorkflowState["phase"], 20), owner: terminal ? "human" as const : "lead" as const, allowedCommands: terminal ? [] : ["cancel_issue" as const], ...(phase === "development" ? { developerExecutionId: "developer", developerSessionRef: "session" } : {}), ...(String(phase).startsWith("merge_conflict") ? { leadSessionRef: "lead", leadOutputArtifactId: "plan", developerExecutionId: "developer", developerSessionRef: "session", worktreePath: join(h.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, forwardMergeId: "forward", forwardMergePriorHead: engineFixture.commit, forwardMergePriorTree: engineFixture.tree, forwardMergeTargetBaseSha: nextBase, forwardMergeConflictArtifact: { id: "conflict", kind: "forward-merge-conflict" as const }, forwardMergeConflictFileCount: 1 } : {}) };
      const started = await startIssueWorkflow(h.config, input(issueId, state));
      await resyncIssueProjection(h.config, started.workflowId, { expectedRevision: 20, actorUserId: engineFixture.actorUserId, commandId: `persist-${issueId}` });
      await h.restart();
      const resumed = terminal ? await recoverClosedProjection(h.config, started.workflowId) : await queryIssueWorkflow(h.config, started.workflowId); expect(resumed).toMatchObject({ phase, revision: 20 });
      if (!terminal) expect(await executeIssueCommand(h.config, started.workflowId, "cancel_issue", { expectedRevision: 20, actorUserId: engineFixture.actorUserId })).toMatchObject({ phase: "cancelled" });
      else expect(resumed.phase).toBe("done");
    } finally { await h.stop(); }
  }
});

test("failed merge-resolution turns retain the last persisted Developer ID across retries", async () => {
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    resolveMergeConflictSupervised: async (value) => ({ status: "failed" as const, developerExecutionId: value.developerTurnExecutionId, reasonCode: "merge-resolution-incomplete", summary: "Resolution failed", evidenceArtifactId: "evidence" }),
  });
  const issueId = "merge-prior-id";
  h.seedTask(issueId);
  try {
    const state = { ...baseState(h, issueId, "merge_conflict_required", 20), allowedCommands: ["resolve_merge_conflict" as const, "cancel_issue" as const], leadSessionRef: "lead-session", leadOutputArtifactId: "plan", planRevision: 1, mergeResolutionPlanArtifactId: "conflict-plan", developerExecutionId: "developer-persisted", developerSessionRef: "developer-session", worktreePath: join(h.root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean" as const, forwardMergeId: "forward", forwardMergePriorHead: engineFixture.commit, forwardMergePriorTree: engineFixture.tree, forwardMergeTargetBaseSha: nextBase, forwardMergeConflictArtifact: { id: "conflict", kind: "forward-merge-conflict" as const }, forwardMergeConflictFileCount: 1 };
    const started = await startIssueWorkflow(h.config, input(issueId, state));
    let result = await h.settle(started.workflowId, (value) => value.phase === "merge_conflict_required" && value.owner === "human");
    expect(result.developerExecutionId).toBe("developer-persisted");
    result = await executeIssueCommand(h.config, started.workflowId, "resolve_merge_conflict", { expectedRevision: result.revision, actorUserId: engineFixture.actorUserId });
    result = await h.settle(started.workflowId, (value) => value.phase === "merge_conflict_required" && value.owner === "human");
    expect(result.developerExecutionId).toBe("developer-persisted");
  } finally { await h.stop(); }
});
