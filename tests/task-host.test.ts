import { runCommand } from "../src/command-runner.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ForgeDatabase } from "../src/database.js";
import { RootController } from "../src/root-controller.js";
import { TaskControlStore } from "../src/root-session-store.js";
import { TaskHost } from "../src/task-host.js";
import { prepareTaskWorktree } from "../src/task-worktree.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

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
  const profile = { profileId: "profile", provider: "openai", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" } as const;
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
