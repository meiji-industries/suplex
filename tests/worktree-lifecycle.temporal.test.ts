import { join } from "node:path";

import { expect, test } from "vitest";

import { queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { executeWorktreeCommand } from "../src/temporal/worktree-commands.js";
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
    const deleted = await executeWorktreeCommand(harness.config, started.workflowId, "delete_worktree", { expectedRevision: initial.revision, actorUserId: "issue-admin" });
    expect(deleted).toMatchObject({ worktreeState: "cleaned" });
    expect(deleted.allowedCommands).toContain("recreate_worktree");
    expect(deleted.allowedCommands).not.toContain("delete_worktree");
    expect(await executeWorktreeCommand(harness.config, started.workflowId, "delete_worktree", { expectedRevision: deleted.revision, actorUserId: "issue-admin" })).toEqual(deleted);
  } finally {
    await harness.stop();
  }
});

test("a done task without a projected path can delete its recorded worktree", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  try {
    harness.activityOverrides.set("cleanupTaskWorktree", async () => ({ outcome: "cleaned" }));
    const started = await startIssueWorkflow(harness.config, {
      companyId: "issue-company", projectId: "issue-project", issueId: "terminal-worktree", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false,
      continuationState: { phase: "done", revision: 20, owner: "human", allowedCommands: [], pendingAction: "Done", lastEventId: "terminal-worktree:20", continuationCount: 0, lastSummaryHash: null, activeOperation: null, worktreePath: null, worktreeState: null, branchName: "forge/issue/terminal-worktree", targetBaseSha: "a".repeat(40) },
    });
    const initial = await queryIssueWorkflow(harness.config, started.workflowId);
    expect(initial.allowedCommands).toContain("delete_worktree");
    const deleted = await executeWorktreeCommand(harness.config, started.workflowId, "delete_worktree", { expectedRevision: initial.revision, actorUserId: "issue-admin" });
    expect(deleted).toMatchObject({ worktreeState: "cleaned", pendingAction: "Archived" });
  } finally {
    await harness.stop();
  }
});

test("worktree deletion reports an ownership failure", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  try {
    harness.activityOverrides.set("cleanupTaskWorktree", async () => ({ outcome: "not_owned", dirtyFileCount: 0 }));
    const started = await startIssueWorkflow(harness.config, {
      companyId: "issue-company", projectId: "issue-project", issueId: "unowned-worktree", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: harness.issueRoleProfiles, supplementalReview: false,
      continuationState: { phase: "done", revision: 20, owner: "human", allowedCommands: [], pendingAction: "Done", lastEventId: "unowned-worktree:20", continuationCount: 0, lastSummaryHash: null, activeOperation: null, worktreePath: null, worktreeState: null, branchName: "forge/issue/unowned-worktree", targetBaseSha: "a".repeat(40) },
    });
    const initial = await queryIssueWorkflow(harness.config, started.workflowId);
    await expect(executeWorktreeCommand(harness.config, started.workflowId, "delete_worktree", { expectedRevision: initial.revision, actorUserId: "issue-admin" })).rejects.toThrow(/does not own/);
  } finally {
    await harness.stop();
  }
});
