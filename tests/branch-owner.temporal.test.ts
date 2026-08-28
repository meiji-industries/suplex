import { expect, test } from "vitest";

import { queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { asNonRetryableApplicationFailure } from "../src/temporal/activities/context.js";
import { WorktreeFailure } from "../src/worktrees.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

function continuation(h: TemporalHarness, issueId: string) {
  return {
    phase: "ready_for_development" as const, revision: 1, owner: "lead" as const,
    allowedCommands: ["start_development" as const, "cancel_issue" as const], pendingAction: "Start development",
    lastEventId: `${issueId}:1`, continuationCount: 0, lastSummaryHash: null, blocker: null,
    stateChangedAt: new Date().toISOString(), planRevision: 1, planMaterial: true, planApproved: true,
    leadSessionRef: "lead-session", leadOutputArtifactId: h.artifacts.integrationLeadOutputArtifactId,
  };
}

async function waitForPhase(h: TemporalHarness, workflowId: string, phase: string) {
  let state = await queryIssueWorkflow(h.config, workflowId);
  for (let attempt = 0; attempt < 120 && state.phase !== phase; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = await queryIssueWorkflow(h.config, workflowId);
  }
  return state;
}

test("a branch checked out elsewhere blocks Developer start without an automatic retry", { timeout: 120_000 }, async () => {
  const h = createTemporalHarness();
  let calls = 0;
  h.activityOverrides.set("runDeveloperExecutionSupervised", async () => {
    calls += 1;
    throw asNonRetryableApplicationFailure(new WorktreeFailure("branch_checked_out", "feat/owned is already checked out by task-owner (/worktrees/task-owner)"));
  });
  await h.start();
  try {
    const started = await startIssueWorkflow(h.config, {
      companyId: "issue-company", projectId: "issue-project", issueId: "branch-owner-start", projectRevisionId: "issue-revision",
      briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: h.issueRoleProfiles,
      supplementalReview: false, continuationState: continuation(h, "branch-owner-start"),
    });
    const blocked = await waitForPhase(h, started.workflowId, "delivery_blocked");
    expect(blocked).toMatchObject({ phase: "delivery_blocked", pendingAction: expect.stringContaining("feat/owned"), blocker: { category: "unsafe_recovery", summary: expect.stringContaining("task-owner") } });
    expect(calls).toBe(1);
    expect(await queryIssueWorkflow(h.config, started.workflowId)).toEqual(blocked);
  } finally { await h.stop(); }
});
