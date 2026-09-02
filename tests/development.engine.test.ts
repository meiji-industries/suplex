import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";
import { ApplicationFailure } from "../src/engine/failures.js";
import { queryIssueWorkflow, reconcileIssueDeveloperDelivery } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function ready(issueId: string) { return { ...at("ready_for_development"), revision: 1, owner: "lead" as const, allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start development", lastEventId: `${issueId}:1`, continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: "2026-08-29T00:00:00.000Z", planRevision: 1, planApproved: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact" }; }
test("a non-retryable branch ownership failure blocks development once", async () => {
  let calls = 0; const h = await createEngineHarness({ projectIssueState: async (event) => event.state, runDeveloperExecutionSupervised: async () => { calls += 1; throw ApplicationFailure.nonRetryable("feat/owned is already checked out by task-owner (/worktrees/task-owner)", "branch_checked_out"); } }); h.seedTask("branch-owner");
  try { const started = await h.startContinuation("branch-owner", ready("branch-owner")); const blocked = await h.settle(started.workflowId, (state) => isBlocked(state) && state.step === "development"); expect(blocked).toMatchObject({ step: "development", blocker: { category: "unsafe_recovery" } }); expect(calls).toBe(1); }
  finally { await h.stop(); }
});

test("partial developer delivery leaves missing verification for human review", async () => {
  const inputs: unknown[] = [];
  const h = await createEngineHarness({ projectIssueState: async (event) => event.state, runDeveloperExecutionSupervised: async (value) => { inputs.push(value); return { status: "completed" as const, resultHash: engineFixture.sha256, result: { developerExecutionId: value.developerTurnExecutionId, developerSessionRef: "developer-session", branchName: "forge/issue/continuation", targetBaseSha: engineFixture.base, currentStep: 1, resultCommit: "d".repeat(40), resultTree: engineFixture.tree, dirtyState: "clean" as const, deliveryArtifactId: "delivery-1", evidenceArtifactId: "evidence-1", deliverySummary: "Progress", outcome: "blocked" as const, steps: [{ number: 1, status: "completed" as const }, { number: 2, status: "incomplete" as const }], authorizedStepsNotCompleted: [2], blocker: null } }; } }); h.seedTask("continuation");
  try { const started = await h.startContinuation("continuation", ready("continuation")); const incomplete = await h.settle(started.workflowId, (state) => state.step === "delivery_ready" && state.pendingAction === "Verification incomplete"); expect(inputs).toHaveLength(1); expect(incomplete).toMatchObject({ owner: "human", allowedCommands: ["repair_delivery", "review_delivery", "cancel_issue"], blocker: null, developerContinuation: null }); }
  finally { await h.stop(); }
});

test("reconnecting a Developer execution preserves its superseded execution", async () => {
  const inputs: unknown[] = [];
  const currentExecutionId = "developer-current";
  const priorExecutionId = "developer-prior";
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    findRecoverableDeveloperExecution: async () => ({ executionId: currentExecutionId, planRevision: 2, attempt: 4, sessionRef: "developer-session", worktreePath: "/worktrees/recovery", branchName: "forge/issue/recovery", targetBaseSha: engineFixture.base, supersedesExecutionId: priorExecutionId }),
    runDeveloperExecutionSupervised: async (value) => {
      inputs.push(value);
      return { status: "completed", resultHash: engineFixture.sha256, result: { developerExecutionId: value.developerTurnExecutionId, developerSessionRef: "developer-session", branchName: "forge/issue/recovery", targetBaseSha: engineFixture.base, currentStep: 1, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean", deliveryArtifactId: "delivery", evidenceArtifactId: "evidence", deliverySummary: "Recovered", outcome: "completed" } };
    },
  });
  h.seedTask("recovery-identity");
  try {
    const blocked = { ...ready("recovery-identity"), ...at("development"), revision: 20, owner: "human" as const, allowedCommands: ["retry_development" as const, "cancel_issue" as const], developerExecutionId: currentExecutionId, developerAttempt: 4, developerSessionRef: "developer-session" };
    const started = await h.startContinuation("recovery-identity", blocked);
    const current = await queryIssueWorkflow(h.config, started.workflowId);
    await reconcileIssueDeveloperDelivery(h.config, started.workflowId, { expectedRevision: current.revision, actorUserId: "system", commandId: "recover-current", reconcileOnly: true });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ developerTurnExecutionId: currentExecutionId, developerAttempt: 4, supersedesExecutionId: priorExecutionId });
  } finally { await h.stop(); }
});
