import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { AcceptanceFailure, AcceptanceService, type AcceptanceInput } from "../src/acceptance.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAcceptancePort, GithubPullRequest } from "../src/github-release.js";

const now = "2026-09-01T12:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const otherSha = "d".repeat(40);
const cleanups: Array<() => Promise<void>> = [];

interface Fixture {
  database: ForgeDatabase;
  service: AcceptanceService;
  setPullRequest(value: GithubPullRequest): void;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-acceptance-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user-a', 'User A', 'user-a', 'member', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('user-a', 'company-a', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'company-a/brief-a', ?)").run("e".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Task A', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'task-a-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-a', 'task-a', 'company-a', 'workflow-a', 'release-key-a', 'acme/forge', 'feature/task', 'main', ?, ?, ?, 7, 'https://github.test/acme/forge/pull/7', 'Task A', ?, ?)").run(baseSha, headSha, treeSha, now, now);
  });

  let pullRequest: GithubPullRequest = { number: 7, url: "https://github.test/acme/forge/pull/7", repository: "acme/forge", headBranch: "feature/task", baseBranch: "main", headSha, baseSha, isDraft: false, state: "open", mergedAt: null };
  const github: GithubAcceptancePort = {
    async getBranchHead() { return headSha; },
    async getPullRequest() { return pullRequest; },
    async markReadyForReview() { pullRequest = { ...pullRequest, isDraft: false }; },
  };
  return {
    database,
    service: new AcceptanceService(database, github, { now: () => new Date(now) }),
    setPullRequest(value) { pullRequest = value; },
  };
}

const input: AcceptanceInput = { taskId: "task-a", companyId: "company-a", workflowId: "workflow-a", actorUserId: "user-a", decision: "accept", expectedHeadSha: headSha };

test("accepts the observed pull-request head and records acceptance", async () => {
  const value = await fixture();

  await expect(value.service.accept(input)).resolves.toMatchObject({ status: "accepted" });
  expect(value.database.authQuery((db) => db.prepare("SELECT release_id AS releaseId, review_id AS reviewId, final_review_id AS finalReviewId, ci_run_id AS ciRunId, head_sha AS headSha, status FROM forge_acceptances WHERE task_id = 'task-a'").get())).toEqual({ releaseId: "release-a", reviewId: null, finalReviewId: null, ciRunId: null, headSha, status: "accepted" });
});

test("refuses a changed observed pull-request head without recording acceptance", async () => {
  const value = await fixture();
  value.setPullRequest({ number: 7, url: "https://github.test/acme/forge/pull/7", repository: "acme/forge", headBranch: "feature/task", baseBranch: "main", headSha: otherSha, baseSha, isDraft: false, state: "open", mergedAt: null });

  await expect(value.service.accept(input)).rejects.toMatchObject({ name: "AcceptanceFailure", code: "stale" } satisfies Pick<AcceptanceFailure, "name" | "code">);
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_acceptances WHERE task_id = 'task-a'").get())).toEqual({ count: 0 });
});
