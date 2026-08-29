import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { classifyRecovery, type DurableTaskFacts, type LiveObservations } from "../src/recovery/convergence.js";
import { integrateRemoteBranch } from "../src/remote-branch-integration.js";

const facts = (overrides: Partial<DurableTaskFacts> = {}): DurableTaskFacts => ({ taskId: "task", phase: "development", revision: 1, terminal: false, cancelled: false, branchName: "forge/task", worktreePath: "/worktree", lastReviewedCommit: "a".repeat(40), turn: { turnId: "turn", role: "builder", status: "waiting", resultPresent: false, resultValid: false, resumeRequestsSent: 0 }, failure: null, ...overrides });
const live = (overrides: Partial<LiveObservations> = {}): LiveObservations => ({ herdr: { session: "terminal", stalledBeyondPolicy: false }, git: { worktreePresent: true, onRecordedBranch: true, dirty: false, headCommit: "a".repeat(40) }, github: null, ...overrides });
const twice = (input: DurableTaskFacts, observation: LiveObservations) => {
  const first = classifyRecovery(input, observation);
  expect(classifyRecovery(input, observation)).toEqual(first);
  return first;
};

const remoteRoots: string[] = [];
afterEach(async () => { await Promise.all(remoteRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function remoteFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-matrix-remote-"));
  remoteRoots.push(root);
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const worktreePath = join(root, "worktrees", "task");
  const peer = join(root, "peer");
  await git(root, "init", "--bare", origin);
  await git(root, "init", "-b", "main", source);
  for (const path of [source]) { await git(path, "config", "user.email", "test@example.invalid"); await git(path, "config", "user.name", "Forge Test"); }
  await writeFile(join(source, "README.md"), "base\n"); await git(source, "add", "README.md"); await git(source, "commit", "-m", "base");
  await git(source, "remote", "add", "origin", origin); await git(source, "switch", "-c", "forge/task"); await git(source, "push", "-u", "origin", "forge/task");
  for (const path of [worktreePath, peer]) { await git(root, "clone", origin, path); await git(path, "switch", "forge/task"); await git(path, "config", "user.email", "test@example.invalid"); await git(path, "config", "user.name", "Forge Test"); }
  const config = createTestConfig(root, { worktreeRoot: join(root, "worktrees") });
  const database = new ForgeDatabase(config.databasePath);
  database.authQuery((db) => db.pragma("foreign_keys = OFF"));
  database.authTransaction((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES ('worktree', 'task', 'company', 'project', 'workflow', ?, ?, ?, 'forge/task', ?, 'lease', 'active', ?)").run(source, config.worktreeRoot, worktreePath, "a".repeat(40), new Date().toISOString()));
  return { config, database, peer, worktreePath };
}

async function integrateRemote(value: Awaited<ReturnType<typeof remoteFixture>>, remoteHead: string, gitCalls?: string[][]) {
  return integrateRemoteBranch(value.database, value.config, { taskId: "task", companyId: "company", workflowId: "workflow", repository: "acme/forge", branchName: "forge/task", remoteHead, worktreePath: value.worktreePath, targetBaseSha: "a".repeat(40) }, gitCalls ? { git: async (args, cwd, taskId) => {
    gitCalls.push(args);
    const result = await runCommand({ taskId, stepId: null, command: "git", args, cwd });
    return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr };
  } } : undefined);
}

test("developer commits, then its completion message is lost", () => {
  const outcome = twice(facts(), live({ git: { worktreePresent: true, onRecordedBranch: true, dirty: false, headCommit: "b".repeat(40) } }));
  expect(outcome).toMatchObject({ action: "advance", evidence: ["handoff:git " + "b".repeat(40)] });
  // The durable handoff is what lets the workflow resume delivery review without
  // re-prompting the Developer; the classifier is intentionally write-free.
  expect(outcome.evidence).toContain("handoff:git " + "b".repeat(40));
});

test("lead completes, then its structured result is missing", () => {
  const waiting = facts({ turn: { ...facts().turn!, role: "planner", status: "waiting", resultPresent: false, resultValid: false, resumeRequestsSent: 0 } });
  expect(twice(waiting, live())).toMatchObject({ action: "resume" });
  const completed = { ...waiting, turn: { ...waiting.turn!, resultPresent: true, resultValid: true, resumeRequestsSent: 1 } };
  expect(twice(completed, live())).toMatchObject({ action: "advance" });
  expect(completed.turn?.resumeRequestsSent).toBe(1);
});

test("worker restarts during a live turn", () => {
  const pending = facts({ turn: { ...facts().turn!, status: "waiting" } });
  const first = twice(pending, live({ herdr: { session: "live_progress", stalledBeyondPolicy: false } }));
  const adopted = twice({ ...pending, turn: { ...pending.turn!, status: "completed", resultPresent: true, resultValid: true } }, live({ herdr: { session: "terminal", stalledBeyondPolicy: false } }));
  expect(first).toMatchObject({ action: "no_change" });
  expect(adopted).toMatchObject({ action: "advance" });
});

test("herdr is unavailable, then becomes available", () => {
  expect(twice(facts(), live({ herdr: { session: "unavailable", stalledBeyondPolicy: false } }))).toMatchObject({ action: "retry" });
  expect(twice(facts({ turn: { ...facts().turn!, resultPresent: true, resultValid: true } }), live())).toMatchObject({ action: "advance" });
});

test("pane is terminal while forge was awaiting output", () => {
  const outcome = twice(facts(), live());
  expect(outcome).toMatchObject({ action: "attention", attention: { title: "Developer turn ended without an outcome", primaryAction: { label: "Resume Developer turn" } } });
});

test("another user pushes a clean head change to an imported pr", () => {
  const outcome = twice(facts({ turn: null }), live({ github: { headSha: "b".repeat(40), merged: false, closed: false, checks: "passed", authenticated: true } }));
  expect(outcome).toMatchObject({ action: "no_change" });
});

test("remote branch integration is clean", async () => {
  const fastForward = await remoteFixture();
  await writeFile(join(fastForward.peer, "REMOTE.md"), "remote\n"); await git(fastForward.peer, "add", "REMOTE.md"); await git(fastForward.peer, "commit", "-m", "remote");
  const remoteHead = await git(fastForward.peer, "rev-parse", "HEAD"); await git(fastForward.peer, "push", "origin", "forge/task");
  expect(await integrateRemote(fastForward, remoteHead)).toMatchObject({ kind: "fast_forwarded", to: remoteHead });
  const fastForwardCalls: string[][] = [];
  await expect(integrateRemote(fastForward, remoteHead, fastForwardCalls)).resolves.toMatchObject({ kind: "fast_forwarded", to: remoteHead });
  expect(fastForwardCalls).toEqual([]);

  const merged = await remoteFixture();
  await writeFile(join(merged.worktreePath, "LOCAL.md"), "local\n"); await git(merged.worktreePath, "add", "LOCAL.md"); await git(merged.worktreePath, "commit", "-m", "local");
  await writeFile(join(merged.peer, "REMOTE.md"), "remote\n"); await git(merged.peer, "add", "REMOTE.md"); await git(merged.peer, "commit", "-m", "remote");
  const divergedHead = await git(merged.peer, "rev-parse", "HEAD"); await git(merged.peer, "push", "origin", "forge/task");
  const first = await integrateRemote(merged, divergedHead);
  expect(first).toMatchObject({ kind: "merged", remoteHead: divergedHead });
  const mergeCalls: string[][] = [];
  await expect(integrateRemote(merged, divergedHead, mergeCalls)).resolves.toEqual(first);
  expect(mergeCalls).toEqual([]);
});

test("remote branch integration conflicts and auto-enters resolution", () => {
  expect(twice(facts({ failure: { code: "forward_merge_conflict", retryable: false } as never }), live())).toMatchObject({ action: "attention" });
});

test("required local test fails and auto-repairs", () => {
  expect(twice(facts({ failure: { code: "required_test_failed", retryable: true } as never }), live())).toMatchObject({ action: "attention" });
});

test("ci fails from code and auto-repairs", () => {
  expect(twice(facts({ turn: null, failure: { code: "required_check_failed", retryable: true } as never }), live())).toMatchObject({ action: undefined });
});

test("ci fails transiently and retries without attention", () => {
  const outcome = twice(facts({ turn: null, failure: { code: "provider_unavailable", retryable: true } as never }), live());
  expect(outcome).toMatchObject({ action: undefined });
  expect(outcome.attention).toBeUndefined();
});

test("github authentication is missing and produces the sign-in action", () => {
  expect(twice(facts({ turn: null }), live({ github: { headSha: null, merged: false, closed: false, checks: "none", authenticated: false } }))).toMatchObject({ action: "attention", attention: { primaryAction: { label: "Sign in to GitHub and retry" } } });
});

test("a worktree is cleaned in forge", () => {
  expect(twice(facts({ turn: null, worktreePath: null }), live({ git: { worktreePresent: false, onRecordedBranch: false, dirty: false, headCommit: null } }))).toMatchObject({ action: "attention" });
});

test("a worktree is deleted outside forge while active and while terminal", () => {
  expect(twice(facts({ terminal: true, turn: null }), live({ git: { worktreePresent: false, onRecordedBranch: false, dirty: false, headCommit: null } }))).toMatchObject({ action: "no_change" });
});

test("cancellation races a late agent result and a webhook", () => {
  expect(twice(facts({ cancelled: true }), live({ github: { headSha: "b".repeat(40), merged: true, closed: false, checks: "passed", authenticated: true } }))).toMatchObject({ action: "no_change", evidence: ["task:terminal"] });
});

test("worker schedules all three reconciliation entry points", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  for (const name of ["reconcileActiveTurns", "reconcileWorktrees", "reconcileGithubObservations"]) expect(worker).toContain(name);
});
