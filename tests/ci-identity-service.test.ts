import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { CiService, type CheckObservation, type CiProvider, type PullRequestObservation } from "../src/ci.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const now = "2026-08-29T12:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const otherSha = "d".repeat(40);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(observedOverrides: Partial<PullRequestObservation> = {}) {
  const root = await mkdtemp(join(tmpdir(), "forge-ci-identity-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'company-a/brief-a', ?)").run("e".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Task A', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'task-a-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-a', 'task-a', 'company-a', 'workflow-a', 'release-key-a', 'acme/forge', 'feature/task', 'main', ?, ?, ?, 'draft', 7, 'https://github.com/acme/forge/pull/7', 'Task A', ?, ?)").run(baseSha, headSha, treeSha, now, now);
  });
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  const taskConfiguration = await artifacts.putArtifact("company-a", "task-project-configuration", {
    taskId: "task-a",
    filename: "project-configuration-task-a.json",
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify({
      projectId: "project-a",
      projectName: "Project A",
      repositoryPath: join(root, "repo"),
      worktreeRoot: join(root, "worktrees"),
      repository: "acme/forge",
      baseBranch: "main",
      targetBranch: "main",
      baseSha,
      targetSha: headSha,
      setupCommand: "pnpm install",
      verificationCommand: "pnpm test",
      requiredChecks: ["Tests / unit"],
      roleAgents: { builder: "builder-a" },
      roleProfiles: { builder: "builder-a" },
      capturedAt: now,
    })),
  });
  database.authQuery((db) => db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-a'").run(taskConfiguration.id, now));

  const observed: PullRequestObservation = {
    repository: "acme/forge",
    number: 7,
    url: "https://github.com/acme/forge/pull/7",
    state: "open",
    mergedAt: null,
    draft: true,
    baseBranch: "main",
    baseSha,
    headBranch: "feature/task",
    headSha,
    mergeStateStatus: "CLEAN",
    ...observedOverrides,
  };
  const check: CheckObservation = {
    providerCheckId: "1",
    name: "Tests / unit",
    headSha,
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: now,
    completedAt: now,
    summary: "ok",
  };
  let pullRequests = 0;
  let checkLists = 0;
  const provider: CiProvider = {
    async getPullRequest() { pullRequests += 1; return observed; },
    async listChecks() { checkLists += 1; return [check]; },
  };
  return {
    database,
    service: new CiService(database, provider, artifacts, () => new Date(now)),
    calls: () => ({ pullRequests, checkLists }),
  };
}

const reconcileInput = { taskId: "task-a", companyId: "company-a", releaseId: "release-a", expectedHeadSha: headSha, attemptNumber: 1 };

test.each([
  ["repository", { repository: "other/forge" }],
  ["pull request", { number: 8 }],
  ["base branch", { baseBranch: "develop" }],
  ["head branch", { headBranch: "other/task" }],
  ["head SHA", { headSha: otherSha }],
] satisfies Array<[string, Partial<PullRequestObservation>]>)
("CI persists drift evidence without adopting an observed %s", async (_label, drift) => {
  const value = await fixture(drift);
  const first = await value.service.reconcile(reconcileInput);
  const replay = await value.service.reconcile(reconcileInput);

  expect(first).toMatchObject({ outcome: "stale_head", reason: "pull_request_identity_changed", expectedHeadSha: headSha });
  expect(replay).toMatchObject({ attemptId: first.attemptId, outcome: "stale_head", expectedHeadSha: headSha });
  expect(value.calls()).toEqual({ pullRequests: 1, checkLists: 0 });
  expect(value.database.authQuery((db) => db.prepare("SELECT repository, base_branch AS baseBranch, head_branch AS headBranch, head_sha AS headSha, head_tree AS headTree FROM forge_releases WHERE id = 'release-a'").get())).toEqual({ repository: "acme/forge", baseBranch: "main", headBranch: "feature/task", headSha, headTree: treeSha });
  expect(value.database.authQuery((db) => db.prepare("SELECT expected_head_sha AS expectedHeadSha FROM forge_ci_runs WHERE release_id = 'release-a'").get())).toEqual({ expectedHeadSha: headSha });
});

test("CI exact identity passes once and replays the persisted attempt", async () => {
  const value = await fixture();
  const first = await value.service.reconcile(reconcileInput);
  const replay = await value.service.reconcile(reconcileInput);

  expect(first).toMatchObject({ outcome: "passed", reason: "checks_passed", expectedHeadSha: headSha, policy: { acceptedConclusions: ["success"] } });
  expect(replay).toMatchObject({ attemptId: first.attemptId, outcome: "passed", expectedHeadSha: headSha });
  expect(value.calls()).toEqual({ pullRequests: 1, checkLists: 1 });
  expect(value.database.authQuery((db) => db.prepare("SELECT head_sha AS headSha, head_tree AS headTree FROM forge_releases WHERE id = 'release-a'").get())).toEqual({ headSha, headTree: treeSha });
});
