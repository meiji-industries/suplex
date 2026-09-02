import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/engine/activities.js";
import type { GithubPullRequest, GithubReleaseAdapter } from "../src/github-release.js";

const now = "2026-08-30T16:00:00.000Z";
const expectedBase = "a".repeat(40);
const intermediateBase = "7".repeat(40);
const currentBase = "b".repeat(40);
const priorHead = "c".repeat(40);
const priorTree = "d".repeat(40);
const intermediateHead = "1".repeat(40);
const intermediateTree = "2".repeat(40);
const resultHead = "e".repeat(40);
const resultTree = "f".repeat(40);
const wrongSha = "9".repeat(40);
const branchName = "issue/task-release-lineage";
const taskId = "task-release-lineage";
const companyId = "company-release-lineage";
const workflowId = "workflow-release-lineage";
const reviewId = "review-release-lineage";
const cleanups: Array<() => Promise<void>> = [];

type FixtureShape = "direct" | "completed-prior" | "blocked-chain" | "transitive" | "cross-execution";

type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(shape: FixtureShape) {
  const root = await mkdtemp(join(tmpdir(), "forge-release-forward-merge-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  const linkedExecutionId = shape === "blocked-chain" ? "developer-blocked" : shape === "cross-execution" ? "developer-origin" : "developer-current";
  const linkedWorktree = join(root, shape === "blocked-chain" ? "linked-worktree" : shape === "cross-execution" ? "origin-worktree" : "worktree");
  const ancestorExecutionId = "developer-forward-merge";
  const ambiguousAncestorExecutionId = "developer-forward-merge-ambiguous";

  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, 'Release lineage', 'active', ?)").run(companyId, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-release-lineage', ?, 'Release lineage', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(companyId, join(root, "repository"), join(root, "worktrees"), now, now);
  });
  const brief = await artifacts.putArtifact(companyId, "task-brief", { taskId, filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("Release exact reviewed forward merge", "utf8") });
  const configuration = await artifacts.putArtifact(companyId, "task-project-configuration", { taskId, filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({
    projectId: "project-release-lineage",
    projectName: "Release lineage",
    repositoryPath: join(root, "repository"),
    worktreeRoot: join(root, "worktrees"),
    repository: "acme/forge",
    baseBranch: "main",
    targetBranch: "main",
    baseSha: expectedBase,
    targetSha: priorHead,
    setupCommand: "true",
    verificationCommand: "true",
    requiredChecks: [],
    roleAgents: { builder: "builder" },
    roleProfiles: { builder: "builder" },
    capturedAt: now,
  }), "utf8") });
  const delivery = await artifacts.putArtifact(companyId, "developer-delivery", { taskId, filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({
    summary: "Inherited original Developer delivery",
    steps: [{ notes: "Preserved the reviewed implementation", filesChanged: ["src/reviewed.ts"], commandsRun: ["pnpm test"], testResults: ["all focused tests passed"] }],
  }), "utf8") });
  const verification = await artifacts.putArtifact(companyId, "forward-merge-verification", { taskId, filename: "verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: "verification_failed", summary: "Lead reviewed the exact failed verification evidence" }), "utf8") });
  const ancestorVerification = await artifacts.putArtifact(companyId, "forward-merge-verification", { taskId, filename: "ancestor-verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: "verification_failed", summary: "Lead reviewed the exact ancestor verification evidence" }), "utf8") });
  const developerEvidence = await artifacts.putArtifact(companyId, "agent-evidence", { taskId, filename: "developer-evidence.md", mimeType: "text/markdown", bytes: Buffer.from("Original Developer evidence", "utf8") });
  const opinion = await artifacts.putArtifact(companyId, "agent-opinion", { taskId, filename: "opinion.md", mimeType: "text/markdown", bytes: Buffer.from("Approved", "utf8") });
  const evidence = await artifacts.putArtifact(companyId, "agent-evidence", { taskId, filename: "evidence.md", mimeType: "text/markdown", bytes: Buffer.from("Exact merged subject reviewed", "utf8") });

  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, project_configuration_artifact_id, project_configuration_captured_at, idempotency_key, created_at, updated_at) VALUES (?, ?, 'project-release-lineage', 'Release exact forward merge', ?, '[]', '{}', 0, ?, 'revision-release-lineage', ?, ?, 'release-lineage-key', ?, ?)").run(taskId, companyId, brief.id, workflowId, configuration.id, now, now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead-release-lineage', ?, ?, ?, 'reviewer', 'completed', 1, 'lead-session', ?, ?, ?)").run(taskId, companyId, workflowId, now, now, evidence.id);
    const insertExecution = (id: string, attempt: number, status: string, worktreePath: string, targetBaseSha: string, resultCommit: string, resultTreeSha: string, supersedesExecutionId: string | null, deliveryArtifactId: string | null, evidenceArtifactId: string | null = null, executionKind = "agent") => {
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, session_ref, started_at, heartbeat_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, execution_kind) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'developer-session', ?, ?, ?, ?, ?, 'clean', ?, ?, ?)").run(id, taskId, companyId, workflowId, attempt, status, branchName, worktreePath, targetBaseSha, supersedesExecutionId, now, now, now, resultCommit, resultTreeSha, deliveryArtifactId, evidenceArtifactId, executionKind);
    };
    if (shape === "blocked-chain") {
      insertExecution("developer-origin", 1, "completed", join(root, "origin-worktree"), expectedBase, priorHead, priorTree, null, delivery.id);
      insertExecution("developer-middle", 2, "blocked", join(root, "middle-worktree"), currentBase, resultHead, resultTree, "developer-origin", null);
      insertExecution(linkedExecutionId, 3, "blocked", linkedWorktree, currentBase, resultHead, resultTree, "developer-middle", null);
    } else if (shape === "cross-execution") {
      insertExecution(linkedExecutionId, 1, "completed", linkedWorktree, expectedBase, priorHead, priorTree, null, delivery.id, developerEvidence.id);
      insertExecution(ancestorExecutionId, 2, "completed", join(root, "forward-merge-worktree"), intermediateBase, intermediateHead, intermediateTree, linkedExecutionId, delivery.id, developerEvidence.id, "forward_merge");
      insertExecution(ambiguousAncestorExecutionId, 3, "blocked", join(root, "ambiguous-forward-merge-worktree"), intermediateBase, intermediateHead, intermediateTree, linkedExecutionId, delivery.id, developerEvidence.id, "forward_merge");
    } else if (shape === "direct") {
      insertExecution(linkedExecutionId, 1, "completed", linkedWorktree, currentBase, resultHead, resultTree, null, delivery.id);
    } else {
      insertExecution(linkedExecutionId, 1, "completed", linkedWorktree, expectedBase, priorHead, priorTree, null, delivery.id);
    }
    if (shape === "transitive" || shape === "cross-execution") {
      db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, delivery_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-release-ancestor', ?, ?, ?, ?, ?, ?, ?, 'merged', '[]', ?, ?, ?, 'pre_release', ?, ?, ?, ?, ?, ?, 'verification_failed', 'Pinned ancestor verification failed', ?)").run(taskId, companyId, expectedBase, intermediateBase, priorHead, intermediateHead, intermediateTree, now, workflowId, configuration.id, priorTree, intermediateHead, intermediateTree, shape === "cross-execution" ? ancestorExecutionId : linkedExecutionId, ancestorVerification.id, delivery.id, now);
      db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, delivery_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-release-lineage', ?, ?, ?, ?, ?, ?, ?, 'merged', '[]', ?, ?, ?, 'pre_release', ?, ?, ?, ?, ?, ?, 'verification_failed', 'Pinned verification failed; Lead approved the exact result', ?)").run(taskId, companyId, intermediateBase, currentBase, intermediateHead, resultHead, resultTree, now, workflowId, configuration.id, intermediateTree, resultHead, resultTree, linkedExecutionId, verification.id, delivery.id, now);
    } else if (shape !== "direct") {
      db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, delivery_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-release-lineage', ?, ?, ?, ?, ?, ?, ?, 'merged', '[]', ?, ?, ?, 'pre_release', ?, ?, ?, ?, ?, ?, 'verification_failed', 'Pinned verification failed; Lead approved the exact result', ?)").run(taskId, companyId, expectedBase, currentBase, priorHead, resultHead, resultTree, now, workflowId, configuration.id, priorTree, resultHead, resultTree, linkedExecutionId, verification.id, delivery.id, now);
    }
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'lead-release-lineage', 'lead-session', 'approved', 'Approved exact merged subject', ?, ?, 0, ?)").run(reviewId, taskId, companyId, workflowId, currentBase, resultHead, resultTree, opinion.id, evidence.id, now);
  });

  let remoteHead: string | null = null;
  let pullRequest: GithubPullRequest | null = null;
  const calls = { authentication: 0, pushes: 0, creates: 0, inspectedCwds: [] as string[], pushedCwds: [] as string[] };
  const github: GithubReleaseAdapter = {
    async checkAuthentication() { calls.authentication += 1; },
    async getRemoteRepository({ cwd }) { calls.inspectedCwds.push(cwd); return "acme/forge"; },
    async getBranchHead({ branch }) { return branch === "main" ? currentBase : remoteHead; },
    async inspectLocalRevision({ cwd }) { calls.inspectedCwds.push(cwd); return { branch: branchName, headSha: resultHead, treeSha: resultTree, clean: true }; },
    async pushNormal({ cwd }) { calls.pushes += 1; calls.pushedCwds.push(cwd); remoteHead = resultHead; },
    async listPullRequests() { return pullRequest ? [pullRequest] : []; },
    async createDraftPullRequest(input) {
      calls.creates += 1;
      pullRequest = { number: 27, url: "https://github.test/acme/forge/pull/27", repository: input.repository, headBranch: input.headBranch, baseBranch: input.baseBranch, headSha: resultHead, baseSha: currentBase, isDraft: true, state: "open", mergedAt: null, title: input.title, body: input.body };
      return pullRequest;
    },
    async updateDraftPullRequest() { return pullRequest!; },
    async getPullRequest() { if (!pullRequest) throw new Error("Pull request is unavailable"); return pullRequest; },
    async markReadyForReview() { if (pullRequest) pullRequest = { ...pullRequest, isDraft: false }; },
  };
  const activities = createActivities(database, config, { githubRelease: github });
  return {
    database,
    artifacts,
    activities,
    linkedExecutionId,
    linkedWorktree,
    verificationArtifactId: verification.id,
    ancestorVerificationArtifactId: ancestorVerification.id,
    deliveryArtifactId: delivery.id,
    developerEvidenceArtifactId: developerEvidence.id,
    ancestorExecutionId,
    ambiguousAncestorExecutionId,
    calls,
    pushInput: { taskId, companyId, workflowId, branchName, commitSha: resultHead },
    publishInput: { taskId, companyId, workflowId, reviewId, developerExecutionId: linkedExecutionId, branchName, targetBaseSha: currentBase, subjectCommit: resultHead, subjectTree: resultTree },
  };
}

function historicalRows(value: Fixture) {
  return {
    executions: value.database.authQuery((db) => db.prepare("SELECT * FROM forge_developer_executions WHERE task_id = ? ORDER BY id").all(taskId)),
    merges: value.database.authQuery((db) => db.prepare("SELECT * FROM forge_forward_merges WHERE task_id = ? ORDER BY id").all(taskId)),
  };
}

async function expectPushAndPublication(value: Fixture) {
  await expect(value.activities.pushDeliveryBranch(value.pushInput)).resolves.toEqual({ repository: "acme/forge", branchName, commitSha: resultHead });
  const published = await value.activities.publishRelease(value.publishInput);
  expect(published).toMatchObject({ outcome: "completed", repository: "acme/forge", branchName, headSha: resultHead, headTree: resultTree, targetBaseSha: currentBase, pullRequestNumber: 27 });
  return published;
}

test("preserves the exact completed Developer release path", async () => {
  const value = await fixture("direct");
  const before = historicalRows(value);

  await expectPushAndPublication(value);

  expect(historicalRows(value)).toEqual(before);
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_forward_merges WHERE task_id = ?").get(taskId))).toEqual({ count: 0 });
});

test("pushes and publishes an approved failed-verification forward merge from a completed prior execution without rewriting it", async () => {
  const value = await fixture("completed-prior");
  const before = historicalRows(value);

  await expectPushAndPublication(value);

  expect(historicalRows(value)).toEqual(before);
  expect(value.calls.pushedCwds).toEqual([value.linkedWorktree]);
});

test("pushes and publishes an approved two-hop forward merge from the immutable Developer root", async () => {
  const value = await fixture("transitive");
  const before = historicalRows(value);

  await expectPushAndPublication(value);

  expect(historicalRows(value)).toEqual(before);
  expect(value.calls.pushedCwds).toEqual([value.linkedWorktree]);
  const body = value.database.authQuery((db) => db.prepare(`SELECT a.storage_path AS storagePath, a.sha256
    FROM forge_releases r JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id
    WHERE r.task_id = ?`).get(taskId) as { storagePath: string; sha256: string });
  const text = (await value.artifacts.getArtifact({ companyId, storagePath: body.storagePath, sha256: body.sha256 })).toString("utf8");
  expect(text).toContain("Inherited original Developer delivery");
  expect(text).toContain("Preserved the reviewed implementation");
  expect(text).toContain("all focused tests passed");
});

test("pushes and publishes an exact forward-merge lineage across execution IDs from the original Developer root", async () => {
  const value = await fixture("cross-execution");
  const before = historicalRows(value);

  expect(value.database.authQuery((db) => db.prepare(`SELECT id, status, result_commit AS resultCommit,
      result_tree AS resultTree, delivery_artifact_id AS deliveryArtifactId,
      evidence_artifact_id AS evidenceArtifactId
    FROM forge_developer_executions WHERE id = ?`).get(value.linkedExecutionId))).toEqual({
    id: value.linkedExecutionId,
    status: "completed",
    resultCommit: priorHead,
    resultTree: priorTree,
    deliveryArtifactId: value.deliveryArtifactId,
    evidenceArtifactId: value.developerEvidenceArtifactId,
  });
  expect(value.database.authQuery((db) => db.prepare(`SELECT m.id, m.developer_execution_id AS developerExecutionId,
      d.status AS developerStatus, d.execution_kind AS executionKind
    FROM forge_forward_merges m JOIN forge_developer_executions d ON d.id = m.developer_execution_id
    WHERE m.task_id = ? ORDER BY m.id`).all(taskId))).toEqual([
    { id: "merge-release-ancestor", developerExecutionId: value.ancestorExecutionId, developerStatus: "completed", executionKind: "forward_merge" },
    { id: "merge-release-lineage", developerExecutionId: value.linkedExecutionId, developerStatus: "completed", executionKind: "agent" },
  ]);

  await expectPushAndPublication(value);

  expect(historicalRows(value)).toEqual(before);
  expect(value.calls.pushedCwds).toEqual([value.linkedWorktree]);
  const body = value.database.authQuery((db) => db.prepare(`SELECT a.storage_path AS storagePath, a.sha256
    FROM forge_releases r JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id
    WHERE r.task_id = ?`).get(taskId) as { storagePath: string; sha256: string });
  const text = (await value.artifacts.getArtifact({ companyId, storagePath: body.storagePath, sha256: body.sha256 })).toString("utf8");
  expect(text).toContain("Inherited original Developer delivery");
  expect(text).toContain("Preserved the reviewed implementation");
  expect(text).toContain("all focused tests passed");
});

test("inherits the exact Developer delivery through a blocked execution supersedes chain for push and publication", async () => {
  const value = await fixture("blocked-chain");
  const before = historicalRows(value);

  const published = await expectPushAndPublication(value);

  expect(published).toMatchObject({ outcome: "completed" });
  expect(historicalRows(value)).toEqual(before);
  expect(value.calls.pushedCwds).toEqual([value.linkedWorktree]);
  expect(value.calls.inspectedCwds.every((cwd) => cwd === value.linkedWorktree)).toBe(true);
  const body = value.database.authQuery((db) => db.prepare(`SELECT a.storage_path AS storagePath, a.sha256
    FROM forge_releases r JOIN forge_artifacts a ON a.id = r.body_artifact_id AND a.company_id = r.company_id
    WHERE r.task_id = ?`).get(taskId) as { storagePath: string; sha256: string });
  const text = (await value.artifacts.getArtifact({ companyId, storagePath: body.storagePath, sha256: body.sha256 })).toString("utf8");
  expect(text).toContain("Inherited original Developer delivery");
  expect(text).toContain("Preserved the reviewed implementation");
  expect(text).toContain("all focused tests passed");
});

test("publishes through the uniquely matching completed execution when the state execution is stale", async () => {
  const value = await fixture("direct");

  await expect(value.activities.publishRelease({ ...value.publishInput, developerExecutionId: "developer-failed" })).resolves.toMatchObject({ outcome: "completed" });
});

test.each([
  ["none", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'failed' WHERE id = ?").run(value.linkedExecutionId))],
  ["two", (value: Fixture) => value.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, heartbeat_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id) VALUES ('developer-fallback-copy', ?, ?, ?, 1, 2, 'completed', ?, ?, ?, 'developer-session', ?, ?, ?, ?, ?, 'clean', ?)").run(taskId, companyId, workflowId, branchName, value.linkedWorktree, currentBase, now, now, now, resultHead, resultTree, value.deliveryArtifactId))],
] as const)("fails closed when fallback finds %s completed execution", async (_label, mutate) => {
  const value = await fixture("direct");
  mutate(value);

  await expect(value.activities.publishRelease({ ...value.publishInput, developerExecutionId: "developer-failed" })).resolves.toMatchObject({ outcome: "blocked", code: "stale-reviewed-revision" });
});

test.each([
  ["wrong review tree", "completed-prior", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_delivery_reviews SET subject_tree = ? WHERE id = ?").run(wrongSha, reviewId))],
  ["wrong verification artifact kind", "completed-prior", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET kind = 'agent-evidence' WHERE id = ?").run(value.verificationArtifactId))],
  ["broken supersedes lineage", "blocked-chain", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET supersedes_execution_id = 'developer-missing' WHERE id = ?").run(value.linkedExecutionId))],
  ["running linked execution", "blocked-chain", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running' WHERE id = ?").run(value.linkedExecutionId))],
  ["mismatched merge tree identity", "completed-prior", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET tree = ? WHERE id = 'merge-release-lineage'").run(wrongSha))],
  ["broken transitive head/tree link", "transitive", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET prior_tree = ? WHERE id = 'merge-release-lineage'").run(wrongSha))],
  ["broken transitive base continuity", "transitive", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET current_base_sha = ? WHERE id = 'merge-release-ancestor'").run(wrongSha))],
  ["untyped cross-execution verification artifact", "cross-execution", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET kind = 'agent-evidence' WHERE id = ?").run(value.ancestorVerificationArtifactId))],
  ["ambiguous cross-execution predecessor", "cross-execution", (value: Fixture) => value.database.authQuery((db) => db.prepare(`INSERT INTO forge_forward_merges (
      id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status,
      conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head,
      result_tree, developer_execution_id, verification_artifact_id, delivery_artifact_id, failure_code,
      failure_summary, updated_at)
    SELECT 'merge-release-ancestor-copy', task_id, company_id, expected_base_sha, current_base_sha, prior_head,
      merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint,
      prior_tree, result_head, result_tree, ?, verification_artifact_id,
      delivery_artifact_id, failure_code, failure_summary, updated_at
    FROM forge_forward_merges WHERE id = 'merge-release-ancestor'`).run(value.ambiguousAncestorExecutionId))],
  ["cyclic transitive predecessor", "transitive", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET expected_base_sha = ?, prior_head = ?, prior_tree = ? WHERE id = 'merge-release-ancestor'").run(currentBase, resultHead, resultTree))],
] as const)("fails closed for %s", async (_label, shape, mutate) => {
  const value = await fixture(shape);
  mutate(value);
  const before = historicalRows(value);

  await expect(value.activities.pushDeliveryBranch(value.pushInput)).rejects.toMatchObject({ type: "stale-reviewed-revision" });
  await expect(value.activities.publishRelease(value.publishInput)).resolves.toMatchObject({ outcome: "blocked", code: "stale-reviewed-revision" });

  expect(historicalRows(value)).toEqual(before);
  expect(value.calls).toMatchObject({ authentication: 0, pushes: 0, creates: 0, inspectedCwds: [], pushedCwds: [] });
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_provider_operations WHERE task_id = ?").get(taskId))).toEqual({ count: 0 });
});
