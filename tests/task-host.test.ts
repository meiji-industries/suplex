import { CompletedPullRequests } from "../src/delivery/completed-pull-requests.js";
import { runCommand } from "../src/platform/command-runner.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ForgeDatabase } from "../src/platform/database.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { TaskHost } from "../src/tasks/host.js";
import { prepareTaskWorktree } from "../src/tasks/worktree.js";
import { taskPreparationDirectory } from "../src/tasks/preparation.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { IssueTracker, IssueTrackerScopeFailure } from "../src/integrations/issue-tracker.js";
import { ProviderHttpFailure } from "../src/integrations/provider-http.js";
import { MissingIntegrationCredential } from "../src/projects/integration-configuration.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

test.each([new MissingIntegrationCredential("Credential is not available"), new IssueTrackerScopeFailure("Issue moved"), new ProviderHttpFailure(401), new ProviderHttpFailure(403), new ProviderHttpFailure(404), new ProviderHttpFailure(503)])("issue intake handles $message without starting a native session", async error => {
  const f = await fixture();
  const issue = { kind: "github", repository: "owner/repo", number: 42, id: "42", key: "#42", title: "Fix", url: "https://github.com/owner/repo/issues/42" };
  f.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET issue_json = ? WHERE id = 'task'").run(JSON.stringify(issue)));
  vi.spyOn(IssueTracker.prototype, "read").mockRejectedValue(error);
  await f.host.recover("task");
  const control = f.store.get("task");
  expect(f.harness.dispatched).toHaveLength(0);
  if (error instanceof ProviderHttpFailure && error.status === 503) {
    expect(control.status).toBe("active");
    expect(control.wakeAt).not.toBeNull();
    expect(control.humanQuestion).toBeNull();
  } else {
    expect(control.status).toBe("waiting_human");
    expect(control.humanQuestion).toContain("Check the issue and tracker access");
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-task-host-"));
  const repository = join(directory, "repo");
  const git = (args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", args });
  await git(["init", "-b", "main", repository]);
  await git(["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
  const sha = (await git(["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  const stamp = new Date().toISOString();
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'main', '', '', ?, ?)").run(repository, join(directory, "worktrees"), stamp, stamp);
    insertNativeTaskRow(db);
    db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.repositoryPath', ?, '$.worktreeRoot', ?, '$.startingSha', ?, '$.baselineSha', ?, '$.setupCommand', 'pnpm install', '$.verificationCommand', 'pnpm test') WHERE id = 'task'").run(repository, join(directory, "worktrees"), sha, sha);
  });
  const store = new TaskControlStore(database);
  const profile = { profileId: "profile", provider: "opencode", model: "openai/gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" } as const;
  store.create({ taskId: "task", startImmediately: true, objective: "Ship the objective", deliveryTarget: "merged", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", baselineSha: sha, pullRequestNumber: null }, rootProfile: profile, workerProfile: profile });
  const harness = new FakeTaskHarness();
  const controller = new RootController(store, harness);
  const delivery = { observe: async () => null };
  const host = new TaskHost(database, { controller, delivery });
  cleanups.push(async () => { await host.stop(); database.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, database, store, harness, controller, delivery, host };
}

test("native recovery prepares the Git worktree and delivers captured instructions to Coordinator", async () => {
  const f = await fixture();
  await f.host.recover("task");
  expect(f.store.get("task").worktree?.branch).toBe("task");
  expect(f.harness.dispatched).toHaveLength(1);
  expect(f.harness.dispatched[0]?.prompt).toContain("pnpm install");
  expect(f.harness.dispatched[0]?.prompt).toContain("pnpm test");
});

test("project preparation and skill context exist before the first native session and survive restart", async () => {
  const f = await fixture();
  f.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.execution', json(?), '$.setupCommand', ?) WHERE id = 'task'").run(JSON.stringify({ instructions: "Use the Acme workflow", skillDirectories: [], environment: {}, mcp: [] }), "printf prepared > setup-ready"));
  const ensure = f.harness.ensureSession.bind(f.harness);
  vi.spyOn(f.harness, "ensureSession").mockImplementation(async (scope, nativeId) => {
    expect(await readFile(join(scope.directory, "setup-ready"), "utf8")).toBe("prepared");
    expect(await readFile(join(taskPreparationDirectory(f.database.filename(), "task"), "context.md"), "utf8")).toContain("Configured setup exited 0");
    expect(scope.projectContext).toContain("Acme");
    return ensure(scope, nativeId);
  });
  await f.host.recover("task");
  const worktree = f.store.get("task").worktree!;
  await writeFile(join(worktree.path, "setup-ready"), "preserved");
  f.harness.ensureSession = ensure;
  const restarted = new TaskHost(f.database, { controller: f.controller, delivery: f.delivery });
  try { await restarted.recover("task"); } finally { await restarted.stop(); }
  expect(await readFile(join(worktree.path, "setup-ready"), "utf8")).toBe("preserved");
});

test("restart adopts dirty out-of-band work without replacing the native session", async () => {
  const f = await fixture();
  await f.host.recover("task");
  const native = f.store.currentSession("task", "root")?.nativeSessionId;
  const worktree = f.store.get("task").worktree!;
  await writeFile(join(worktree.path, "external.txt"), "Preserve me");
  const restarted = new TaskHost(f.database, { controller: f.controller, delivery: f.delivery });
  try { await restarted.recover("task"); } finally { await restarted.stop(); }
  expect(f.store.currentSession("task", "root")?.nativeSessionId).toBe(native);
  expect(f.harness.dispatched).toHaveLength(1);
  expect(await readFile(join(worktree.path, "external.txt"), "utf8")).toBe("Preserve me");
});

test.each(["missing", "stale"] as const)("restart with %s worktree metadata recovers a conflicting rebase", async metadata => {
  const f = await fixture();
  await f.host.recover("task");
  const native = f.store.currentSession("task", "root")?.nativeSessionId;
  const worktree = f.store.get("task").worktree!;
  await writeFile(join(worktree.path, "conflict.txt"), "task\n");
  await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["add", "conflict.txt"] });
  await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "task change"] });
  await writeFile(join(f.directory, "repo", "conflict.txt"), "main\n");
  await runCommand({ taskId: null, stepId: null, command: "git", cwd: join(f.directory, "repo"), args: ["add", "conflict.txt"] });
  await runCommand({ taskId: null, stepId: null, command: "git", cwd: join(f.directory, "repo"), args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "main change"] });
  await writeFile(join(worktree.path, "preserved.txt"), "Preserve me");
  const rebase = await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["rebase", "main"], expectNonZero: true });
  expect(rebase.exitCode).not.toBe(0);
  expect((await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["branch", "--show-current"] })).stdout.trim()).toBe("");
  const head = (await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["rev-parse", "HEAD"] })).stdout.trim();
  const status = (await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["status", "--porcelain=v1"] })).stdout;
  const conflict = await readFile(join(worktree.path, "conflict.txt"), "utf8");
  const rebaseHeadNamePath = (await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/head-name"] })).stdout.trim();
  const rebaseHeadName = await readFile(rebaseHeadNamePath, "utf8");
  if (metadata === "missing") f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET worktree_json = NULL WHERE task_id = 'task'").run());

  const restarted = new TaskHost(f.database, { controller: f.controller, delivery: f.delivery });
  try { await restarted.recover("task"); } finally { await restarted.stop(); }

  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null, worktree: { path: worktree.path, branch: "task", headSha: head, dirty: true } });
  expect(f.store.currentSession("task", "root")?.nativeSessionId).toBe(native);
  expect(f.harness.dispatched).toHaveLength(1);
  expect((await runCommand({ taskId: null, stepId: null, command: "git", cwd: worktree.path, args: ["status", "--porcelain=v1"] })).stdout).toBe(status);
  expect(await readFile(join(worktree.path, "conflict.txt"), "utf8")).toBe(conflict);
  expect(await readFile(join(worktree.path, "preserved.txt"), "utf8")).toBe("Preserve me");
  expect(await readFile(rebaseHeadNamePath, "utf8")).toBe(rebaseHeadName);
});

test("a preparation failure keeps an answerable Coordinator and its original objective", async () => {
  const f = await fixture();
  let fail = true;
  const host = new TaskHost(f.database, { controller: f.controller, delivery: f.delivery, worktree: async input => { if (fail) throw new Error("Disk unavailable"); return prepareTaskWorktree(input); } });
  try {
    await host.recover("task");
    expect(f.store.get("task")).toMatchObject({ status: "waiting_human", humanQuestion: expect.stringContaining("Disk unavailable") });
    expect(f.harness.dispatched).toHaveLength(0);
    f.store.answerHuman("task", f.store.get("task").humanQuestionId!, "Disk restored");
    fail = false;
    await host.recover("task");
    expect(f.harness.dispatched[0]?.prompt).toContain("Ship the objective");
  } finally { await host.stop(); }
});

test("a GitHub observation outage does not block native Coordinator startup", async () => {
  const f = await fixture();
  const host = new TaskHost(f.database, { controller: f.controller, delivery: { observe: async () => { throw new Error("GitHub offline"); } } });
  try {
    await expect(host.recover("task")).rejects.toThrow("GitHub offline");
    expect(f.harness.dispatched).toHaveLength(1);
    expect(f.store.get("task").status).toBe("active");
  } finally { await host.stop(); }
});

test("a lost prompt acknowledgement keeps automatic native recovery active", async () => {
  const f = await fixture();
  f.harness.loseAcknowledgement = true;
  await f.host.recover("task");
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  expect(f.store.get("task").wakeAt).not.toBeNull();
  f.harness.loseAcknowledgement = false;
  await f.host.recover("task");
  expect(f.harness.dispatched).toHaveLength(1);
  expect(f.store.pendingTurns(f.store.currentSession("task", "root")!.id)[0]?.status).toBe("prompted");
});

test("out-of-band delivery is adopted before any worktree or session is started", async () => {
  const f = await fixture();
  const host = new TaskHost(f.database, { controller: f.controller, delivery: { observe: async () => { f.store.markDelivered("task"); return null; } }, worktree: async () => { throw new Error("Must not materialize"); } });
  try {
    await host.recover("task");
    expect(f.store.get("task").status).toBe("delivered");
    expect(f.harness.dispatched).toHaveLength(0);
  } finally { await host.stop(); }
});


test("delivered PR refresh updates facts in a batch without restarting agents or rewriting completion", async () => {
  const f = await fixture();
  const pull = { repository: "owner/repo", number: 183, url: "https://github.com/owner/repo/pull/183", headSha: "a".repeat(40), state: "open", mergedAt: null };
  f.store.setPullRequest("task", pull);
  f.store.markDelivered("task");
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET delivery_target = 'pull_request_draft' WHERE task_id = 'task'").run());
  const before = f.store.get("task");
  let calls = 0;
  const refresh = new CompletedPullRequests(f.database, { getPullRequestStates: async inputs => {
    calls += 1;
    expect(inputs).toMatchObject([{ repository: "owner/repo", number: 183 }]);
    return [{ ...pull, state: "merged", mergedAt: "2026-09-10T02:32:47Z" }];
  } });
  const host = new TaskHost(f.database, { completedPullRequests: refresh, controller: f.controller, delivery: f.delivery });
  try {
    await host.recover("task");
    expect(f.store.get("task")).toMatchObject({ status: "delivered", deliveryTarget: "pull_request_draft", pullRequest: { state: "merged" }, workflowState: before.workflowState, wakeAt: null });
    expect(f.harness.dispatched).toHaveLength(0);
    await refresh.refresh();
    expect(calls).toBe(1);
  } finally { await host.stop(); }
});

test("a delivered PR refresh preserves a task resumed while the request was in flight", async () => {
  const f = await fixture();
  const pull = { repository: "owner/repo", number: 183, url: "https://github.com/owner/repo/pull/183", headSha: "a".repeat(40), state: "open", mergedAt: null };
  f.store.setPullRequest("task", pull);
  f.store.markDelivered("task");
  const refresh = new CompletedPullRequests(f.database, { getPullRequestStates: async () => {
    f.store.sendNote("task", "Continue with the requested follow-up");
    return [{ ...pull, state: "merged", mergedAt: "2026-09-10T02:32:47Z" }];
  } });
  await refresh.refresh();
  expect(f.store.get("task")).toMatchObject({ status: "active", pullRequest: { state: "open" } });
});


test("completed PR polling runs once per minute without agent recovery", async () => {
  const f = await fixture();
  f.store.markDelivered("task");
  const refresh = vi.fn(async () => {});
  const recover = vi.fn(async () => {});
  const host = new TaskHost(f.database, { completedPullRequests: { refresh }, controller: { prepareRoot: f.controller.prepareRoot.bind(f.controller), recover }, delivery: f.delivery });
  vi.useFakeTimers();
  try {
    host.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(recover).not.toHaveBeenCalled();
  } finally { await host.stop(); vi.useRealTimers(); }
});

test("failed or missing PR observations preserve facts and closed PRs can reopen", async () => {
  const f = await fixture();
  const pull = { repository: "owner/repo", number: 183, url: "https://github.com/owner/repo/pull/183", headSha: "a".repeat(40), state: "closed", mergedAt: null };
  f.store.setPullRequest("task", pull);
  f.store.markDelivered("task");
  const before = f.store.get("task");
  let attempt = 0;
  const refresh = new CompletedPullRequests(f.database, { getPullRequestStates: async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("GitHub is not available");
    return attempt === 2 ? [] : [{ ...pull, state: "open" }];
  } });
  await expect(refresh.refresh()).rejects.toThrow("GitHub is not available");
  await refresh.refresh();
  expect(f.store.get("task")).toEqual(before);
  await refresh.refresh();
  expect(f.store.get("task")).toMatchObject({ status: "delivered", pullRequest: { state: "open" } });
  f.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET archived_at = ? WHERE id = 'task'").run(new Date().toISOString()));
  await refresh.refresh();
  expect(attempt).toBe(3);
});


test("delivered PR refresh rediscovers missing observations from task intent", async () => {
  const f = await fixture();
  f.store.markDelivered("task");
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 183) WHERE task_id = 'task'").run());
  const refresh = new CompletedPullRequests(f.database, { getPullRequestStates: async inputs => {
    expect(inputs).toEqual([{ repository: "owner/repo", number: 183 }]);
    return [{ repository: "owner/repo", number: 183, url: "https://github.com/owner/repo/pull/183", headSha: "a".repeat(40), state: "merged", mergedAt: "2026-09-10T02:32:47Z" }];
  } });
  await refresh.refresh();
  expect(f.store.get("task")).toMatchObject({ status: "delivered", pullRequest: { number: 183, state: "merged" } });
});
