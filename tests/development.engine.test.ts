import { expect, test } from "vitest";
import { ApplicationFailure } from "../src/engine/failures.js";
import { executeIssueCommand, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function ready(issueId: string) { return { phase: "ready_for_development" as const, revision: 1, owner: "lead" as const, allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start development", lastEventId: `${issueId}:1`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: "2026-08-29T00:00:00.000Z", planRevision: 1, planMaterial: true, planApproved: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact" }; }
function input(issueId: string, continuationState: ReturnType<typeof ready>) { return { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState }; }

test("a non-retryable branch ownership failure blocks development once", async () => {
  let calls = 0; const h = await createEngineHarness({ projectIssueState: async (event) => event.state, runDeveloperExecutionSupervised: async () => { calls += 1; throw ApplicationFailure.nonRetryable("feat/owned is already checked out by task-owner (/worktrees/task-owner)", "branch_checked_out"); } }); h.seedTask("branch-owner");
  try { const started = await startIssueWorkflow(h.config, input("branch-owner", ready("branch-owner"))); const blocked = await h.settle(started.workflowId, (state) => state.phase === "delivery_blocked"); expect(blocked).toMatchObject({ phase: "delivery_blocked", blocker: { category: "unsafe_recovery" } }); expect(calls).toBe(1); }
  finally { await h.stop(); }
});

test("partial developer delivery continues from remaining steps", async () => {
  const inputs: unknown[] = []; let attempt = 0;
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, runDeveloperExecutionSupervised: async (value) => { inputs.push(value); attempt += 1; const remaining = attempt === 1 ? [2, 3, 4, 5, 6, 7, 8] : []; const common = { developerExecutionId: value.developerTurnExecutionId, developerSessionRef: "developer-session", branchName: "forge/issue/continuation", targetBaseSha: engineFixture.base, currentStep: attempt, resultCommit: attempt === 1 ? "d".repeat(40) : engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean" as const, deliveryArtifactId: `delivery-${attempt}`, evidenceArtifactId: `evidence-${attempt}`, deliverySummary: "Progress", outcome: attempt === 1 ? "blocked" as const : "completed" as const, steps: [{ number: 1, status: "completed" as const }, ...remaining.map((number) => ({ number, status: "incomplete" as const }))], authorizedStepsNotCompleted: remaining, blocker: null }; return { status: "completed" as const, resultHash: engineFixture.sha256, result: common }; } }); h.seedTask("continuation");
  try { const started = await startIssueWorkflow(h.config, input("continuation", ready("continuation"))); await executeIssueCommand(h.config, started.workflowId, "start_development", { expectedRevision: 1, actorUserId: engineFixture.actorUserId }); const blocked = await h.settle(started.workflowId, (state) => state.phase === "delivery_blocked"); expect(inputs).toHaveLength(2); expect(inputs[1]).toMatchObject({ continuation: { remainingSteps: [2, 3, 4, 5, 6, 7, 8], previousCommit: "d".repeat(40) } }); expect(blocked.developerContinuation).toBeNull(); }
  finally { await h.stop(); }
});
