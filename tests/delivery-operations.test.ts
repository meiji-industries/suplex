import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { DeliveryOperations } from "../src/delivery-operations.js";
import type { GithubReleasePort, GithubPullRequest, GithubPullRequestObservation, LocalRevision } from "../src/github-release.js";
import { RootController } from "../src/root-controller.js";
import { TaskControlStore } from "../src/root-session-store.js";

const run = promisify(execFile);
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
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(directory, directory, stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), stamp, stamp);
  });
  const profile = { profileId: "profile", provider: "codex" as const, model: "gpt-5.6-sol", reasoningLevel: "medium" as const, serviceTier: "default" as const };
  const store = new TaskControlStore(database);
  store.create({ taskId: "task", objective: "Deliver the change", deliveryTarget: "merged", deliveryIntent: { repository: "owner/repo", headBranch: local.branch, baseBranch: "main", baselineSha: local.headSha, pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: directory, branch: local.branch, baseSha: local.headSha, headSha: local.headSha, dirty: false } });
  const root = store.claimRoot({ taskId: "task" });
  store.bindLive({ sessionId: root.id, generation: root.generation, paneId: "root-pane", agentName: "root" });
  return { database, directory, local, root, store };
}

function github(local: LocalRevision) {
  const calls: string[] = [];
  let observed: GithubPullRequestObservation = { exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: "APPROVED" };
  const pull = (): GithubPullRequest => ({ number: 7, url: "https://github.com/owner/repo/pull/7", repository: "owner/repo", headBranch: local.branch, baseBranch: "main", headSha: observed.headSha!, baseSha: "base", isDraft: false, state: observed.state!, mergedAt: observed.state === "merged" ? new Date().toISOString() : null });
  const port: GithubReleasePort = {
    checkAuthentication: async () => {}, getRemoteRepository: async () => { calls.push("remote"); return "owner/repo"; }, getBranchHead: async () => local.headSha, inspectLocalRevision: async () => { calls.push("inspect"); return local; }, pushNormal: async () => { calls.push("push"); }, listPullRequests: async () => [pull()], createDraftPullRequest: async () => pull(), updateDraftPullRequest: async () => pull(), getPullRequest: async () => { calls.push("get"); return pull(); }, observePullRequest: async () => { calls.push("observe"); return observed; }, mergePullRequest: async () => { calls.push("merge"); observed = { ...observed, state: "merged" }; },
  };
  return { calls, port, setObserved: (value: GithubPullRequestObservation) => { observed = value; } };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Root delivery operations", () => {
  it("uses no review receipt, rechecks the expected head, and adopts a known external merge without a worktree", async () => {
    const value = await fixture();
    const fake = github(value.local);
    const controller = new RootController(value.store, { runtimeSnapshot: async () => ({ agents: [], panes: [] }), prompt: async () => ({ name: "root", paneId: "root-pane" }), readAgent: async () => "" }, undefined, undefined, undefined, new DeliveryOperations(value.store, fake.port));
    const receipt = await controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "request_review", value.local.headSha);
    expect(receipt).toMatchObject({ headSha: value.local.headSha });
    fake.setObserved({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: "c".repeat(40), baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: "APPROVED" });
    await expect(controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "merge_after_approval", value.local.headSha)).rejects.toMatchObject({ code: "head_diverged" });
    expect(fake.calls).not.toContain("merge");
    fake.setObserved({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "merged", isDraft: false, headSha: value.local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 0, pending: 0, failing: 0, successful: 0 }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: null });
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
    fake.setObserved({ exists: true, number: 7, url: "https://github.com/owner/repo/pull/7", state: "open", isDraft: false, headSha: value.local.headSha, baseSha: "base", mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, author: null, changedFiles: 1, additions: 1, deletions: 0, autoMergeEnabled: false, reviewDecision: null });
    const controller = new RootController(value.store, { runtimeSnapshot: async () => ({ agents: [], panes: [] }), prompt: async () => ({ name: "root", paneId: "root-pane" }), readAgent: async () => "" }, undefined, undefined, undefined, new DeliveryOperations(value.store, fake.port));
    await controller.requestDelivery({ taskId: "task", sessionId: value.root.id, generation: value.root.generation }, "merge_after_approval", value.local.headSha);
    expect(fake.calls).toContain("merge");
    expect(value.store.get("task").status).toBe("delivered");
  });
});
