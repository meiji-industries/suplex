import { join } from "node:path";
import { expect, test } from "vitest";
import { queryIssueWorkflow, startIssueWorkflow } from "../src/engine/service.js";
import { executeWorktreeCommand } from "../src/engine/worktree-commands.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("workflow identity dedupes, worktree governance persists across host restart", async () => {
  const h = await createEngineHarness(); h.seedTask("recovery");
  h.activities.projectIssueState = async (event) => { h.database.projectIssueEvent(event); h.database.observeIssueProjection(event); return event.state; };
  h.activities.cleanupTaskWorktree = async () => ({ outcome: "cleaned", dirtyFileCount: 0, evidenceArtifactId: "cleanup-evidence" });
  const input = { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "recovery", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState: { phase: "delivery_blocked" as const, revision: 20, owner: "human" as const, allowedCommands: ["retry_development" as const, "cancel_issue" as const], pendingAction: "Developer retry is available", lastEventId: "recovery:20", continuationCount: 0, lastSummaryHash: null, activeOperation: null, worktreePath: join(h.root, "worktrees", "recovery"), worktreeState: "present" as const, branchName: "forge/issue/recovery", targetBaseSha: engineFixture.base } };
  try {
    const first = await h.startContinuation("recovery", input.continuationState); const duplicate = await startIssueWorkflow(h.config, input);
    expect(duplicate).toMatchObject({ workflowId: first.workflowId, runId: first.runId, existing: true });
    const initial = await queryIssueWorkflow(h.config, first.workflowId); expect(initial.allowedCommands).toContain("delete_worktree");
    const deleted = await executeWorktreeCommand(h.config, first.workflowId, "delete_worktree", { expectedRevision: initial.revision, actorUserId: engineFixture.actorUserId });
    expect(deleted).toMatchObject({ worktreeState: "cleaned" }); expect(deleted.allowedCommands).toContain("recreate_worktree");
    await h.restart(); const recovered = await queryIssueWorkflow(h.config, first.workflowId);
    expect(recovered).toMatchObject({ revision: deleted.revision + 1, phase: "delivery_blocked", worktreeState: "cleaned" });
    expect(h.engine.run(first.workflowId).runId).not.toBe(first.runId);
  } finally { await h.stop(); }
});

test("service command result is deduplicated by command id", async () => {
  const h = await createEngineHarness(); h.seedTask("dedupe"); h.activities.projectIssueState = async (event) => event.state;
  try {
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "dedupe", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false });
    await h.settle(started.workflowId, () => (h.calls.get("projectIssueState") ?? 0) > 0);
    const command = { expectedRevision: 0, actorUserId: engineFixture.actorUserId, commandId: "cancel-once" };
    const first = await h.engine.run(started.workflowId).execute("cancelIssue", command, command.commandId);
    const second = await h.engine.run(started.workflowId).execute("cancelIssue", command, command.commandId);
    expect(second).toEqual(first); expect(first).toMatchObject({ phase: "cancelled" });
    expect(h.database.authQuery((db) => (db.prepare("SELECT count(*) count FROM forge_engine_commands WHERE command_id = 'cancel-once'").get() as { count: number }).count)).toBe(1);
  } finally { await h.stop(); }
});
