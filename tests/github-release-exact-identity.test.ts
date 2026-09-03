import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { GithubReleaseFailure, ReleaseService, type GithubPullRequest, type GithubReleasePort, type LocalRevision, type PublishReleaseInput } from "../src/github-release.js";

const now = "2026-08-29T12:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const otherSha = "d".repeat(40);
const cleanups: Array<() => Promise<void>> = [];

interface ReleaseFixture {
  database: ForgeDatabase;
  service: ReleaseService;
  input: PublishReleaseInput;
  setLocal(value: LocalRevision): void;
  setRemoteBase(value: string): void;
  setRemoteHead(value: string | null): void;
  setPullRequest(value: GithubPullRequest | null): void;
  mutations(): { pushes: number; creates: number; updates: number };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(): Promise<ReleaseFixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-release-identity-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'company-a/brief-a', ?)").run("e".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Task A', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'task-a-key', ?, ?)").run(now, now);
    for (const [id, kind] of [["opinion-a", "agent-opinion"], ["evidence-a", "agent-evidence"]] as const) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company-a', ?, ?, 'text/markdown', 1, ?, ?, ?)").run(id, kind, `${id}.md`, "f".repeat(64), `company-a/${id}`, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('lead-a', 'task-a', 'company-a', 'workflow-a', 'planner', 'completed', 1, 'lead-session', ?)").run(now);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES ('review-a', 'task-a', 'company-a', 'workflow-a', 1, ?, ?, ?, 'lead-a', 'lead-session', 'approved', 'Approved exact delivery', 'opinion-a', 'evidence-a', 0, ?)").run(baseSha, headSha, treeSha, now);
  });

  let local: LocalRevision = { branch: "feature/task", headSha, treeSha, clean: true };
  let remoteBase = baseSha;
  let remoteHead: string | null = null;
  let pullRequest: GithubPullRequest | null = null;
  let pushes = 0;
  let creates = 0;
  let updates = 0;
  const github: GithubReleasePort = {
    async checkAuthentication() {},
    async getRemoteRepository() { return "acme/forge"; },
    async getBranchHead({ branch }) { return branch === "main" ? remoteBase : remoteHead; },
    async inspectLocalRevision() { return local; },
    async pushNormal() { pushes += 1; remoteHead = local.headSha; },
    async listPullRequests() { return pullRequest ? [pullRequest] : []; },
    async createDraftPullRequest(input) {
      creates += 1;
      if (pullRequest) throw new GithubReleaseFailure("ambiguous-provider-state", "An open pull request already exists");
      pullRequest = { number: 7, url: "https://github.com/acme/forge/pull/7", repository: input.repository, headBranch: input.headBranch, baseBranch: input.baseBranch, headSha: local.headSha, baseSha: remoteBase, isDraft: true, state: "open", mergedAt: null };
      return pullRequest;
    },
    async updateDraftPullRequest() { updates += 1; return pullRequest!; },
    async getPullRequest() { if (!pullRequest) throw new Error("Pull request is absent"); return pullRequest; },
  };
  const service = new ReleaseService(database, new ArtifactStore(config.artifactRoot), github);
  return {
    database,
    service,
    input: {
      taskId: "task-a",
      companyId: "company-a",
      workflowId: "workflow-a",
      coordinates: { projectRevisionId: "revision-a", repositoryPath: join(root, "repo"), worktreePath: join(root, "worktree"), repository: "acme/forge", owner: "acme", headBranch: "feature/task", baseBranch: "main", expectedBaseSha: baseSha },
      reviewedRevision: { reviewId: "review-a", developerExecutionId: "developer-a", commitSha: headSha, treeSha },
      taskTitle: "Task A",
      delivery: {},
    },
    setLocal(value: LocalRevision) { local = value; },
    setRemoteBase(value: string) { remoteBase = value; },
    setRemoteHead(value: string | null) { remoteHead = value; },
    setPullRequest(value: GithubPullRequest | null) { pullRequest = value; },
    mutations: () => ({ pushes, creates, updates }),
  };
}

async function expectNoPublication(value: ReleaseFixture, code: GithubReleaseFailure["code"]) {
  await expect(value.service.publish(value.input)).rejects.toMatchObject({ code });
  expect(value.mutations()).toEqual({ pushes: 0, creates: 0, updates: 0 });
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_releases WHERE task_id = 'task-a'").get())).toEqual({ count: 0 });
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_provider_operations WHERE task_id = 'task-a'").get())).toEqual({ count: 0 });
}

test.each([
  ["head", { branch: "feature/task", headSha: otherSha, treeSha, clean: true }],
  ["tree", { branch: "feature/task", headSha, treeSha: otherSha, clean: true }],
] satisfies Array<[string, LocalRevision]>)
("release blocks a changed local %s after review without provider mutation", async (_label, local) => {
  const value = await fixture();
  value.setLocal(local);
  await expectNoPublication(value, "stale-reviewed-revision");
});

test("release blocks target-base drift before provider mutation or release persistence", async () => {
  const value = await fixture();
  value.setRemoteBase(otherSha);
  await expectNoPublication(value, "target-base-drift");
});

test("release blocks a changed remote task branch before provider mutation or release persistence", async () => {
  const value = await fixture();
  value.setRemoteHead(otherSha);
  await expectNoPublication(value, "remote-head-conflict");
});

test("release rejects an existing release whose pull-request head changed after review", async () => {
  const value = await fixture();
  const published = await value.service.publish(value.input);
  value.setPullRequest({ ...published.pullRequest, headSha: otherSha });

  await expect(value.service.publish({ ...value.input, releaseId: published.releaseId })).rejects.toMatchObject({ code: "ambiguous-provider-state" });
  expect(value.database.authQuery((db) => db.prepare("SELECT head_sha AS headSha FROM forge_releases WHERE id = ?").get(published.releaseId))).toEqual({ headSha });
});

test("release rejects a replayed release whose pull-request base changed after review without overwriting it", async () => {
  const value = await fixture();
  const published = await value.service.publish(value.input);
  const beforeReplay = value.database.authQuery((db) => db.prepare("SELECT base_sha AS baseSha, head_sha AS headSha, head_tree AS headTree, title, body_artifact_id AS bodyArtifactId, reused FROM forge_releases WHERE id = ?").get(published.releaseId));
  value.setPullRequest({ ...published.pullRequest, baseSha: otherSha });

  await expect(value.service.publish({ ...value.input, releaseId: published.releaseId })).rejects.toMatchObject({ code: "ambiguous-provider-state" });
  expect(value.database.authQuery((db) => db.prepare("SELECT base_sha AS baseSha, head_sha AS headSha, head_tree AS headTree, title, body_artifact_id AS bodyArtifactId, reused FROM forge_releases WHERE id = ?").get(published.releaseId))).toEqual(beforeReplay);
});

test("release never reuses an open pull request whose head differs from the reviewed commit", async () => {
  const value = await fixture();
  value.setRemoteHead(headSha);
  value.setPullRequest({ number: 7, url: "https://github.com/acme/forge/pull/7", repository: "acme/forge", headBranch: "feature/task", baseBranch: "main", headSha: otherSha, baseSha, isDraft: true, state: "open", mergedAt: null });

  await expect(value.service.publish(value.input)).rejects.toMatchObject({ code: "ambiguous-provider-state" });
  expect(value.database.authQuery((db) => db.prepare("SELECT head_sha AS headSha, pr_number AS pullRequestNumber FROM forge_releases WHERE task_id = 'task-a'").get())).toEqual({ headSha, pullRequestNumber: null });
});

test("release never reuses or persists an open pull request whose base differs from the reviewed base", async () => {
  const value = await fixture();
  value.setRemoteHead(headSha);
  value.setPullRequest({ number: 7, url: "https://github.com/acme/forge/pull/7", repository: "acme/forge", headBranch: "feature/task", baseBranch: "main", headSha, baseSha: otherSha, isDraft: true, state: "open", mergedAt: null });

  await expect(value.service.publish(value.input)).rejects.toMatchObject({ code: "ambiguous-provider-state" });
  expect(value.database.authQuery((db) => db.prepare("SELECT base_sha AS baseSha, head_sha AS headSha, pr_number AS pullRequestNumber FROM forge_releases WHERE task_id = 'task-a'").get())).toEqual({ baseSha, headSha, pullRequestNumber: null });
});

test("release publishes the exact reviewed revision once and replays idempotently", async () => {
  const value = await fixture();
  const first = await value.service.publish(value.input);
  const replay = await value.service.publish(value.input);

  expect(first).toMatchObject({ repository: "acme/forge", branchName: "feature/task", baseBranch: "main", headSha, headTree: treeSha, reused: false, pullRequest: { number: 7, headSha, baseSha } });
  expect(replay).toMatchObject({ releaseId: first.releaseId, headSha, headTree: treeSha, reused: true, pullRequest: { number: 7, headSha, baseSha } });
  expect(value.mutations()).toEqual({ pushes: 1, creates: 1, updates: 0 });
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_releases WHERE task_id = 'task-a'").get())).toEqual({ count: 1 });
  expect(value.database.authQuery((db) => db.prepare("SELECT repository, base_branch AS baseBranch, head_branch AS headBranch, base_sha AS baseSha, head_sha AS headSha, head_tree AS headTree FROM forge_releases WHERE id = ?").get(first.releaseId))).toEqual({ repository: "acme/forge", baseBranch: "main", headBranch: "feature/task", baseSha, headSha, headTree: treeSha });
});
