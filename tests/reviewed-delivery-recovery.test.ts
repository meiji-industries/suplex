import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/engine/activities.js";
import type { RecoverRevalidatedDeliveryReviewInput } from "../src/engine/issue-contracts.js";
import { createGithubReleasePort, type GithubReleaseAdapter } from "../src/github-release.js";

const now = "2026-08-30T20:00:00.000Z";
const taskId = "task-reviewed-recovery";
const companyId = "company-reviewed-recovery";
const projectId = "project-reviewed-recovery";
const workflowId = "workflow-reviewed-recovery";
const mergeId = "merge-reviewed-recovery";
const developerExecutionId = "developer-reviewed-recovery";
const reviewId = "review-reviewed-recovery";
const attemptId = "review-attempt-reviewed-recovery";
const branchName = "forge/task-reviewed-recovery";
const expectedBase = "a".repeat(40);
const currentBase = "b".repeat(40);
const wrongSha = "f".repeat(40);
const cleanups: Array<() => Promise<void>> = [];

type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-reviewed-delivery-recovery-"));
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, "task-reviewed-recovery");
  const repositoryPath = join(root, "repository");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await git(worktreePath, "init", "-b", branchName);
  await git(worktreePath, "config", "user.email", "forge@example.test");
  await git(worktreePath, "config", "user.name", "Forge Test");
  await writeFile(join(worktreePath, "reviewed.txt"), "prior\n", "utf8");
  await git(worktreePath, "add", "reviewed.txt");
  await git(worktreePath, "commit", "-m", "prior");
  const priorHead = await git(worktreePath, "rev-parse", "HEAD");
  const priorTree = await git(worktreePath, "rev-parse", "HEAD^{tree}");
  await writeFile(join(worktreePath, "reviewed.txt"), "reviewed\n", "utf8");
  await git(worktreePath, "add", "reviewed.txt");
  await git(worktreePath, "commit", "-m", "reviewed");
  const resultHead = await git(worktreePath, "rev-parse", "HEAD");
  const resultTree = await git(worktreePath, "rev-parse", "HEAD^{tree}");
  await git(worktreePath, "remote", "add", "origin", "https://github.com/acme/forge.git");

  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, 'Reviewed recovery', 'active', ?)").run(companyId, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES (?, ?, 'Reviewed recovery', ?, ?, 'acme/forge', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(projectId, companyId, repositoryPath, worktreeRoot, now, now);
  });
  const brief = await artifacts.putArtifact(companyId, "task-brief", { taskId, filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("Recover the reviewed delivery") });
  const configuration = await artifacts.putArtifact(companyId, "task-project-configuration", { taskId, filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({
    projectId,
    projectName: "Reviewed recovery",
    repositoryPath,
    worktreeRoot,
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
  })) });
  const leadOutput = await artifacts.putArtifact(companyId, "lead-plan", { taskId, filename: "lead-plan.json", mimeType: "application/json", bytes: Buffer.from("{\"kind\":\"plan\"}") });
  const delivery = await artifacts.putArtifact(companyId, "forward-merge-delivery", { taskId, filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{\"summary\":\"reviewed\"}") });
  const developerEvidence = await artifacts.putArtifact(companyId, "agent-evidence", { taskId, filename: "developer-evidence.md", mimeType: "text/markdown", bytes: Buffer.from("Developer evidence") });
  const verification = await artifacts.putArtifact(companyId, "forward-merge-verification", { taskId, filename: "verification.json", mimeType: "application/json", bytes: Buffer.from("{\"outcome\":\"completed\"}") });
  const opinion = await artifacts.putArtifact(companyId, "delivery-review", { taskId, filename: "review.md", mimeType: "text/markdown", bytes: Buffer.from("Approved") });
  const reviewEvidence = await artifacts.putArtifact(companyId, "agent-evidence", { taskId, filename: "review-evidence.md", mimeType: "text/markdown", bytes: Buffer.from("Review evidence") });

  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, project_configuration_artifact_id, project_configuration_captured_at, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'Reviewed delivery recovery', ?, '[]', '{}', 0, ?, ?, ?, ?, 'reviewed-recovery-key', ?, ?)").run(taskId, companyId, projectId, brief.id, workflowId, configuration.id, configuration.id, now, now, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, heartbeat_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, execution_kind) VALUES (?, ?, ?, ?, 3, 3, 'completed', ?, ?, ?, 'developer-session', ?, ?, ?, ?, ?, 'clean', ?, ?, 'forward_merge')").run(developerExecutionId, taskId, companyId, workflowId, branchName, worktreePath, currentBase, now, now, now, resultHead, resultTree, delivery.id, developerEvidence.id);
    db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, verification_artifact_sha256, delivery_artifact_id, delivery_artifact_sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'merged', '[]', ?, ?, ?, 'ci_update_from_base', ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(mergeId, taskId, companyId, expectedBase, currentBase, priorHead, resultHead, resultTree, now, workflowId, configuration.id, priorTree, resultHead, resultTree, developerExecutionId, verification.id, verification.sha256, delivery.id, delivery.sha256, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('lead-reviewed-recovery', ?, ?, ?, 'reviewer', 'completed', 1, 'review-session', ?, ?, ?)").run(taskId, companyId, workflowId, now, now, reviewEvidence.id);
    db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, repair_cycle, created_at) VALUES (?, ?, ?, ?, 3, ?, ?, ?, 'lead-reviewed-recovery', 'review-session', 'approved', 'Approved reviewed delivery', ?, ?, 0, ?)").run(reviewId, taskId, companyId, workflowId, currentBase, resultHead, resultTree, opinion.id, reviewEvidence.id, now);
    db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref, status, correction_attempts, evidence_artifact_id, completed_review_id, created_at, finished_at) VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, 'lead-reviewed-recovery', 'lead-plan-session', 'developer-session', 'completed', 0, ?, ?, ?, ?)").run(attemptId, taskId, companyId, workflowId, currentBase, resultHead, resultTree, developerExecutionId, delivery.id, developerEvidence.id, reviewEvidence.id, reviewId, now, now);
  });

  let providerMutations = 0;
  const realGithub = createGithubReleasePort();
  const github: GithubReleaseAdapter = {
    ...realGithub,
    async pushNormal() { providerMutations += 1; },
    async createDraftPullRequest() { providerMutations += 1; throw new Error("Unexpected provider mutation"); },
    async updateDraftPullRequest() { providerMutations += 1; throw new Error("Unexpected provider mutation"); },
    async markReadyForReview() { providerMutations += 1; },
  };
  const activities = createActivities(database, config, { githubRelease: github });
  const input: RecoverRevalidatedDeliveryReviewInput = {
    taskId,
    companyId,
    workflowId,
    projectId,
    projectRevisionId: configuration.id,
    forwardMergeId: mergeId,
    developerExecutionId,
    branchName,
    worktreePath,
    forwardMergePriorHead: priorHead,
    forwardMergePriorTree: priorTree,
    forwardMergeTargetBaseSha: currentBase,
    developerSessionRef: "developer-session",
    deliveryArtifactId: delivery.id,
    developerEvidenceArtifactId: developerEvidence.id,
    leadSessionRef: "lead-plan-session",
    leadOutputArtifactId: leadOutput.id,
  };
  return {
    root, worktreeRoot, worktreePath, database, activities, input,
    resultHead, resultTree, delivery, reviewEvidence,
    providerMutations: () => providerMutations,
  };
}

async function recover(value: Fixture, override: Partial<RecoverRevalidatedDeliveryReviewInput> = {}) {
  return value.activities.recoverRevalidatedDeliveryReview({ ...value.input, ...override });
}

function addHerdrTurn(value: Fixture, status: "completed" | "waiting") {
  value.database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, status, created_at, updated_at) VALUES ('role-session-recovery', ?, 'builder', 1, 1, 'codex', 'working', ?, ?)").run(taskId, now, now);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_start_offset, rollout_cursor_offset, correction_index, status, created_at, updated_at, finished_at) VALUES ('turn-recovery', ?, 'role-session-recovery', 'builder', 'developer', ?, 'forward-merge', ?, 'turn-result.json', 0, 0, 0, ?, ?, ?, ?)").run(taskId, developerExecutionId, "1".repeat(64), status, now, now, status === "completed" ? now : null);
  });
}

test("recovers the one approved reviewed subject without a Herdr history or mutation", async () => {
  const value = await fixture();
  const before = value.database.authQuery((db) => ({
    merges: db.prepare("SELECT COUNT(*) AS count FROM forge_forward_merges").get(),
    executions: db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions").get(),
    reviews: db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_reviews").get(),
  }));

  await expect(recover(value)).resolves.toMatchObject({
    outcome: "recovered",
    forwardMergeId: mergeId,
    checkpoint: "ci_update_from_base",
    developerExecutionId,
    targetBaseSha: currentBase,
    subjectCommit: value.resultHead,
    subjectTree: value.resultTree,
    review: { outcome: "completed", attemptId, review: { reviewId, opinion: "approved" } },
  });

  expect(value.database.authQuery((db) => ({
    merges: db.prepare("SELECT COUNT(*) AS count FROM forge_forward_merges").get(),
    executions: db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions").get(),
    reviews: db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_reviews").get(),
  }))).toEqual(before);
  expect(value.providerMutations()).toBe(0);
});

test("accepts terminal Herdr history but rejects a current active Developer turn", async () => {
  const terminal = await fixture();
  addHerdrTurn(terminal, "completed");
  await expect(recover(terminal)).resolves.toMatchObject({ outcome: "recovered", subjectCommit: terminal.resultHead });

  const active = await fixture();
  addHerdrTurn(active, "waiting");
  await expect(recover(active)).resolves.toMatchObject({ outcome: "blocked", code: "worktree-unsafe" });
  expect(active.providerMutations()).toBe(0);
});

test.each([
  ["task", { taskId: "task-wrong" }],
  ["company", { companyId: "company-wrong" }],
  ["workflow", { workflowId: "workflow-wrong" }],
  ["project", { projectId: "project-wrong" }],
  ["project revision", { projectRevisionId: "artifact-wrong" }],
] as const)("rejects a wrong %s scope", async (_label, override) => {
  const value = await fixture();
  await expect(recover(value, override)).resolves.toMatchObject({ outcome: "blocked", code: "subject-changed" });
  expect(value.providerMutations()).toBe(0);
});

test.each([
  ["missing merge", (value: Fixture) => value.database.authQuery((db) => db.prepare("DELETE FROM forge_forward_merges WHERE id = ?").run(mergeId))],
  ["base", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET current_base_sha = ? WHERE id = ?").run(wrongSha, mergeId))],
  ["head", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET result_head = ? WHERE id = ?").run(wrongSha, mergeId))],
  ["tree", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET result_tree = ? WHERE id = ?").run(wrongSha, mergeId))],
  ["Developer result", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET result_commit = ? WHERE id = ?").run(wrongSha, developerExecutionId))],
  ["artifact kind", (value: Fixture) => value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET kind = 'agent-evidence' WHERE id = ?").run(value.delivery.id))],
] as const)("rejects mismatched %s provenance", async (_label, mutate) => {
  const value = await fixture();
  mutate(value);
  await expect(recover(value)).resolves.toMatchObject({ outcome: "blocked", code: "subject-changed" });
  expect(value.providerMutations()).toBe(0);
});

test("rejects duplicate completed review provenance", async () => {
  const value = await fixture();
  value.database.authTransaction((db) => db.prepare(`INSERT INTO forge_delivery_review_attempts
    (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree,
     developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id,
     lead_session_ref, developer_session_ref, status, correction_attempts, evidence_artifact_id,
     completed_review_id, created_at, finished_at)
    SELECT 'review-attempt-duplicate', task_id, company_id, workflow_id, plan_revision, base_sha,
      subject_commit, subject_tree, developer_execution_id, delivery_artifact_id,
      developer_evidence_artifact_id, lead_execution_id, lead_session_ref, developer_session_ref,
      status, correction_attempts, evidence_artifact_id, completed_review_id, created_at, finished_at
    FROM forge_delivery_review_attempts WHERE id = ?`).run(attemptId));
  await expect(recover(value)).resolves.toMatchObject({ outcome: "blocked", code: "subject-changed" });
});

test("rejects a mismatched branch or registered worktree", async () => {
  const branch = await fixture();
  await expect(recover(branch, { branchName: "forge/other" })).resolves.toMatchObject({ outcome: "blocked", code: "subject-changed" });

  const worktree = await fixture();
  await expect(recover(worktree, { worktreePath: join(worktree.worktreeRoot, "other") })).resolves.toMatchObject({ outcome: "blocked", code: "subject-changed" });
});

test("rejects a live The Builder works on the task on the task worktree", async () => {
  const value = await fixture();
  value.database.authTransaction((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, execution_kind) VALUES ('developer-active-recovery', ?, ?, ?, 3, 4, 'running', ?, ?, ?, ?, 'agent')").run(taskId, companyId, workflowId, branchName, value.worktreePath, currentBase, now));
  await expect(recover(value)).resolves.toMatchObject({ outcome: "blocked", code: "worktree-unsafe" });
});

test.each([
  ["wrong origin", async (value: Fixture) => { await git(value.worktreePath, "remote", "set-url", "origin", "https://github.com/acme/other.git"); }],
  ["dirty worktree", async (value: Fixture) => { await writeFile(join(value.worktreePath, "dirty.txt"), "dirty\n", "utf8"); }],
  ["detached worktree", async (value: Fixture) => { await git(value.worktreePath, "checkout", "--detach"); }],
  ["missing worktree", async (value: Fixture) => { await rm(value.worktreePath, { recursive: true, force: true }); }],
  ["changed head and tree", async (value: Fixture) => {
    await writeFile(join(value.worktreePath, "later.txt"), "later\n", "utf8");
    await git(value.worktreePath, "add", "later.txt");
    await git(value.worktreePath, "commit", "-m", "later");
  }],
] as const)("rejects a %s", async (_label, mutate) => {
  const value = await fixture();
  await mutate(value);
  await expect(recover(value)).resolves.toMatchObject({ outcome: "blocked", code: "worktree-unsafe" });
  expect(value.providerMutations()).toBe(0);
});
