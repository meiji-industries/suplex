import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { DeliveryOperations, type DeliveryGithubPort } from "../src/delivery-operations.js";
import type { GithubReleaseAdapter, GithubPullRequest, GithubPullRequestObservation, LocalRevision } from "../src/github-delivery.js";
import { RootController } from "../src/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { TaskControlStore } from "../src/root-session-store.js";
import { runCommand } from "../src/command-runner.js";
import { inspectDeliveryDiff } from "../src/delivery-review.js";

const run = (command: string, args: string[]) => runCommand({ command, args, taskId: null, stepId: null });
const cleanup: string[] = [];

async function revision(cwd: string): Promise<LocalRevision> {
  const [branch, headSha, treeSha, status] = await Promise.all([
    run("git", ["-C", cwd, "branch", "--show-current"]),
    run("git", ["-C", cwd, "rev-parse", "HEAD"]),
    run("git", ["-C", cwd, "rev-parse", "HEAD^{tree}"]),
    run("git", ["-C", cwd, "status", "--porcelain"]),
  ]);
  return { branch: branch.stdout.trim(), headSha: headSha.stdout.trim(), treeSha: treeSha.stdout.trim(), clean: status.stdout.trim() === "" };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-delivery-"));
  cleanup.push(directory);
  await run("git", ["init", "-b", "task-branch", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test"]);
  await run("git", ["-C", directory, "commit", "--allow-empty", "-m", "seed"]);
  const local = await revision(directory);
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
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
  let observed: GithubPullRequestObservation = { exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1, runs: [] }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: "APPROVED" };
  const pull = (): GithubPullRequest => ({ number: 7, url: "https://github.com/owner/repo/pull/7", repository: "owner/repo", headBranch: local.branch, baseBranch: "main", headSha: observed.headSha!, baseSha: "base", isDraft: observed.isDraft ?? false, state: observed.state!, mergedAt: observed.state === "merged" ? new Date().toISOString() : null });
  const port: GithubReleaseAdapter & DeliveryGithubPort = {
    markReadyForReview: async () => { calls.push("ready"); observed = { ...observed, isDraft: false }; },
    checkAuthentication: async () => {}, getRemoteRepository: async () => { calls.push("remote"); return "owner/repo"; }, getBranchHead: async () => local.headSha, inspectLocalRevision: async () => { calls.push("inspect"); return local; }, pushNormal: async () => { calls.push("push"); }, listPullRequests: async () => [pull()], createDraftPullRequest: async () => pull(), updateDraftPullRequest: async () => pull(), getPullRequest: async () => { calls.push("get"); return pull(); }, observePullRequest: async () => { calls.push("observe"); return observed; }, mergePullRequest: async () => { calls.push("merge"); observed = { ...observed, state: "merged" }; },
  };
  return { calls, port, setObserved: (value: GithubPullRequestObservation) => { observed = value; } };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Coordinator delivery operations", () => {
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
      await run("git", ["-C", value.directory, "add", "unrelated-refactor.ts"]);
      await run("git", ["-C", value.directory, "commit", "-m", "Unrelated unpublished main work"]);
      await writeFile(join(value.directory, "task.ts"), "export const task = true;\n");
      await run("git", ["-C", value.directory, "add", "task.ts"]);
      await run("git", ["-C", value.directory, "commit", "-m", "Task change"]);
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
