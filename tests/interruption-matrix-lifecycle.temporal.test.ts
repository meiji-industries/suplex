import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { reconcileGithubObservations } from "../src/github-observation-reconciliation.js";
import { runCommand } from "../src/command-runner.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { reconcileWorktrees } from "../src/worktree-reconciliation.js";
import { createTemporalHarness, type TemporalHarness } from "./helpers/temporal-harness.js";

function continuation(h: TemporalHarness, issueId: string, phase: "delivery_blocked" | "development" | "done") {
  const workflowId = `${runtimeIdentifiers(h.config.installationId).workflowPrefix}-issue-${issueId}`;
  return {
    phase,
    revision: 20,
    owner: phase === "delivery_blocked" ? "human" as const : "lead" as const,
    allowedCommands: phase === "done" ? [] : phase === "development" ? ["cancel_development" as const, "cancel_issue" as const] : ["delete_worktree" as const, "cancel_issue" as const],
    pendingAction: phase === "development" ? "Developer execution" : "Worktree recovery",
    lastEventId: `${workflowId}:20`,
    continuationCount: 0,
    lastSummaryHash: null,
    blocker: null,
    stateChangedAt: new Date().toISOString(),
    leadSessionRef: "session_lifecycle_lead",
    leadExecutionId: "agent_lifecycle_lead",
    leadOutputArtifactId: h.artifacts.integrationLeadOutputArtifactId,
    planRevision: 1,
    planMaterial: false,
    planApproved: true,
    materialCategories: [],
    supplementalReviewUsed: false,
    repairCycle: 0,
    developerExecutionId: phase === "development" ? "developer_lifecycle_active" : "developer_lifecycle_prior",
    developerSessionRef: "session_lifecycle_developer",
    developerAttempt: 1,
    worktreePath: join(h.root, "worktrees", issueId),
    branchName: `forge/issue/${issueId}`,
    targetBaseSha: "a".repeat(40),
    resultCommit: "b".repeat(40),
    resultTree: "c".repeat(40),
    dirtyState: "clean" as const,
    deliveryArtifactId: "artifact_lifecycle_delivery",
    developerEvidenceArtifactId: "artifact_lifecycle_evidence",
  };
}

function seedTask(h: TemporalHarness, issueId: string): string {
  const workflowId = `${runtimeIdentifiers(h.config.installationId).workflowPrefix}-issue-${issueId}`;
  const now = new Date().toISOString();
  h.database.authTransaction((db) => db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'issue-company', 'issue-project', ?, 'issue-brief', '[]', ?, 0, ?, 'issue-revision', ?, ?, ?)").run(issueId, `Lifecycle ${issueId}`, JSON.stringify(h.issueRoleProfiles), workflowId, `${issueId}-key`, now, now));
  return workflowId;
}

async function start(h: TemporalHarness, issueId: string, phase: "delivery_blocked" | "development" | "done") {
  const workflowId = seedTask(h, issueId);
  const started = await startIssueWorkflow(h.config, { companyId: "issue-company", projectId: "issue-project", issueId, projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: h.issueRoleProfiles, supplementalReview: false, repairCycleLimit: 0, continuationState: continuation(h, issueId, phase) });
  expect(started.workflowId).toBe(workflowId);
  return workflowId;
}

async function git(cwd: string, ...args: string[]) {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result;
}

async function recordWorktree(h: TemporalHarness, issueId: string, workflowId: string, path: string, repositoryPath: string) {
  h.database.authTransaction((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at, activated_at) VALUES (?, ?, 'issue-company', 'issue-project', ?, ?, ?, ?, ?, ?, 'test-lease', 'active', ?, ?)").run(`worktree-${issueId}`, issueId, workflowId, repositoryPath, h.config.worktreeRoot, path, `forge/issue/${issueId}`, "a".repeat(40), new Date().toISOString(), new Date().toISOString()));
}

test("a worktree is cleaned in forge", async () => {
  const h = createTemporalHarness();
  await h.start();
  try {
    const issueId = "lifecycle-clean";
    const workflowId = await start(h, issueId, "delivery_blocked");
    const repositoryPath = join(h.root, "repo");
    const worktreePath = join(h.config.worktreeRoot, issueId);
    await mkdir(repositoryPath, { recursive: true });
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.email", "matrix@forge.local");
    await git(repositoryPath, "config", "user.name", "Forge Matrix");
    await writeFile(join(repositoryPath, "README.md"), "base\n");
    await git(repositoryPath, "add", "README.md");
    await git(repositoryPath, "commit", "-m", "base");
    await git(repositoryPath, "worktree", "add", worktreePath, "-b", `forge/issue/${issueId}`);
    await writeFile(join(worktreePath, "dirty.txt"), "uncommitted\n");
    await recordWorktree(h, issueId, workflowId, worktreePath, repositoryPath);

    const initial = await queryIssueWorkflow(h.config, workflowId);
    const confirmation = await executeIssueCommand(h.config, workflowId, "delete_worktree", { expectedRevision: initial.revision, actorUserId: "issue-admin" });
    expect(confirmation.blocker).toMatchObject({ category: "unsafe_recovery", actions: expect.arrayContaining([expect.objectContaining({ label: "Discard changes and delete worktree" })]) });
    const cleaned = await executeIssueCommand(h.config, workflowId, "delete_worktree", { expectedRevision: confirmation.revision, actorUserId: "issue-admin", confirmDiscardDirty: true } as never);
    expect(cleaned.worktreeState).toBe("cleaned");
    expect((await git(repositoryPath, "branch", "--list", `forge/issue/${issueId}`)).stdout).toContain(`forge/issue/${issueId}`);
    expect(h.database.authQuery((db) => db.prepare("SELECT event_hash AS eventHash FROM forge_issue_timeline WHERE task_id = ? AND event_type = 'worktree_cleaned'").get(issueId))).toEqual({ eventHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const again = await executeIssueCommand(h.config, workflowId, "delete_worktree", { expectedRevision: cleaned.revision, actorUserId: "issue-admin", confirmDiscardDirty: true } as never);
    expect(again.revision).toBe(cleaned.revision);
    expect(await queryIssueWorkflow(h.config, workflowId)).toEqual(cleaned);
  } finally { await h.stop(); }
});

test("a worktree is deleted outside forge while active and while terminal", async () => {
  const h = createTemporalHarness();
  await h.start();
  try {
    const activeId = "lifecycle-missing-active";
    const activeWorkflow = await start(h, activeId, "delivery_blocked");
    await recordWorktree(h, activeId, activeWorkflow, join(h.config.worktreeRoot, activeId), join(h.root, "repo"));
    expect((await reconcileWorktrees(h.database, h.config, { taskId: activeId, exists: async () => false })).outcomes).toEqual([expect.objectContaining({ status: "removed_externally_active" })]);
    const active = await queryIssueWorkflow(h.config, activeWorkflow);
    expect(active).toMatchObject({ worktreeState: "removed_externally", blocker: { actions: expect.arrayContaining([expect.objectContaining({ label: "Recreate worktree and resume" })]) } });

    const terminalId = "lifecycle-missing-terminal";
    const terminalWorkflow = await start(h, terminalId, "done");
    await recordWorktree(h, terminalId, terminalWorkflow, join(h.config.worktreeRoot, terminalId), join(h.root, "repo"));
    const before = h.database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_issue_timeline WHERE task_id = ?").get(terminalId));
    expect((await reconcileWorktrees(h.database, h.config, { taskId: terminalId, exists: async () => false })).outcomes).toEqual([expect.objectContaining({ status: "removed_externally_terminal" })]);
    const terminal = await queryIssueWorkflow(h.config, terminalWorkflow);
    expect(terminal).toMatchObject({ phase: "done", blocker: null, owner: "lead" });
    const second = await reconcileWorktrees(h.database, h.config, { taskId: terminalId, exists: async () => false });
    expect(second.outcomes).toEqual([expect.objectContaining({ status: "already_recorded" })]);
    expect(h.database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_issue_timeline WHERE task_id = ?").get(terminalId))).toEqual({ count: (before as { count: number }).count + 1 });
  } finally { await h.stop(); }
});

test("cancellation races a late agent result and a webhook", async () => {
  const h = createTemporalHarness();
  await h.start();
  try {
    const issueId = "lifecycle-cancel-race";
    h.state.holdDeveloper = true;
    h.state.developerGate = new Promise<void>((resolve) => { h.state.releaseDeveloper = resolve; });
    const workflowId = await start(h, issueId, "development");
    const starting = await queryIssueWorkflow(h.config, workflowId);
    const cancelled = await executeIssueCommand(h.config, workflowId, "cancel_issue", { expectedRevision: starting.revision, actorUserId: "issue-admin" });
    expect(cancelled.phase).toBe("cancelled");
    h.state.releaseDeveloper();
    h.state.holdDeveloper = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterLateResult = await queryIssueWorkflow(h.config, workflowId);
    expect(afterLateResult).toMatchObject({ phase: "cancelled", branchName: cancelled.branchName, worktreePath: cancelled.worktreePath });
    const execute = async () => { throw new Error("cancelled workflows must not receive GitHub observations"); };
    await reconcileGithubObservations(h.database, h.config, { taskId: issueId, observe: async () => ({ exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: "merged", isDraft: false, headSha: "c".repeat(40), baseSha: "a".repeat(40), mergeable: "MERGEABLE", checks: { total: 1, successful: 1, failing: 0, pending: 0 }, autoMergeEnabled: false, reviewDecision: null }), execute });
    const afterWebhook = await queryIssueWorkflow(h.config, workflowId);
    expect(afterWebhook.revision).toBe(afterLateResult.revision);
    expect(afterWebhook.allowedCommands).toContain("resume_preserved_work");
    expect(h.database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_operation_claims WHERE task_id = ? AND kind = 'push'").get(issueId))).toEqual({ count: 0 });
    const resumed = await executeIssueCommand(h.config, workflowId, "resume_preserved_work", { expectedRevision: afterWebhook.revision, actorUserId: "issue-admin" });
    expect(resumed.phase).toBe("ready_for_development");
  } finally { await h.stop(); }
});
