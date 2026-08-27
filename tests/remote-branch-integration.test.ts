import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { integrateRemoteBranch } from "../src/remote-branch-integration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-remote-branch-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const worktreePath = join(root, "worktrees", "task");
  const peer = join(root, "peer");
  await git(root, "init", "--bare", origin);
  await git(root, "init", "-b", "main", source);
  for (const path of [source]) { await git(path, "config", "user.email", "test@example.invalid"); await git(path, "config", "user.name", "Forge Test"); }
  await writeFile(join(source, "README.md"), "base\n"); await git(source, "add", "README.md"); await git(source, "commit", "-m", "base");
  await git(source, "remote", "add", "origin", origin); await git(source, "switch", "-c", "forge/task"); await git(source, "push", "-u", "origin", "forge/task");
  await git(root, "clone", origin, worktreePath); await git(worktreePath, "switch", "forge/task"); await git(worktreePath, "config", "user.email", "test@example.invalid"); await git(worktreePath, "config", "user.name", "Forge Test");
  await git(root, "clone", origin, peer); await git(peer, "switch", "forge/task"); await git(peer, "config", "user.email", "test@example.invalid"); await git(peer, "config", "user.name", "Forge Test");
  const config = createTestConfig(root, { worktreeRoot: join(root, "worktrees") });
  const database = new ForgeDatabase(config.databasePath);
  database.authQuery((db) => db.pragma("foreign_keys = OFF"));
  database.authTransaction((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES ('worktree', 'task', 'company', 'project', 'workflow', ?, ?, ?, 'forge/task', ?, 'lease', 'active', ?)").run(source, config.worktreeRoot, worktreePath, "a".repeat(40), new Date().toISOString()));
  return { config, database, peer, worktreePath };
}

async function integrate(value: Awaited<ReturnType<typeof fixture>>, remoteHead: string) {
  return integrateRemoteBranch(value.database, value.config, { taskId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge", branchName: "forge/task", remoteHead, worktreePath: value.worktreePath, targetBaseSha: "a".repeat(40) });
}

test("does not run git for an unowned remote task branch", async () => {
  let ran = false;
  const database = { authQuery: (query: (db: { prepare: () => { get: () => unknown } }) => unknown) => query({ prepare: () => ({ get: () => undefined }) }) };
  const result = await integrateRemoteBranch(database as never, { worktreeRoot: "/worktrees" } as never, {
    taskId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge", branchName: "forge/task", remoteHead: "a".repeat(40), worktreePath: "/worktrees/task", targetBaseSha: null,
  }, { git: async () => { ran = true; return { ok: true, stdout: "", stderr: "" }; } });
  expect(result).toEqual({ kind: "not_owned" });
  expect(ran).toBe(false);
});

test("fast-forwards a clean owned branch and records the idempotent integration", async () => {
  const value = await fixture();
  await writeFile(join(value.peer, "REMOTE.md"), "remote\n"); await git(value.peer, "add", "REMOTE.md"); await git(value.peer, "commit", "-m", "remote");
  const remoteHead = await git(value.peer, "rev-parse", "HEAD"); await git(value.peer, "push", "origin", "forge/task");

  await expect(integrate(value, remoteHead)).resolves.toEqual({ kind: "fast_forwarded", from: expect.any(String), to: remoteHead });
  expect(await git(value.worktreePath, "rev-parse", "HEAD")).toBe(remoteHead);
  await expect(integrate(value, remoteHead)).resolves.toEqual({ kind: "fast_forwarded", from: expect.any(String), to: remoteHead });
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE event_type = 'remote_branch_integrated'").get())).toEqual({ count: 1 });
});

test("aborts a remote conflict and persists its evidence", async () => {
  const value = await fixture();
  await writeFile(join(value.worktreePath, "README.md"), "local\n"); await git(value.worktreePath, "commit", "-am", "local");
  await writeFile(join(value.peer, "README.md"), "remote\n"); await git(value.peer, "commit", "-am", "remote");
  const remoteHead = await git(value.peer, "rev-parse", "HEAD"); await git(value.peer, "push", "origin", "forge/task");

  const result = await integrate(value, remoteHead);
  expect(result).toMatchObject({ kind: "conflict", remoteHead, forwardMergeId: expect.any(String), conflictArtifactId: expect.any(String), conflictFileCount: 1 });
  expect(await git(value.worktreePath, "status", "--porcelain")).toBe("");
  expect((await runCommand({ taskId: null, stepId: null, command: "git", args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd: value.worktreePath })).exitCode).toBe(1);
  expect(value.database.authQuery((db) => db.prepare("SELECT status, conflict_file_count AS conflictFileCount FROM forge_forward_merges").get())).toEqual({ status: "conflict", conflictFileCount: 1 });
  expect(value.database.authQuery((db) => db.prepare("SELECT event_hash AS eventHash FROM forge_issue_timeline WHERE event_type = 'remote_branch_conflict'").get())).toEqual({ eventHash: expect.any(String) });
});
