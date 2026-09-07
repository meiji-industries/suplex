import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "./helpers/test-database.js";
import { DeliveryOperations, type DeliveryGithubPort } from "../src/delivery-operations.js";
import type { GithubReleaseAdapter, GithubPullRequest, GithubPullRequestObservation, LocalRevision } from "../src/github-delivery.js";
import { RootController } from "../src/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { TaskControlStore } from "../src/root-session-store.js";
import { runCommand } from "../src/command-runner.js";
import { inspectDeliveryDiff } from "../src/delivery-review.js";
import { commitGitFixture, initializeGitFixture } from "./helpers/git-fixture.js";

const run = (command: string, args: string[]) => runCommand({ command, args, taskId: null, stepId: null });
const cleanup: string[] = [];
let seed: { directory: string; local: LocalRevision } | undefined;

async function revision(cwd: string): Promise<LocalRevision> {
  const [branch, headSha, treeSha, status] = await Promise.all([
    run("git", ["-C", cwd, "branch", "--show-current"]),
    run("git", ["-C", cwd, "rev-parse", "HEAD"]),
    run("git", ["-C", cwd, "rev-parse", "HEAD^{tree}"]),
    run("git", ["-C", cwd, "status", "--porcelain"]),
  ]);
  return { branch: branch.stdout.trim(), headSha: headSha.stdout.trim(), treeSha: treeSha.stdout.trim(), clean: status.stdout.trim() === "" };
}

async function deliverySeed(): Promise<{ directory: string; local: LocalRevision }> {
  if (seed) return seed;

  const directory = await mkdtemp(join(tmpdir(), "forge-delivery-seed-"));
  try {
    await initializeGitFixture(directory, "task-branch");
    await commitGitFixture(directory, "seed", []);
    seed = { directory, local: await revision(directory) };
    return seed;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-delivery-"));
  cleanup.push(directory);
  const value = await deliverySeed();
  await cp(value.directory, directory, { recursive: true });
  const local = { ...value.local };
  const database = createTestDatabase(join(directory, "forge.sqlite"));
  const stamp = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(directory, directory, stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
      insertNativeTaskRow(db);
  });
  const profile = { profileId: "profile", provider: "codex" as const, model: "gpt-5.6-sol", reasoningLevel: "medium" as const, serviceTier: "default" as const };
  const store = new TaskControlStore(database);
  store.create({ startImmediately: true, taskId: "task", objective: "Deliver the change", deliveryTarget: "merged", deliveryIntent: { repository: "owner/repo", headBranch: local.branch, baseBranch: "main", baselineSha: local.headSha, pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: directory, branch: local.branch, baseSha: local.headSha, headSha: local.headSha, dirty: false } });
  const root = store.claimRoot({ taskId: "task" });
  store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_root" });
  store.bindPane({ sessionId: root.id, generation: root.generation, paneId: "root-pane" });
  const review = { baseSha: local.headSha, headSha: local.headSha, files: [], commits: [] };
  return { database, directory, local, root, store, review };
}

function github(local: LocalRevision) {
  const calls: string[] = [];
  const createdTitles: string[] = [];
  let observed: GithubPullRequestObservation = { exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1, runs: [] }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: "APPROVED" };
  const pull = (): GithubPullRequest => ({ number: 7, url: "https://github.com/owner/repo/pull/7", repository: "owner/repo", headBranch: local.branch, baseBranch: "main", headSha: observed.headSha!, baseSha: "base", isDraft: observed.isDraft ?? false, state: observed.state!, mergedAt: observed.state === "merged" ? new Date().toISOString() : null });
  const port: GithubReleaseAdapter & DeliveryGithubPort = {
    markReadyForReview: async () => { calls.push("ready"); observed = { ...observed, isDraft: false }; },
    checkAuthentication: async () => {}, getRemoteRepository: async () => { calls.push("remote"); return "owner/repo"; }, getBranchHead: async () => local.headSha, inspectLocalRevision: async () => { calls.push("inspect"); return local; }, pushNormal: async () => { calls.push("push"); }, listPullRequests: async () => [pull()], createDraftPullRequest: async input => { calls.push("create"); createdTitles.push(input.title); return pull(); }, updateDraftPullRequest: async () => pull(), getPullRequest: async () => { calls.push("get"); return pull(); }, observePullRequest: async () => { calls.push("observe"); return observed; }, mergePullRequest: async () => { calls.push("merge"); observed = { ...observed, state: "merged" }; },
  };
  return { calls, createdTitles, port, setObserved: (value: GithubPullRequestObservation) => { observed = value; } };
}

function cachePull(store: TaskControlStore, pull: GithubPullRequest, number: number): void {
  store.setPullRequest("task", { repository: pull.repository, number, url: pull.url, headSha: pull.headSha, state: pull.state, mergedAt: pull.mergedAt });
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  if (seed) await rm(seed.directory, { recursive: true, force: true });
});

describe("Coordinator delivery operations", () => {
  it("creates a pull request with the Coordinator's normalized final-solution title", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      fake.port.listPullRequests = async () => [];
      value.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET objective = ? WHERE task_id = 'task'").run("Auto Restart\n\nRight now the \"Update Forge\" notification does not have a call to action.  I want it to have the ability to self-reload itself somehow.. Please make it happen somehow.  \"Restart Now\"."));
      const controller = new RootController(value.store, new FakeTaskHarness(), new DeliveryOperations(value.store, fake.port));
      await controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "create_or_adopt_pull_request", value.local.headSha, value.review, "  Add a restart action to the Forge update notification  ");
      expect(fake.createdTitles).toEqual(["Add a restart action to the Forge update notification"]);
    } finally { value.database.close(); }
  });

  it("requires a valid title before creating a pull request", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      fake.port.listPullRequests = async () => [];
      const delivery = new DeliveryOperations(value.store, fake.port);
      for (const title of [undefined, " ", "\nCreate a pull request", "Create\na pull request", `Create${String.fromCharCode(1)} a pull request`, "a".repeat(121)]) {
        await expect(delivery.execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "create_or_adopt_pull_request", value.local.headSha, value.review, title)).rejects.toMatchObject({ code: "pull_request_title_required" });
      }
      expect(fake.calls).not.toContain("create");
    } finally { value.database.close(); }
  });

  it("adopts an existing matching pull request without a title or update", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      await new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "create_or_adopt_pull_request", value.local.headSha, value.review);
      expect(fake.calls).not.toContain("create");
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 7 });
    } finally { value.database.close(); }
  });

  it.each(["baseSha", "headSha", "files", "commits"] as const)("rejects a stale or incomplete reviewed %s before publishing", async field => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const review = { ...value.review, [field]: field === "files" ? ["unreviewed.ts"] : field === "commits" ? ["a".repeat(40)] : "a".repeat(40) };
      await expect(new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "push_branch", value.local.headSha, review)).rejects.toMatchObject({ code: "delivery_review_required" });
      expect(fake.calls).not.toContain("push");
    } finally { value.database.close(); }
  });
  it("refuses to publish an imported local-main history without a whole-range review", async () => {
    const value = await fixture();
    try {
      await writeFile(join(value.directory, "unrelated-refactor.ts"), "export const unrelated = true;\n");
      await commitGitFixture(value.directory, "Unrelated unpublished main work", ["unrelated-refactor.ts"]);
      await writeFile(join(value.directory, "task.ts"), "export const task = true;\n");
      await commitGitFixture(value.directory, "Task change", ["task.ts"]);
      const current = await revision(value.directory);
      const fake = github(current);
      fake.port.getBranchHead = async ({ branch }) => branch === "main" ? value.local.headSha : null;
      await expect(new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "push_branch", current.headSha)).rejects.toThrow(/review/i);
      const actual = await inspectDeliveryDiff(value.directory, value.local.headSha, current.headSha);
      expect(actual.files).toEqual(["task.ts", "unrelated-refactor.ts"]);
      expect(actual.commits).toHaveLength(2);
      const incomplete = { baseSha: value.local.headSha, headSha: current.headSha, files: ["task.ts"], commits: [current.headSha] };
      for (const operation of ["push_branch", "create_or_adopt_pull_request", "request_review", "merge_pull_request"] as const) {
        await expect(new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, operation, current.headSha, incomplete)).rejects.toMatchObject({ code: "delivery_review_required" });
      }
      expect(fake.calls).not.toContain("push");
      expect(fake.calls).not.toContain("ready");
      expect(fake.calls).not.toContain("merge");
    } finally { value.database.close(); }
  });
  it.each(["fork", "other_base"])("does not adopt an unrelated %s pull request", async mismatch => {
    const value = await fixture();
    const fake = github(value.local);
    const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
    fake.port.listPullRequests = async () => [{ ...pull, ...(mismatch === "fork" ? { isCrossRepository: true } : { baseBranch: "release" }) }];
    expect(await new DeliveryOperations(value.store, fake.port).observe("task")).toBeNull();
    expect(value.store.get("task").pullRequest).toBeNull();
    expect(value.store.get("task").status).toBe("active");
    value.database.close();
  });
  it("replaces a cached retargeted pull request with the current intent match", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      cachePull(value.store, pull, 41);
      fake.port.getPullRequest = async () => { throw new Error("The cached receipt must not drive discovery"); };
      fake.port.listPullRequests = async () => [
        { ...pull, number: 41, baseBranch: "release" },
        { ...pull, number: 42 },
      ];

      await expect(new DeliveryOperations(value.store, fake.port).observe("task")).resolves.toMatchObject({ number: 42 });
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 42 });
    } finally { value.database.close(); }
  });

  it("ignores closed history when one eligible pull request matches", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      fake.port.listPullRequests = async () => [
        { ...pull, number: 41, state: "closed" },
        { ...pull, number: 42 },
      ];

      await expect(new DeliveryOperations(value.store, fake.port).observe("task")).resolves.toMatchObject({ number: 42 });
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 42 });
    } finally { value.database.close(); }
  });

  it("uses an explicitly pinned pull request instead of a conflicting cached receipt", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      cachePull(value.store, pull, 42);
      value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 41) WHERE task_id = 'task'").run());
      const requested: number[] = [];
      fake.port.getPullRequest = async ({ number }) => {
        requested.push(number);
        return { ...pull, number };
      };
      fake.port.listPullRequests = async () => { throw new Error("Pinned pull requests must not use discovery"); };

      await expect(new DeliveryOperations(value.store, fake.port).observe("task")).resolves.toMatchObject({ number: 41 });
      expect(requested).toEqual([41]);
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 41 });
    } finally { value.database.close(); }
  });

  it("does not mutate the cached receipt when discovery is ambiguous", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      cachePull(value.store, pull, 41);
      fake.port.listPullRequests = async () => [
        { ...pull, number: 42 },
        { ...pull, number: 43 },
      ];

      await expect(new DeliveryOperations(value.store, fake.port).observe("task")).rejects.toMatchObject({ code: "pull_request_ambiguous" });
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 41 });
    } finally { value.database.close(); }
  });

  it("clears a cached receipt when discovery finds no current match", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      cachePull(value.store, pull, 41);
      fake.port.getPullRequest = async () => { throw new Error("The cached receipt must not be observed"); };
      fake.port.listPullRequests = async () => [];

      await expect(new DeliveryOperations(value.store, fake.port).observe("task")).resolves.toBeNull();
      expect(value.store.get("task").pullRequest).toBeNull();
    } finally { value.database.close(); }
  });

  it("propagates discovery failures without mutating the cached receipt", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      cachePull(value.store, pull, 41);
      fake.port.listPullRequests = async () => { throw new Error("GitHub offline"); };

      await expect(new DeliveryOperations(value.store, fake.port).observe("task")).rejects.toThrow("GitHub offline");
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 41 });
    } finally { value.database.close(); }
  });

  it("does not adopt a closed pull request that appears during creation", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      let lists = 0;
      let creates = 0;
      fake.port.listPullRequests = async () => ++lists === 1 ? [] : [{ ...pull, number: 41, state: "closed" }];
      fake.port.createDraftPullRequest = async () => {
        creates += 1;
        return pull;
      };

      await expect(new DeliveryOperations(value.store, fake.port).execute(
        { taskId: "task", sessionId: value.root.id, generation: value.root.generation },
        "create_or_adopt_pull_request",
        value.local.headSha,
        value.review,
      )).rejects.toMatchObject({ code: "pull_request_closed" });
      expect(creates).toBe(0);
      expect(value.store.get("task").pullRequest).toBeNull();
    } finally { value.database.close(); }
  });

  it("does not replace a pinned pull request that disappears during creation", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pinned = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 7) WHERE task_id = 'task'").run());
      fake.setObserved({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: null, additions: null, deletions: null, autoMergeEnabled: null, reviewDecision: null });
      fake.port.getPullRequest = async () => pinned;
      let lists = 0;
      let creates = 0;
      fake.port.listPullRequests = async () => {
        lists += 1;
        return [];
      };
      fake.port.createDraftPullRequest = async () => {
        creates += 1;
        return fake.port.getPullRequest({ repository: "owner/repo", number: 8 });
      };

      await expect(new DeliveryOperations(value.store, fake.port).execute(
        { taskId: "task", sessionId: value.root.id, generation: value.root.generation },
        "create_or_adopt_pull_request",
        value.local.headSha,
        value.review,
      )).rejects.toMatchObject({ code: "pull_request_closed" });
      expect(lists).toBe(0);
      expect(creates).toBe(0);
      expect(value.store.get("task").pullRequest).toMatchObject({ number: 7 });
    } finally { value.database.close(); }
  });

  it("adopts a merged pull request that appears during creation despite a different head", async () => {
    const value = await fixture();
    try {
      const fake = github(value.local);
      const pull = await fake.port.getPullRequest({ repository: "owner/repo", number: 7 });
      let lists = 0;
      fake.port.listPullRequests = async () => ++lists === 1 ? [] : [{ ...pull, number: 42, state: "merged", headSha: "b".repeat(40), mergedAt: new Date().toISOString() }];

      await expect(new DeliveryOperations(value.store, fake.port).execute(
        { taskId: "task", sessionId: value.root.id, generation: value.root.generation },
        "create_or_adopt_pull_request",
        value.local.headSha,
        value.review,
      )).resolves.toMatchObject({ number: 42, state: "merged" });
      expect(value.store.get("task")).toMatchObject({ status: "delivered", pullRequest: { number: 42, state: "merged" } });
    } finally { value.database.close(); }
  });
  it("completes a reviewed local worktree without requiring GitHub", async () => {
    const value = await fixture();
    const fake = github(value.local);
    fake.port.listPullRequests = async () => { throw new Error("GitHub offline"); };
    fake.port.getRemoteRepository = async () => { throw new Error("GitHub must not be consulted"); };
    value.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET delivery_target = 'local_worktree' WHERE task_id = 'task'").run());
    expect(await new DeliveryOperations(value.store, fake.port).observe("task")).toBeNull();
    await new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "complete_local_work", value.local.headSha);
    expect(value.store.get("task").status).toBe("delivered");
    expect(fake.calls).not.toContain("push");
  });

  it("adopts an already-pushed exact head for a remote-branch target", async () => {
    const value = await fixture();
    const fake = github(value.local);
    fake.port.getBranchHead = async () => value.local.headSha;
    value.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET delivery_target = 'remote_branch' WHERE task_id = 'task'").run());
    await new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "push_branch", value.local.headSha, value.review);
    expect(value.store.get("task").status).toBe("delivered");
    expect(fake.calls).not.toContain("push");
  });

  it("does not push after cancellation during a remote-head read", async () => {
    const value = await fixture();
    const fake = github(value.local);
    fake.port.getBranchHead = async () => { value.store.cancel("task"); return null; };
    await expect(new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "push_branch")).rejects.toThrow();
    expect(fake.calls).not.toContain("push");
  });
  it("marks a draft ready and confirms GitHub state for a ready target", async () => {
    const value = await fixture();
    const fake = github(value.local);
    const observed = await fake.port.observePullRequest!({ repository: "owner/repo", branch: value.local.branch });
    fake.setObserved({ ...observed, isDraft: true });
    value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET delivery_target = 'pull_request_ready' WHERE task_id = 'task'").run());
    await new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "request_review", value.local.headSha, value.review);
    expect(fake.calls).toContain("ready");
    expect(value.store.get("task").status).toBe("delivered");
  });

  it("lets GitHub decide whether failing or pending checks prohibit an exact-head merge", async () => {
    const value = await fixture();
    const fake = github(value.local);
    const observed = await fake.port.observePullRequest!({ repository: "owner/repo", branch: value.local.branch });
    fake.setObserved({ ...observed, checks: { total: 3, pending: 1, failing: 1, successful: 1, runs: [] } });
    await new DeliveryOperations(value.store, fake.port).execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "merge_pull_request", value.local.headSha, value.review);
    expect(fake.calls).toContain("merge");
    expect(value.store.get("task").status).toBe("delivered");
  });

  it.each(["pull_request_draft", "pull_request_ready"])("adopts an existing ready PR for the %s target", async (target) => {
    const value = await fixture();
    const fake = github(value.local);
    value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET delivery_target = ?, worktree_json = NULL WHERE task_id = 'task'").run(target));
    await new DeliveryOperations(value.store, fake.port).observe("task");
    expect(value.store.get("task").status).toBe("delivered");
    expect(fake.calls).not.toContain("inspect");
  });

  it("does not resume a cancelled task when GitHub changes", async () => {
    const value = await fixture();
    const fake = github(value.local);
    value.store.cancel("task");
    await new DeliveryOperations(value.store, fake.port).observe("task");
    expect(value.store.get("task").status).toBe("cancelled");
    expect(fake.calls).toEqual([]);
  });

  it("does not treat a draft as a ready pull request", async () => {
    const value = await fixture();
    const fake = github(value.local);
    const list = fake.port.listPullRequests;
    fake.port.listPullRequests = async (input) => (await list(input)).map((pull) => ({ ...pull, isDraft: true }));
    value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET delivery_target = 'pull_request_ready' WHERE task_id = 'task'").run());
    await new DeliveryOperations(value.store, fake.port).observe("task");
    expect(value.store.get("task").status).toBe("active");
  });

  it("does not push a branch outside the immutable task intent", async () => {
    const value = await fixture();
    const fake = github(value.local);
    fake.port.inspectLocalRevision = async () => ({ ...value.local, branch: "unrelated-work" });
    fake.port.getBranchHead = async () => null;
    const delivery = new DeliveryOperations(value.store, fake.port);
    await expect(delivery.execute({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "push_branch")).rejects.toMatchObject({ code: "head_diverged" });
    expect(fake.calls).not.toContain("push");
  });

  it("adopts an external merge while waiting for a human without inspecting the worktree", async () => {
    const value = await fixture();
    const fake = github(value.local);
    fake.port.getPullRequest = async () => ({ number: 7, url: "https://github.com/owner/repo/pull/7", repository: "owner/repo", headBranch: value.local.branch, baseBranch: "main", headSha: value.local.headSha, baseSha: "base", isDraft: false, state: "merged", mergedAt: new Date().toISOString() });
    value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 7), worktree_json = NULL WHERE task_id = 'task'").run());
    value.store.askHuman("task", "Resolve the branch manually");
    const delivery = new DeliveryOperations(value.store, fake.port);
    await delivery.observe("task");
    expect(value.store.get("task")).toMatchObject({ status: "delivered", humanQuestion: null, pullRequest: { number: 7, state: "merged" } });
    expect(fake.calls).not.toContain("inspect");
    expect(fake.calls).not.toContain("merge");
    await delivery.observe("task");
    expect(value.store.get("task").status).toBe("delivered");
  });

  it("uses no review receipt, rechecks the expected head, and adopts a known external merge without a worktree", async () => {
    const value = await fixture();
    const fake = github(value.local);
    const controller = new RootController(value.store, new FakeTaskHarness(), new DeliveryOperations(value.store, fake.port));
    const receipt = await controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "request_review", value.local.headSha, value.review);
    expect(receipt).toMatchObject({ headSha: value.local.headSha });
    fake.setObserved({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: "c".repeat(40), baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1, runs: [] }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: "APPROVED" });
    await expect(controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "merge_pull_request", value.local.headSha, value.review)).rejects.toMatchObject({ code: "head_diverged" });
    expect(fake.calls).not.toContain("merge");
    fake.setObserved({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "merged", isDraft: false, headSha: value.local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: null });
    value.database.authTransaction((db) => db.prepare("UPDATE forge_task_controls SET worktree_json = NULL, pull_request_json = NULL WHERE task_id = 'task'").run());
    const inspections = fake.calls.filter((call) => call === "inspect").length;
    await controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "observe_pull_request");
    expect(value.store.get("task").status).toBe("delivered");
    expect(fake.calls.filter((call) => call === "inspect")).toHaveLength(inspections);
    expect(fake.calls).toEqual(expect.arrayContaining(["inspect", "remote", "observe"]));
  });

  it("requests an exact-head merge without a Forge or GitHub review mirror", async () => {
    const value = await fixture();
    const fake = github(value.local);
    fake.setObserved({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: value.local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1, runs: [] }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: null });
    const controller = new RootController(value.store, new FakeTaskHarness(), new DeliveryOperations(value.store, fake.port));
    await controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "merge_pull_request", value.local.headSha, value.review);
    expect(fake.calls).toContain("merge");
    expect(value.store.get("task").status).toBe("delivered");
  });
});
