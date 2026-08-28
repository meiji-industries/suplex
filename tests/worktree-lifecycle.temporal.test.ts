import { join } from "node:path";

import { expect, test } from "vitest";

import { executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness } from "./helpers/temporal-harness.js";

test("a task parked in delivery_blocked offers delete then recreate worktree", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  try {
    harness.activityOverrides.set("cleanupTaskWorktree", async () => ({ outcome: "cleaned", evidenceArtifactId: "worktree-cleanup-evidence" }));
    const started = await startIssueWorkflow(harness.config, {
      companyId: "issue-company", projectId: "issue-project", issueId: "worktree-lifecycle", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false,
      continuationState: { phase: "delivery_blocked", revision: 20, owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer retry is available", lastEventId: "worktree-lifecycle:20", continuationCount: 0, lastSummaryHash: null, activeOperation: null, worktreePath: join(harness.root, "worktrees", "worktree-lifecycle"), worktreeState: "present", branchName: "forge/issue/worktree-lifecycle", targetBaseSha: "a".repeat(40) },
    });
    const initial = await queryIssueWorkflow(harness.config, started.workflowId);
    expect(initial.allowedCommands).toContain("delete_worktree");
    const deleted = await executeIssueCommand(harness.config, started.workflowId, "delete_worktree", { expectedRevision: initial.revision });
    expect(deleted).toMatchObject({ worktreeState: "cleaned" });
    expect(deleted.allowedCommands).toContain("recreate_worktree");
    expect(deleted.allowedCommands).not.toContain("delete_worktree");
    expect(await executeIssueCommand(harness.config, started.workflowId, "delete_worktree", { expectedRevision: deleted.revision })).toEqual(deleted);
  } finally {
    await harness.stop();
  }
});
