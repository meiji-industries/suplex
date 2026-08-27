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

async function integrate(value: Awaited<ReturnType<typeof fixture>>, remoteHead: string, deps?: Parameters<typeof integrateRemoteBranch>[3]) {
  return integrateRemoteBranch(value.database, value.config, { taskId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge", branchName: "forge/task", remoteHead, worktreePath: value.worktreePath, targetBaseSha: "a".repeat(40) }, deps);
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

test("up_to_date", async () => {
  const value = await fixture();
  const remoteHead = await git(value.worktreePath, "rev-parse", "HEAD");

  await expect(integrate(value, remoteHead)).resolves.toEqual({ kind: "up_to_date", head: remoteHead });
  await expect(integrate(value, remoteHead)).resolves.toEqual({ kind: "up_to_date", head: remoteHead });
});

test("merged", async () => {
  const value = await fixture();
  await writeFile(join(value.worktreePath, "LOCAL.md"), "local\n");
  await git(value.worktreePath, "add", "LOCAL.md");
  await git(value.worktreePath, "commit", "-m", "local");
  await writeFile(join(value.peer, "REMOTE.md"), "remote\n");
  await git(value.peer, "add", "REMOTE.md");
  await git(value.peer, "commit", "-m", "remote");
  const remoteHead = await git(value.peer, "rev-parse", "HEAD");
  await git(value.peer, "push", "origin", "forge/task");

  const result = await integrate(value, remoteHead);
  expect(result).toMatchObject({ kind: "merged", remoteHead, mergeCommit: expect.any(String) });
  expect((await git(value.worktreePath, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")).toHaveLength(3);
  expect(await git(value.worktreePath, "status", "--porcelain")).toBe("");
  await expect(integrate(value, remoteHead)).resolves.toEqual(result);
});

test("dirty_worktree", async () => {
  const value = await fixture();
  await writeFile(join(value.worktreePath, "DIRTY.md"), "do not touch\n");
  const calls: string[][] = [];
  const result = await integrate(value, "b".repeat(40), {
    git: async (args, cwd, taskId) => {
      calls.push(args);
      const command = await runCommand({ taskId, stepId: null, command: "git", args, cwd });
      return { ok: command.exitCode === 0, stdout: command.stdout.trim(), stderr: command.stderr };
    },
  });

  expect(result).toEqual({ kind: "dirty_worktree", dirtyFileCount: 1 });
  expect(await git(value.worktreePath, "status", "--porcelain")).toBe("?? DIRTY.md");
  expect(calls).toEqual([["status", "--porcelain=v1", "--untracked-files=all"]]);
  await expect(integrate(value, "b".repeat(40))).resolves.toEqual(result);
});

test("skipped_active_turn", async () => {
  const value = await fixture();
  value.database.authTransaction((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('running-developer', 'task', 'company', 'workflow', 1, 1, 'running', 'forge/task', ?, ?, ?)").run(value.worktreePath, "a".repeat(40), new Date().toISOString()));
  let commands = 0;

  await expect(integrate(value, "b".repeat(40), { git: async () => { commands += 1; return { ok: true, stdout: "", stderr: "" }; } })).resolves.toEqual({ kind: "skipped_active_turn" });
  await expect(integrate(value, "b".repeat(40))).resolves.toEqual({ kind: "skipped_active_turn" });
  expect(commands).toBe(0);
});

test("not_owned", async () => {
  const value = await fixture();
  let commands = 0;
  const input = { taskId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge", branchName: "forge/task", remoteHead: "b".repeat(40), worktreePath: join(value.config.worktreeRoot, "unrecorded"), targetBaseSha: "a".repeat(40) };
  const deps = { git: async () => { commands += 1; return { ok: true, stdout: "", stderr: "" }; } };

  await expect(integrateRemoteBranch(value.database, value.config, { ...input, worktreePath: join(value.config.worktreeRoot, "..", "outside") }, deps)).resolves.toEqual({ kind: "not_owned" });
  await expect(integrateRemoteBranch(value.database, value.config, input, deps)).resolves.toEqual({ kind: "not_owned" });
  expect(commands).toBe(0);
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
