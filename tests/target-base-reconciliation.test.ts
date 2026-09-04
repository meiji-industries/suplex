import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForgeDatabase } from "../src/database.js";
import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { createActivities } from "../src/engine/activities.js";
import { ForwardMergeService } from "../src/forward-merge.js";
import { AcceptedProjectRevisionSchema } from "../src/projects.js";
import {
  IssueWorkflowStateSchema,
  ReconcileTargetBaseActivityInputSchema,
  ReconcileTargetBaseActivityResultSchema,
} from "../src/engine/issue-contracts.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "../src/engine/target-base.js";
import { at } from "../src/issue-phases.js";

const sha = (letter: string) => letter.repeat(40);
const artifact = { id: "artifact_forward", kind: "forward-merge-delivery" as const };
const run = async (command: string, args: string[], options: { cwd: string }) => {
  const result = await runCommand({ taskId: null, stepId: null, command, args, cwd: options.cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || `${command} exited ${result.exitCode}`);
  return result;
};

async function gitRepository(root: string): Promise<{ base: string; head: string }> {
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.name", "Forge Test"], { cwd: root });
  await run("git", ["config", "user.email", "forge@example.test"], { cwd: root });
  await writeFile(join(root, "base.txt"), "base\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "base"], { cwd: root });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await run("git", ["checkout", "-b", "issue/task-1"], { cwd: root });
  await writeFile(join(root, "issue.txt"), "issue\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "issue"], { cwd: root });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { base, head };
}

async function targetBaseActivityFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  const database = new ForgeDatabase(config.databasePath);
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  const repository = await gitRepository(repositoryPath);
  await run("git", ["remote", "add", "origin", repositoryPath], { cwd: repositoryPath });
  const priorTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();
  await run("git", ["checkout", "main"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "advanced.txt"), "advanced\n");
  await run("git", ["add", "advanced.txt"], { cwd: repositoryPath });
  await run("git", ["commit", "-m", "advance base"], { cwd: repositoryPath });
  const targetBase = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  await run("git", ["checkout", "issue/task-1"], { cwd: repositoryPath });
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, repositoryPath, now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
  });
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  const configuration = await artifacts.putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath, worktreeRoot: repositoryPath, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: repository.base, targetSha: repository.base, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
  const delivery = await artifacts.putArtifact("company-1", "developer-delivery", { taskId: "task-1", filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{}") });
  const evidence = await artifacts.putArtifact("company-1", "agent-evidence", { taskId: "task-1", filename: "evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
  database.authQuery((db) => db.prepare("UPDATE forge_tasks SET project_revision_id = ?, project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, configuration.id, now));
  return { root, config, database, repositoryPath, repository, run, priorTree, targetBase, now, artifacts, configuration, delivery, evidence };
}

async function mergeTargetBase(fixture: Awaited<ReturnType<typeof targetBaseActivityFixture>>) {
  await fixture.run("git", ["merge", "--no-ff", "--no-edit", fixture.targetBase], { cwd: fixture.repositoryPath });
  const mergedHead = (await fixture.run("git", ["rev-parse", "HEAD"], { cwd: fixture.repositoryPath })).stdout.trim();
  const mergedTree = (await fixture.run("git", ["rev-parse", "HEAD^{tree}"], { cwd: fixture.repositoryPath })).stdout.trim();
  return { mergedHead, mergedTree };
}

async function closeTargetBaseActivityFixture(fixture: Awaited<ReturnType<typeof targetBaseActivityFixture>>): Promise<void> {
  fixture.database.close();
  await rm(fixture.root, { recursive: true, force: true });
}

async function inheritedNoDriftVerificationFixture(prefix: string) {
  const fixture = await targetBaseActivityFixture(prefix);
  const { mergedHead, mergedTree } = await mergeTargetBase(fixture);
  const verification = await fixture.artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: "verification_failed", summary: "Inherited forward-merge verification failed" })) });
  const later = new Date(Date.parse(fixture.now) + 1_000).toISOString();
  const noDriftOperationKey = `workflow-1:pre_release:${fixture.configuration.id}:${fixture.targetBase}:${fixture.targetBase}:${mergedHead}`;
  fixture.database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-original', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, 'developer-original-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, execution_kind) VALUES ('developer-forward', 'task-1', 'company-1', 'workflow-1', 1, 2, 'blocked', 'issue/task-1', ?, ?, 'developer-original', 'developer-forward-session', ?, ?, ?, ?, 'clean', ?, ?, 'forward_merge')").run(fixture.repositoryPath, fixture.targetBase, later, later, mergedHead, mergedTree, fixture.delivery.id, fixture.evidence.id);
    db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-inherited-failure', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'inherited-failure-operation', ?, ?, ?, 'developer-forward', ?, 'verification_failed', 'Inherited forward-merge verification failed', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, mergedHead, mergedTree, fixture.now, fixture.configuration.id, fixture.priorTree, mergedHead, mergedTree, verification.id, fixture.now);
    db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, developer_execution_id, updated_at) VALUES ('merge-inherited-no-drift', 'task-1', 'company-1', ?, ?, ?, NULL, NULL, 'no_drift', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, 'developer-original', ?)").run(fixture.targetBase, fixture.targetBase, mergedHead, later, fixture.configuration.id, noDriftOperationKey, mergedTree, later);
  });
  const activities = createActivities(fixture.database, fixture.config, { githubRelease: {
    async getRemoteRepository() { return "acme/project"; },
    async getBranchHead() { return fixture.targetBase; },
  } as never });
  const input = { taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release" as const, developerExecutionId: "developer-original", expectedBaseSha: fixture.targetBase, expectedHeadSha: mergedHead, expectedHeadTree: mergedTree, forwardMergeId: "merge-inherited-no-drift" };
  return { fixture, activities, input, mergedHead, mergedTree, verification };
}

describe("target-base reconciliation contracts", () => {
  test("accepts every checkpoint and discriminated outcome", () => {
    const input = ReconcileTargetBaseActivityInputSchema.parse({
      taskId: "task-1",
      companyId: "company-1",
      workflowId: "workflow-1",
      projectRevisionId: "revision-1",
      checkpoint: "pre_acceptance",
      developerExecutionId: "developer-1",
      expectedBaseSha: sha("b"),
      expectedHeadSha: sha("c"),
      expectedHeadTree: sha("d"),
      forwardMergeId: "merge-1",
      verificationOnly: true,
    });
    expect(input.checkpoint).toBe("pre_acceptance");
    expect(input).toMatchObject({ forwardMergeId: "merge-1", verificationOnly: true });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "no_drift",
      checkId: "check-1",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("b"),
      headSha: sha("c"),
      headTree: sha("d"),
    })).toMatchObject({ outcome: "no_drift" });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "revalidated",
      checkId: "check-2",
      checkpoint: "pre_final_review",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      headSha: sha("f"),
      headTree: sha("9"),
      developerExecutionId: "developer-2",
      deliveryArtifact: artifact,
      verificationArtifact: { ...artifact, id: "artifact_forward_evidence", kind: "forward-merge-verification" },
    })).toMatchObject({ outcome: "revalidated" });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "conflict",
      checkId: "check-3",
      checkpoint: "pre_acceptance",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      conflictFileCount: 1,
      conflictArtifact: { ...artifact, id: "artifact_conflict", kind: "forward-merge-conflict" },
    })).toMatchObject({ outcome: "conflict" });
    expect(ReconcileTargetBaseActivityResultSchema.parse({
      outcome: "blocked",
      checkId: "check-4",
      checkpoint: "pre_release",
      code: "provider_unavailable",
      owner: "provider",
      retryable: true,
      summary: "GitHub is temporarily unavailable",
    })).toMatchObject({ outcome: "blocked" });
  });

  test("reconciles a valid task configuration without reporting artifact_unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-activity-"));
    const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
    const database = new ForgeDatabase(config.databasePath);
    const repository = await gitRepository(root);
    const now = new Date().toISOString();
    try {
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('developer-1', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, ?, ?, ?, ?, 'clean')").run(root, repository.base, now, now, repository.head, repository.head);
      });
      const configuration = await new ArtifactStore(config.artifactRoot, database).putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath: root, worktreeRoot: root, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: repository.base, targetSha: repository.base, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
      database.authQuery((db) => db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, now));
      const activities = createActivities(database, config, { githubRelease: { getRemoteRepository: async () => "acme/project", getBranchHead: async () => repository.base } as never });
      await expect(activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: "revision-1", checkpoint: "pre_acceptance", developerExecutionId: "developer-1", expectedBaseSha: repository.base, expectedHeadSha: repository.head, expectedHeadTree: repository.head })).resolves.not.toMatchObject({ outcome: "blocked", code: "artifact_unavailable" });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs pinned verification for a fresh merged operation linked to a blocked execution", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-fresh-blocked-");
    try {
      fixture.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-current', 'task-1', 'company-1', 'workflow-1', 1, 1, 'blocked', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id));
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {
        async getRemoteRepository() { return "acme/project"; },
        async getBranchHead() { return fixture.targetBase; },
      } as never });

      const result = await activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-current", expectedBaseSha: fixture.repository.base, expectedHeadSha: fixture.repository.head, expectedHeadTree: fixture.priorTree });

      expect(result).toMatchObject({ outcome: "revalidated", observedBaseSha: fixture.targetBase, priorHead: fixture.repository.head, priorTree: fixture.priorTree, deliveryArtifact: { id: fixture.delivery.id, kind: "developer-delivery" }, developerEvidenceArtifactId: fixture.evidence.id });
      if (result.outcome !== "revalidated") throw new Error("Expected fresh reconciliation to pass verification");
      expect(fixture.database.authQuery((db) => db.prepare("SELECT status, delivery_artifact_id AS deliveryArtifactId, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id = 'developer-current'").get())).toEqual({ status: "blocked", deliveryArtifactId: fixture.delivery.id, failureCode: null, failureSummary: null });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT status, failure_code AS failureCode, failure_summary AS failureSummary, verification_artifact_id AS verificationArtifactId, developer_execution_id AS developerExecutionId FROM forge_forward_merges WHERE id = ?").get(result.checkId))).toEqual({ status: "merged", failureCode: null, failureSummary: null, verificationArtifactId: result.verificationArtifact.id, developerExecutionId: result.developerExecutionId });
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("adopts a clean externally advanced task branch instead of requiring recorded merge ownership", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-external-head-");
    try {
      const { mergedHead, mergedTree } = await mergeTargetBase(fixture);
      await fixture.run("git", ["commit", "--allow-empty", "-m", "external task branch advance"], { cwd: fixture.repositoryPath });
      const observedHead = (await fixture.run("git", ["rev-parse", "HEAD"], { cwd: fixture.repositoryPath })).stdout.trim();
      const observedTree = (await fixture.run("git", ["rev-parse", "HEAD^{tree}"], { cwd: fixture.repositoryPath })).stdout.trim();
      fixture.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-current', 'task-1', 'company-1', 'workflow-1', 1, 1, 'blocked', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, updated_at) VALUES ('merge-old', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, ?, ?, 'developer-current', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, mergedHead, mergedTree, fixture.now, fixture.configuration.id, `workflow-1:pre_release:${fixture.configuration.id}:${fixture.repository.base}:${fixture.targetBase}:${fixture.repository.head}`, fixture.priorTree, mergedHead, mergedTree, fixture.now);
      });
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {
        async getRemoteRepository() { return "acme/project"; },
        async getBranchHead() { return fixture.targetBase; },
      } as never });

      await expect(activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-current", expectedBaseSha: fixture.repository.base, expectedHeadSha: fixture.repository.head, expectedHeadTree: fixture.priorTree })).resolves.toMatchObject({ outcome: "revalidated", headSha: observedHead, headTree: observedTree, developerExecutionId: "developer-current" });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = 'developer-current'").get())).toEqual({ resultCommit: observedHead, resultTree: observedTree });
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("adopts a clean merged task branch when an ordinary reconciliation reuses an unowned merge", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-unowned-merge-");
    try {
      const { mergedHead, mergedTree } = await mergeTargetBase(fixture);
      fixture.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-current', 'task-1', 'company-1', 'workflow-1', 1, 1, 'blocked', 'issue/task-1', ?, ?, 'developer-current-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('developer-wrong', 'task-1', 'company-1', 'workflow-1', 1, 2, 'completed', 'issue/task-1', ?, ?, 'developer-wrong-session', ?, ?, ?, ?, 'clean')").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, sha("f"), sha("e"));
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, updated_at) VALUES ('merge-unowned', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, ?, ?, 'developer-wrong', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, mergedHead, mergedTree, fixture.now, fixture.configuration.id, `workflow-1:pre_release:${fixture.configuration.id}:${fixture.repository.base}:${fixture.targetBase}:${fixture.repository.head}`, fixture.priorTree, mergedHead, mergedTree, fixture.now);
      });
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {
        async getRemoteRepository() { return "acme/project"; },
        async getBranchHead() { return fixture.targetBase; },
      } as never });

      const result = await activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-current", expectedBaseSha: fixture.repository.base, expectedHeadSha: fixture.repository.head, expectedHeadTree: fixture.priorTree });

      expect(result).toMatchObject({ outcome: "revalidated", headSha: mergedHead, headTree: mergedTree, developerExecutionId: "developer-current" });
      if (result.outcome !== "revalidated") throw new Error("Expected clean merged branch adoption");
      expect(fixture.database.authQuery((db) => db.prepare("SELECT status, result_commit AS resultCommit, result_tree AS resultTree, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId FROM forge_developer_executions WHERE id = 'developer-current'").get())).toEqual({ status: "completed", resultCommit: mergedHead, resultTree: mergedTree, deliveryArtifactId: result.deliveryArtifact.id, evidenceArtifactId: result.verificationArtifact.id });
      expect(result.deliveryArtifact.id).not.toBe(fixture.delivery.id);
      expect(result.verificationArtifact.id).not.toBe(fixture.evidence.id);
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("ignores a stale input forward-merge id during ordinary reconciliation", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-stale-input-");
    try {
      const staleVerification = await fixture.artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "stale-verification.json", mimeType: "application/json", bytes: Buffer.from("{}") });
      fixture.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-current', 'task-1', 'company-1', 'workflow-1', 1, 1, 'blocked', 'issue/task-1', ?, ?, 'current-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('developer-stale', 'task-1', 'company-1', 'workflow-1', 1, 2, 'blocked', 'issue/task-1', ?, ?, 'stale-session', ?, ?, ?, ?, 'clean')").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-stale', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'stale-operation', ?, ?, ?, 'developer-stale', ?, 'verification_failed', 'Stale verification failed', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, fixture.repository.head, fixture.priorTree, fixture.now, fixture.configuration.id, fixture.priorTree, fixture.repository.head, fixture.priorTree, staleVerification.id, fixture.now);
      });
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {
        async getRemoteRepository() { return "acme/project"; },
        async getBranchHead() { return fixture.targetBase; },
      } as never });

      const result = await activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-current", expectedBaseSha: fixture.repository.base, expectedHeadSha: fixture.repository.head, expectedHeadTree: fixture.priorTree, forwardMergeId: "merge-stale" });

      expect(result).toMatchObject({ outcome: "revalidated", observedBaseSha: fixture.targetBase });
      if (result.outcome !== "revalidated") throw new Error("Expected ordinary reconciliation to ignore the stale merge id");
      expect(result.checkId).not.toBe("merge-stale");
      expect(fixture.database.authQuery((db) => db.prepare("SELECT developer_execution_id AS developerExecutionId, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_forward_merges WHERE id = 'merge-stale'").get())).toEqual({ developerExecutionId: "developer-stale", failureCode: "verification_failed", failureSummary: "Stale verification failed" });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT supersedes_execution_id AS supersedesExecutionId FROM forge_developer_executions WHERE id = ?").get(result.developerExecutionId))).toEqual({ supersedesExecutionId: "developer-current" });
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("inherits the nearest exact lineage delivery for a blocked merged execution", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-lineage-");
    try {
      const { mergedHead, mergedTree } = await mergeTargetBase(fixture);
      const ancestorEvidence = await fixture.artifacts.putArtifact("company-1", "agent-evidence", { taskId: "task-1", filename: "ancestor-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("ancestor\n") });
      fixture.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-ancestor', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, ancestorEvidence.id);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, evidence_artifact_id, execution_kind) VALUES ('developer-current', 'task-1', 'company-1', 'workflow-1', 1, 2, 'blocked', 'issue/task-1', ?, ?, 'developer-ancestor', 'developer-session', ?, ?, ?, ?, 'clean', ?, 'forward_merge')").run(fixture.repositoryPath, fixture.targetBase, fixture.now, fixture.now, mergedHead, mergedTree, fixture.evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, updated_at) VALUES ('merge-lineage', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'lineage-operation', ?, ?, ?, 'developer-current', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, mergedHead, mergedTree, fixture.now, fixture.configuration.id, fixture.priorTree, mergedHead, mergedTree, fixture.now);
      });
      const oldExecutions = fixture.database.authQuery((db) => db.prepare("SELECT id, status, result_commit AS resultCommit, result_tree AS resultTree, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions ORDER BY id").all());
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {} as never });

      const result = await activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-current", expectedBaseSha: fixture.repository.base, expectedHeadSha: mergedHead, expectedHeadTree: mergedTree, forwardMergeId: "merge-lineage", verificationOnly: true });

      expect(result).toMatchObject({ outcome: "revalidated", checkId: "merge-lineage", headSha: mergedHead, headTree: mergedTree, deliveryArtifact: { id: fixture.delivery.id, kind: "developer-delivery" }, developerEvidenceArtifactId: fixture.evidence.id });
      if (result.outcome !== "revalidated") throw new Error("Expected exact lineage delivery inheritance");
      expect(fixture.database.authQuery((db) => db.prepare("SELECT id, status, result_commit AS resultCommit, result_tree AS resultTree, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id IN ('developer-ancestor', 'developer-current') ORDER BY id").all())).toEqual(oldExecutions);
      expect(fixture.database.authQuery((db) => db.prepare("SELECT status, supersedes_execution_id AS supersedesExecutionId, result_commit AS resultCommit, result_tree AS resultTree, delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId, execution_kind AS executionKind FROM forge_developer_executions WHERE id = ?").get(result.developerExecutionId))).toEqual({ status: "completed", supersedesExecutionId: "developer-current", resultCommit: mergedHead, resultTree: mergedTree, deliveryArtifactId: fixture.delivery.id, evidenceArtifactId: fixture.evidence.id, executionKind: "forward_merge" });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT developer_execution_id AS developerExecutionId, delivery_artifact_id AS deliveryArtifactId, supersedes_delivery_artifact_id AS supersedesDeliveryArtifactId, supersedes_evidence_artifact_id AS supersedesEvidenceArtifactId, verification_artifact_id AS verificationArtifactId FROM forge_forward_merges WHERE id = 'merge-lineage'").get())).toEqual({ developerExecutionId: result.developerExecutionId, deliveryArtifactId: fixture.delivery.id, supersedesDeliveryArtifactId: fixture.delivery.id, supersedesEvidenceArtifactId: fixture.evidence.id, verificationArtifactId: result.verificationArtifact.id });
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("blocks delivery inheritance across a mismatched plan lineage", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-lineage-mismatch-");
    try {
      const { mergedHead, mergedTree } = await mergeTargetBase(fixture);
      fixture.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-other-plan', 'task-1', 'company-1', 'workflow-1', 2, 1, 'completed', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, evidence_artifact_id, execution_kind) VALUES ('developer-current', 'task-1', 'company-1', 'workflow-1', 1, 1, 'blocked', 'issue/task-1', ?, ?, 'developer-other-plan', 'developer-session', ?, ?, ?, ?, 'clean', ?, 'forward_merge')").run(fixture.repositoryPath, fixture.targetBase, fixture.now, fixture.now, mergedHead, mergedTree, fixture.evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, updated_at) VALUES ('merge-mismatched-lineage', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'mismatched-lineage-operation', ?, ?, ?, 'developer-current', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, mergedHead, mergedTree, fixture.now, fixture.configuration.id, fixture.priorTree, mergedHead, mergedTree, fixture.now);
      });
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {} as never });

      await expect(activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-current", expectedBaseSha: fixture.repository.base, expectedHeadSha: mergedHead, expectedHeadTree: mergedTree, forwardMergeId: "merge-mismatched-lineage", verificationOnly: true })).resolves.toMatchObject({ outcome: "blocked", checkId: "merge-mismatched-lineage", code: "artifact_unavailable", owner: "human", retryable: false });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions").get())).toEqual({ count: 2 });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT status, delivery_artifact_id AS deliveryArtifactId FROM forge_developer_executions WHERE id = 'developer-current'").get())).toEqual({ status: "blocked", deliveryArtifactId: null });
      expect(fixture.database.authQuery((db) => db.prepare("SELECT developer_execution_id AS developerExecutionId, delivery_artifact_id AS deliveryArtifactId FROM forge_forward_merges WHERE id = 'merge-mismatched-lineage'").get())).toEqual({ developerExecutionId: "developer-current", deliveryArtifactId: null });
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("adopts and pushes persisted merges across no-drift and revalidation paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-push-"));
    const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
    const database = new ForgeDatabase(config.databasePath);
    const repositoryPath = join(root, "repository");
    await mkdir(repositoryPath, { recursive: true });
    const repository = await gitRepository(repositoryPath);
    await run("git", ["remote", "add", "origin", repositoryPath], { cwd: repositoryPath });
    const priorTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();
    const now = new Date().toISOString();
    try {
      await run("git", ["checkout", "main"], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, "advanced.txt"), "advanced\n");
      await run("git", ["add", "advanced.txt"], { cwd: repositoryPath });
      await run("git", ["commit", "-m", "advance base"], { cwd: repositoryPath });
      const targetBase = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
      await run("git", ["checkout", "issue/task-1"], { cwd: repositoryPath });
      await run("git", ["merge", "--no-ff", "--no-edit", targetBase], { cwd: repositoryPath });
      const mergedHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
      const mergedTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();

      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, repositoryPath, now, now);
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
      });
      const artifacts = new ArtifactStore(config.artifactRoot, database);
      const configuration = await artifacts.putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath, worktreeRoot: repositoryPath, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: repository.base, targetSha: repository.base, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
      const delivery = await artifacts.putArtifact("company-1", "forward-merge-delivery", { taskId: "task-1", filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{}") });
      const evidence = await artifacts.putArtifact("company-1", "agent-evidence", { taskId: "task-1", filename: "evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
      const verification = await artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "verification.json", mimeType: "application/json", bytes: Buffer.from("{}") });
      database.authTransaction((db) => {
        db.prepare("UPDATE forge_tasks SET project_revision_id = ?, project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, configuration.id, now);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-1', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, ?)").run(repositoryPath, repository.base, now, now, repository.head, priorTree, delivery.id, evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, delivery_artifact_id, updated_at) VALUES ('merge-1', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'operation-1', ?, ?, ?, 'developer-1', ?, ?, ?)").run(repository.base, targetBase, repository.head, mergedHead, mergedTree, now, configuration.id, priorTree, mergedHead, mergedTree, verification.id, delivery.id, now);
      });

      let pushedHead: string | null = null;
      let pushCount = 0;
      let observedHead = mergedHead;
      const activities = createActivities(database, config, { githubRelease: {
        async checkAuthentication() {},
        async getRemoteRepository() { return "acme/project"; },
        async inspectLocalRevision() { return { branch: "issue/task-1", headSha: observedHead, treeSha: mergedTree, clean: true }; },
        async getBranchHead({ branch }: { branch: string }) { return branch === "issue/task-1" ? pushedHead : targetBase; },
        async pushNormal() { pushCount += 1; pushedHead = mergedHead; },
      } as never });
      const revalidatedInput = { taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: configuration.id, checkpoint: "pre_release" as const, developerExecutionId: "developer-1", expectedBaseSha: repository.base, expectedHeadSha: mergedHead, expectedHeadTree: mergedTree, forwardMergeId: "merge-1", verificationOnly: true };
      const noDriftInput = { ...revalidatedInput, expectedBaseSha: targetBase, forwardMergeId: undefined, verificationOnly: undefined };

      await expect(activities.reconcileTargetBase(noDriftInput)).resolves.toMatchObject({ outcome: "revalidated", headSha: mergedHead, headTree: mergedTree, deliveryArtifact: { id: delivery.id, kind: "forward-merge-delivery" } });
      expect(database.authQuery((db) => db.prepare("SELECT result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = 'developer-1'").get())).toEqual({ resultCommit: repository.head, resultTree: priorTree });
      await expect(activities.pushDeliveryBranch({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", branchName: "issue/task-1", commitSha: mergedHead })).resolves.toMatchObject({ commitSha: mergedHead });
      expect(pushCount).toBe(1);

      const changesBeforeRetry = database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()));
      await expect(activities.reconcileTargetBase(noDriftInput)).resolves.toMatchObject({ outcome: "revalidated", headSha: mergedHead, headTree: mergedTree });
      expect(database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()))).toBe(changesBeforeRetry);

      database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET result_commit = ?, result_tree = ? WHERE id = 'developer-1'").run(sha("f"), sha("e")));
      await expect(activities.reconcileTargetBase(noDriftInput)).resolves.toMatchObject({ outcome: "revalidated", headSha: mergedHead, headTree: mergedTree });

      observedHead = sha("f");
      await expect(activities.reconcileTargetBase(noDriftInput)).resolves.toMatchObject({ outcome: "blocked", code: "merge_state_ownership_mismatch", retryable: true, summary: expect.stringContaining("Git") });
      observedHead = mergedHead;
      database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET result_commit = ?, result_tree = ? WHERE id = 'developer-1'").run(repository.head, priorTree));
      await expect(activities.reconcileTargetBase(revalidatedInput)).resolves.toMatchObject({ outcome: "revalidated", developerExecutionId: "developer-1", headSha: mergedHead, headTree: mergedTree, deliveryArtifact: { id: delivery.id, kind: "forward-merge-delivery" } });
      expect(database.authQuery((db) => db.prepare("SELECT result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = 'developer-1'").get())).toEqual({ resultCommit: mergedHead, resultTree: mergedTree });
      await expect(activities.pushDeliveryBranch({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", branchName: "issue/task-1", commitSha: repository.head })).rejects.toMatchObject({ type: "stale-reviewed-revision", message: "The reviewed revision does not match a completed build" });
      expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_executions WHERE task_id = 'task-1'").get())).toEqual({ count: 1 });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resurfaces a persisted verification blocker without rewriting its blocked execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-verification-blocker-"));
    const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
    const database = new ForgeDatabase(config.databasePath);
    const repositoryPath = join(root, "repository");
    await mkdir(repositoryPath, { recursive: true });
    const repository = await gitRepository(repositoryPath);
    const priorTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();
    const now = new Date().toISOString();
    const failureCode = "verification_timed_out";
    const failureSummary = "Pinned forward-merge verification timed out";
    try {
      await run("git", ["checkout", "main"], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, "advanced.txt"), "advanced\n");
      await run("git", ["add", "advanced.txt"], { cwd: repositoryPath });
      await run("git", ["commit", "-m", "advance base"], { cwd: repositoryPath });
      const targetBase = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
      await run("git", ["checkout", "issue/task-1"], { cwd: repositoryPath });
      await run("git", ["merge", "--no-ff", "--no-edit", targetBase], { cwd: repositoryPath });
      const mergedHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
      const mergedTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();

      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, repositoryPath, now, now);
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
      });
      const artifacts = new ArtifactStore(config.artifactRoot, database);
      const configuration = await artifacts.putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath, worktreeRoot: repositoryPath, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: repository.base, targetSha: repository.base, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
      const evidence = await artifacts.putArtifact("company-1", "agent-evidence", { taskId: "task-1", filename: "evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
      const verification = await artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: failureCode, summary: failureSummary, commands: [] })) });
      database.authTransaction((db) => {
        db.prepare("UPDATE forge_tasks SET project_revision_id = ?, project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, configuration.id, now);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, evidence_artifact_id, execution_kind) VALUES ('developer-1', 'task-1', 'company-1', 'workflow-1', 1, 1, 'blocked', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, 'forward_merge')").run(repositoryPath, targetBase, now, now, mergedHead, mergedTree, evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-1', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'operation-1', ?, ?, ?, 'developer-1', ?, ?, ?, ?)").run(repository.base, targetBase, repository.head, mergedHead, mergedTree, now, configuration.id, priorTree, mergedHead, mergedTree, verification.id, failureCode, failureSummary, now);
      });

      const activities = createActivities(database, config, { githubRelease: {} as never });
      const input = { taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: configuration.id, checkpoint: "pre_release" as const, developerExecutionId: "developer-1", expectedBaseSha: repository.base, expectedHeadSha: mergedHead, expectedHeadTree: mergedTree, forwardMergeId: "merge-1", verificationOnly: true };
      const executionBefore = database.authQuery((db) => db.prepare("SELECT status, plan_revision AS planRevision, result_commit AS resultCommit, result_tree AS resultTree, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id = 'developer-1'").get());
      const changesBefore = database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()));
      expect(executionBefore).toEqual({ status: "blocked", planRevision: 1, resultCommit: mergedHead, resultTree: mergedTree, failureCode: null, failureSummary: null });

      await expect(activities.reconcileTargetBase(input)).resolves.toEqual({
        outcome: "blocked",
        checkId: "merge-1",
        checkpoint: "pre_release",
        code: failureCode,
        owner: "lead",
        retryable: true,
        summary: failureSummary,
        evidenceArtifact: { id: verification.id, kind: "forward-merge-verification" },
        observedBaseSha: targetBase,
        priorHead: repository.head,
        priorTree,
        resultHead: mergedHead,
        resultTree: mergedTree,
      });
      expect(database.authQuery((db) => db.prepare("SELECT status, plan_revision AS planRevision, result_commit AS resultCommit, result_tree AS resultTree, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id = 'developer-1'").get())).toEqual(executionBefore);
      expect(database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()))).toBe(changesBefore);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { executionState: "completed pre-merge", executionStatus: "completed" },
    { executionState: "blocked pre-merge with no duplicated failure fields", executionStatus: "blocked" },
  ] as const)("resurfaces a failed persisted merge from ordinary no-drift for a $executionState execution without adopting it", async ({ executionStatus }) => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-no-drift-verification-blocker-"));
    const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
    const database = new ForgeDatabase(config.databasePath);
    const repositoryPath = join(root, "repository");
    await mkdir(repositoryPath, { recursive: true });
    const repository = await gitRepository(repositoryPath);
    await run("git", ["remote", "add", "origin", repositoryPath], { cwd: repositoryPath });
    const priorTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();
    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 1_000).toISOString();
    const failureCode = "verification_failed";
    const failureSummary = "Pinned forward-merge verification failed";
    try {
      await run("git", ["checkout", "main"], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, "advanced.txt"), "advanced\n");
      await run("git", ["add", "advanced.txt"], { cwd: repositoryPath });
      await run("git", ["commit", "-m", "advance base"], { cwd: repositoryPath });
      const targetBase = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
      await run("git", ["checkout", "issue/task-1"], { cwd: repositoryPath });
      await run("git", ["merge", "--no-ff", "--no-edit", targetBase], { cwd: repositoryPath });
      const mergedHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
      const mergedTree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();

      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
        db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, repositoryPath, now, now);
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
      });
      const artifacts = new ArtifactStore(config.artifactRoot, database);
      const configuration = await artifacts.putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath, worktreeRoot: repositoryPath, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: repository.base, targetSha: repository.base, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
      const evidence = await artifacts.putArtifact("company-1", "agent-evidence", { taskId: "task-1", filename: "evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
      const verification = await artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: failureCode, summary: failureSummary, commands: [] })) });
      const noDriftOperationKey = `workflow-1:pre_release:${configuration.id}:${targetBase}:${targetBase}:${mergedHead}`;
      database.authTransaction((db) => {
        db.prepare("UPDATE forge_tasks SET project_revision_id = ?, project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, configuration.id, now);
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, evidence_artifact_id) VALUES ('developer-1', 'task-1', 'company-1', 'workflow-1', 1, 1, ?, 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?)").run(executionStatus, repositoryPath, repository.base, now, now, repository.head, priorTree, evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-failed', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', 'failed-operation-1', ?, ?, ?, 'developer-1', ?, ?, ?, ?)").run(repository.base, targetBase, repository.head, mergedHead, mergedTree, now, configuration.id, priorTree, mergedHead, mergedTree, verification.id, failureCode, failureSummary, now);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, developer_execution_id, updated_at) VALUES ('merge-no-drift', 'task-1', 'company-1', ?, ?, ?, NULL, NULL, 'no_drift', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, 'developer-1', ?)").run(targetBase, targetBase, mergedHead, later, configuration.id, noDriftOperationKey, mergedTree, later);
      });

      const activities = createActivities(database, config, { githubRelease: {
        async getRemoteRepository() { return "acme/project"; },
        async getBranchHead() { return targetBase; },
      } as never });
      const input = { taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: configuration.id, checkpoint: "pre_release" as const, developerExecutionId: "developer-1", expectedBaseSha: targetBase, expectedHeadSha: mergedHead, expectedHeadTree: mergedTree, forwardMergeId: "merge-no-drift" };
      const executionBefore = database.authQuery((db) => db.prepare("SELECT status, result_commit AS resultCommit, result_tree AS resultTree, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id = 'developer-1'").get());
      const changesBefore = database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()));
      expect(executionBefore).toEqual({ status: executionStatus, resultCommit: repository.head, resultTree: priorTree, failureCode: null, failureSummary: null });

      await expect(activities.reconcileTargetBase(input)).resolves.toEqual({
        outcome: "blocked",
        checkId: "merge-failed",
        checkpoint: "pre_release",
        code: failureCode,
        owner: "lead",
        retryable: true,
        summary: failureSummary,
        evidenceArtifact: { id: verification.id, kind: "forward-merge-verification" },
        observedBaseSha: targetBase,
        priorHead: repository.head,
        priorTree,
        resultHead: mergedHead,
        resultTree: mergedTree,
      });
      expect(database.authQuery((db) => db.prepare("SELECT status, result_commit AS resultCommit, result_tree AS resultTree, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id = 'developer-1'").get())).toEqual(executionBefore);
      expect(database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()))).toBe(changesBefore);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resurfaces an exact no-drift blocker owned by a later forward-merge execution", async () => {
    const value = await inheritedNoDriftVerificationFixture("forge-target-base-inherited-no-drift-");
    try {
      const rowsBefore = value.fixture.database.authQuery((db) => db.prepare("SELECT id, status, supersedes_execution_id AS supersedesExecutionId, result_commit AS resultCommit, result_tree AS resultTree, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions ORDER BY id").all());
      const changesBefore = value.fixture.database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()));

      await expect(value.activities.reconcileTargetBase(value.input)).resolves.toEqual({
        outcome: "blocked",
        checkId: "merge-inherited-failure",
        checkpoint: "pre_release",
        code: "verification_failed",
        owner: "lead",
        retryable: true,
        summary: "Inherited forward-merge verification failed",
        evidenceArtifact: { id: value.verification.id, kind: "forward-merge-verification" },
        observedBaseSha: value.fixture.targetBase,
        priorHead: value.fixture.repository.head,
        priorTree: value.fixture.priorTree,
        resultHead: value.mergedHead,
        resultTree: value.mergedTree,
      });
      expect(value.fixture.database.authQuery((db) => db.prepare("SELECT id, status, supersedes_execution_id AS supersedesExecutionId, result_commit AS resultCommit, result_tree AS resultTree, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions ORDER BY id").all())).toEqual(rowsBefore);
      expect(value.fixture.database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()))).toBe(changesBefore);
    } finally {
      await closeTargetBaseActivityFixture(value.fixture);
    }
  });

  test.each([
    ["an untyped verification artifact", (value: Awaited<ReturnType<typeof inheritedNoDriftVerificationFixture>>) => value.fixture.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET kind = 'agent-evidence' WHERE id = ?").run(value.verification.id)), "artifact_unavailable"],
    ["ambiguous exact candidates", (value: Awaited<ReturnType<typeof inheritedNoDriftVerificationFixture>>) => value.fixture.database.authQuery((db) => db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) SELECT 'merge-inherited-failure-copy', task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, NULL, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at FROM forge_forward_merges WHERE id = 'merge-inherited-failure'").run()), "merge_state_ownership_mismatch"],
    ["a wrong project revision", (value: Awaited<ReturnType<typeof inheritedNoDriftVerificationFixture>>) => value.fixture.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET project_revision_id = 'wrong-revision' WHERE id = 'merge-inherited-failure'").run()), "merge_state_ownership_mismatch"],
    ["a wrong checkpoint", (value: Awaited<ReturnType<typeof inheritedNoDriftVerificationFixture>>) => value.fixture.database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET checkpoint = 'pre_acceptance' WHERE id = 'merge-inherited-failure'").run()), "merge_state_ownership_mismatch"],
    ["unprovable execution lineage", (value: Awaited<ReturnType<typeof inheritedNoDriftVerificationFixture>>) => value.fixture.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET target_base_sha = ? WHERE id = 'developer-forward'").run(sha("9"))), "merge_state_ownership_mismatch"],
  ] as const)("rejects inherited no-drift recovery with %s", async (_label, mutate, code) => {
    const value = await inheritedNoDriftVerificationFixture("forge-target-base-rejected-inheritance-");
    try {
      mutate(value);
      await expect(value.activities.reconcileTargetBase(value.input)).resolves.toMatchObject({ outcome: "blocked", code, owner: "human", retryable: code === "merge_state_ownership_mismatch" });
    } finally {
      await closeTargetBaseActivityFixture(value.fixture);
    }
  });

  test("resurfaces the newest typed blocker through a two-hop immutable Developer lineage without rewriting rows", async () => {
    const fixture = await targetBaseActivityFixture("forge-target-base-transitive-no-drift-");
    try {
      const firstMerge = await mergeTargetBase(fixture);
      await fixture.run("git", ["checkout", "main"], { cwd: fixture.repositoryPath });
      await writeFile(join(fixture.repositoryPath, "advanced-two.txt"), "advanced two\n");
      await fixture.run("git", ["add", "advanced-two.txt"], { cwd: fixture.repositoryPath });
      await fixture.run("git", ["commit", "-m", "advance base again"], { cwd: fixture.repositoryPath });
      const secondBase = (await fixture.run("git", ["rev-parse", "HEAD"], { cwd: fixture.repositoryPath })).stdout.trim();
      await fixture.run("git", ["checkout", "issue/task-1"], { cwd: fixture.repositoryPath });
      await fixture.run("git", ["merge", "--no-ff", "--no-edit", secondBase], { cwd: fixture.repositoryPath });
      const secondMergeHead = (await fixture.run("git", ["rev-parse", "HEAD"], { cwd: fixture.repositoryPath })).stdout.trim();
      const secondMergeTree = (await fixture.run("git", ["rev-parse", "HEAD^{tree}"], { cwd: fixture.repositoryPath })).stdout.trim();
      const firstVerification = await fixture.artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "first-verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: "verification_failed", summary: "First merge verification failed" })) });
      const secondVerification = await fixture.artifacts.putArtifact("company-1", "forward-merge-verification", { taskId: "task-1", filename: "second-verification.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ outcome: "failed", code: "verification_timed_out", summary: "Newest merge verification timed out" })) });
      const later = new Date(Date.parse(fixture.now) + 1_000).toISOString();
      const latest = new Date(Date.parse(fixture.now) + 2_000).toISOString();
      const noDriftOperationKey = `workflow-1:pre_release:${fixture.configuration.id}:${secondBase}:${secondBase}:${secondMergeHead}`;
      fixture.database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-root', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, 'developer-session', ?, ?, ?, ?, 'clean', ?, ?)").run(fixture.repositoryPath, fixture.repository.base, fixture.now, fixture.now, fixture.repository.head, fixture.priorTree, fixture.delivery.id, fixture.evidence.id);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-transitive-a', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, ?, 'developer-root', ?, 'verification_failed', 'First merge verification failed', ?)").run(fixture.repository.base, fixture.targetBase, fixture.repository.head, firstMerge.mergedHead, firstMerge.mergedTree, fixture.now, fixture.configuration.id, fixture.priorTree, firstMerge.mergedHead, firstMerge.mergedTree, firstVerification.id, fixture.now);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, result_head, result_tree, developer_execution_id, verification_artifact_id, failure_code, failure_summary, updated_at) VALUES ('merge-transitive-b', 'task-1', 'company-1', ?, ?, ?, ?, ?, 'merged', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, ?, 'developer-root', ?, 'verification_timed_out', 'Newest merge verification timed out', ?)").run(fixture.targetBase, secondBase, firstMerge.mergedHead, secondMergeHead, secondMergeTree, later, fixture.configuration.id, firstMerge.mergedTree, secondMergeHead, secondMergeTree, secondVerification.id, later);
        db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, developer_execution_id, updated_at) VALUES ('merge-transitive-no-drift', 'task-1', 'company-1', ?, ?, ?, NULL, NULL, 'no_drift', '[]', ?, 'workflow-1', ?, 'pre_release', ?, ?, 'developer-root', ?)").run(secondBase, secondBase, secondMergeHead, latest, fixture.configuration.id, noDriftOperationKey, secondMergeTree, latest);
      });
      const activities = createActivities(fixture.database, fixture.config, { githubRelease: {
        async getRemoteRepository() { return "acme/project"; },
        async getBranchHead() { return secondBase; },
      } as never });
      const before = {
        executions: fixture.database.authQuery((db) => db.prepare("SELECT * FROM forge_developer_executions WHERE task_id = 'task-1' ORDER BY id").all()),
        merges: fixture.database.authQuery((db) => db.prepare("SELECT * FROM forge_forward_merges WHERE task_id = 'task-1' ORDER BY id").all()),
      };
      const changesBefore = fixture.database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()));

      await expect(activities.reconcileTargetBase({ taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: fixture.configuration.id, checkpoint: "pre_release", developerExecutionId: "developer-root", expectedBaseSha: secondBase, expectedHeadSha: secondMergeHead, expectedHeadTree: secondMergeTree, forwardMergeId: "merge-transitive-no-drift" })).resolves.toEqual({
        outcome: "blocked",
        checkId: "merge-transitive-b",
        checkpoint: "pre_release",
        code: "verification_timed_out",
        owner: "lead",
        retryable: true,
        summary: "Newest merge verification timed out",
        evidenceArtifact: { id: secondVerification.id, kind: "forward-merge-verification" },
        observedBaseSha: secondBase,
        priorHead: firstMerge.mergedHead,
        priorTree: firstMerge.mergedTree,
        resultHead: secondMergeHead,
        resultTree: secondMergeTree,
      });
      expect({
        executions: fixture.database.authQuery((db) => db.prepare("SELECT * FROM forge_developer_executions WHERE task_id = 'task-1' ORDER BY id").all()),
        merges: fixture.database.authQuery((db) => db.prepare("SELECT * FROM forge_forward_merges WHERE task_id = 'task-1' ORDER BY id").all()),
      }).toEqual(before);
      expect(fixture.database.authQuery((db) => Number(db.prepare("SELECT total_changes()").pluck().get()))).toBe(changesBefore);
    } finally {
      await closeTargetBaseActivityFixture(fixture);
    }
  });

  test("allows a recorded forward merge to repair a stale workflow execution id", () => {
    const input = ReconcileTargetBaseActivityInputSchema.parse({
      taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: "revision-1", checkpoint: "pre_release",
      developerExecutionId: "developer-stale", expectedBaseSha: sha("b"), expectedHeadSha: sha("c"), expectedHeadTree: sha("d"), forwardMergeId: "merge-1",
    });
    expect(input.forwardMergeId).toBe("merge-1");
  });

  test("resumes an exactly reviewed no-drift delivery to publication", () => {
    const resumed = applyTargetBaseNoDrift(IssueWorkflowStateSchema.parse({
      workflowId: "workflow-1", companyId: "company-1", projectId: "project-1", issueId: "task-1", projectRevisionId: "revision-1",
      ...at("delivery_reviewed"), revision: 4, owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Provider unavailable", lastEventId: "workflow-1:4", continuationCount: 0, lastSummaryHash: null,
      targetBaseSha: sha("b"), resultCommit: sha("c"), resultTree: sha("d"), deliveryReviewId: "review-exact",
      blocker: { category: "provider_connectivity_exhausted", summary: "Provider unavailable", unblockOwner: "human", actions: [{ command: "retry_target_base_reconciliation", label: "Retry reconciliation", requiresNote: false, destructive: false }], evidence: { artifactId: "blocker", kind: "attention-evidence" }, createdAt: "2026-09-01T00:00:00.000Z", retry: null }, targetBaseBlockerCode: "provider_unavailable", targetBaseBlockerOwner: "provider", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Provider unavailable",
    }), {
      outcome: "no_drift", checkId: "check-reviewed", checkpoint: "pre_release", expectedBaseSha: sha("b"), observedBaseSha: sha("b"), headSha: sha("c"), headTree: sha("d"),
    });

    expect(resumed).toMatchObject({
      step: "delivery_reviewed", owner: "lead", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Publish the reviewed commit as a draft pull request", deliveryReviewId: "review-exact", targetBaseBlockerCode: null,
    });
    expect(resumed.allowedCommands).not.toContain("review_delivery");
  });

  test("requires Lead review when a no-drift delivery has no review identity", () => {
    const resumed = applyTargetBaseNoDrift(IssueWorkflowStateSchema.parse({
      workflowId: "workflow-1", companyId: "company-1", projectId: "project-1", issueId: "task-1", projectRevisionId: "revision-1",
      ...at("delivery_reviewed"), revision: 4, owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Provider unavailable", lastEventId: "workflow-1:4", continuationCount: 0, lastSummaryHash: null,
      targetBaseSha: sha("b"), resultCommit: sha("c"), resultTree: sha("d"), deliveryReviewId: null,
      blocker: { category: "provider_connectivity_exhausted", summary: "Provider unavailable", unblockOwner: "human", actions: [{ command: "retry_target_base_reconciliation", label: "Retry reconciliation", requiresNote: false, destructive: false }], evidence: { artifactId: "blocker", kind: "attention-evidence" }, createdAt: "2026-09-01T00:00:00.000Z", retry: null }, targetBaseBlockerCode: "provider_unavailable", targetBaseBlockerOwner: "provider", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Provider unavailable",
    }), {
      outcome: "no_drift", checkId: "check-unreviewed", checkpoint: "pre_release", expectedBaseSha: sha("b"), observedBaseSha: sha("b"), headSha: sha("c"), headTree: sha("d"),
    });

    expect(resumed).toMatchObject({
      step: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the delivery", deliveryReviewId: null, targetBaseBlockerCode: null,
    });
    expect(resumed.allowedCommands).not.toContain("publish_draft");
    expect(resumed.phase).not.toBe("delivery_reviewed");
  });

  test("invalidates current authority while preserving only published identity", () => {
    const state = IssueWorkflowStateSchema.parse({
      workflowId: "workflow-1",
      companyId: "company-1",
      projectId: "project-1",
      issueId: "task-1",
      projectRevisionId: "revision-1",
      phase: "releasing",
      revision: 4,
      owner: "lead",
      allowedCommands: ["publish_draft"],
      pendingAction: "publish",
      lastEventId: "workflow-1:4",
      continuationCount: 0,
      lastSummaryHash: null,
      targetBaseSha: sha("b"),
      developerExecutionId: "developer-old",
      resultCommit: sha("c"),
      resultTree: sha("d"),
      deliveryArtifactId: "artifact-old",
      developerEvidenceArtifactId: "artifact-old-evidence",
      deliveryReviewId: "review-old",
      ciRunId: "ci-old",
      finalReviewId: "final-old",
      acceptanceId: "accept-old",
      releaseId: "release-1",
      pullRequestNumber: 12,
      expectedHeadSha: sha("f"),
      expectedHeadTree: sha("9"),
      pullRequestUrl: "https://github.com/acme/repo/pull/12",
    });
    const next = applyTargetBaseRevalidation(IssueWorkflowStateSchema.parse({ ...state, deliveryReviewSupersedesId: "review-blocking", repairCycle: 1 }), {
      outcome: "revalidated",
      checkId: "check-5",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      headSha: sha("f"),
      headTree: sha("9"),
      developerExecutionId: "developer-new",
      deliveryArtifact: artifact,
      verificationArtifact: { ...artifact, id: "artifact-verification", kind: "forward-merge-verification" },
      developerEvidenceArtifactId: "artifact-developer-evidence",
    });
    expect(next).toMatchObject({
      step: "delivery_ready",
      owner: "lead",
      allowedCommands: ["review_delivery", "cancel_issue"],
      targetBaseSha: sha("e"),
      developerExecutionId: "developer-new",
      resultCommit: sha("f"),
      resultTree: sha("9"),
      deliveryArtifactId: artifact.id,
      developerEvidenceArtifactId: "artifact-developer-evidence",
      deliveryReviewId: null,
      deliveryReviewSupersedesId: null,
      repairCycle: 0,
      ciRunId: null,
      finalReviewId: null,
      acceptanceId: null,
      releaseId: "release-1",
      pullRequestNumber: 12,
    });
    const unpublished = applyTargetBaseRevalidation(IssueWorkflowStateSchema.parse({ ...state, releaseId: null, pullRequestNumber: null, pullRequestUrl: null }), {
      outcome: "revalidated",
      checkId: "check-5b",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("e"),
      priorHead: sha("c"),
      priorTree: sha("d"),
      headSha: sha("f"),
      headTree: sha("9"),
      developerExecutionId: "developer-new",
      deliveryArtifact: artifact,
      verificationArtifact: { ...artifact, id: "artifact-verification-b", kind: "forward-merge-verification" },
    });
    expect(unpublished).toMatchObject({ releaseId: null, pullRequestNumber: null, pullRequestUrl: null, developerEvidenceArtifactId: "artifact-verification-b" });
    const resumed = applyTargetBaseNoDrift(IssueWorkflowStateSchema.parse({ ...state, ...at("delivery_reviewed"), owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Provider unavailable", blocker: { category: "provider_connectivity_exhausted", summary: "Provider unavailable", unblockOwner: "human", actions: [{ command: "retry_target_base_reconciliation", label: "Retry reconciliation", requiresNote: false, destructive: false }], evidence: { artifactId: "blocker", kind: "attention-evidence" }, createdAt: "2026-09-01T00:00:00.000Z", retry: null }, targetBaseBlockerCode: "provider_unavailable", targetBaseBlockerOwner: "provider", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Provider unavailable" }), {
      outcome: "no_drift",
      checkId: "check-6",
      checkpoint: "pre_release",
      expectedBaseSha: sha("b"),
      observedBaseSha: sha("b"),
      headSha: sha("c"),
      headTree: sha("d"),
    });
    expect(resumed).toMatchObject({ step: "delivery_reviewed", owner: "lead", allowedCommands: ["publish_draft", "cancel_issue"], targetBaseBlockerCode: null });
  });

  test("drops an accepted human blocker when reconciliation replaces its commands", () => {
    const accepted = IssueWorkflowStateSchema.parse({
      workflowId: "workflow-1", companyId: "company-1", projectId: "project-1", issueId: "task-1", projectRevisionId: "revision-1",
      phase: "accepted", revision: 4, owner: "human", allowedCommands: ["accept_delivery", "request_delivery_changes", "cancel_issue"], pendingAction: "Your acceptance is necessary", lastEventId: "workflow-1:4", continuationCount: 0, lastSummaryHash: null,
      blocker: { category: "member_authorization", summary: "Your acceptance is necessary", unblockOwner: "human", actions: [{ command: "accept_delivery", label: "Accept", requiresNote: false, destructive: false }], retry: null, evidence: { artifactId: "evidence-1", kind: "lead-plan" }, createdAt: "2026-08-22T00:00:00.000Z" },
    });
    const blocked = IssueWorkflowStateSchema.parse({ ...accepted, revision: 5, ...at("accepted"), owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Configuration unavailable", lastEventId: "workflow-1:5" });
    expect(blocked).toMatchObject({ step: "accepted", blocker: null });
  });

  test("installs reconciliation lineage columns without replacing legacy tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-migration-"));
    const database = new ForgeDatabase(join(root, "forge.sqlite"));
    try {
      const columns = database.authQuery((db) => db.prepare("PRAGMA table_info(forge_forward_merges)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["workflow_id", "project_revision_id", "checkpoint", "operation_key", "prior_tree", "result_head", "result_tree", "developer_execution_id", "conflict_artifact_id", "verification_artifact_id", "delivery_artifact_id", "supersedes_delivery_artifact_id", "invalidated_delivery_review_id", "release_id", "failure_code", "updated_at"]));
      expect(database.authQuery((db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'forge_forward_merges_operation_key_unique'").get())).toEqual(expect.objectContaining({ sql: expect.stringContaining("operation_key") }));
      expect(database.authQuery((db) => db.prepare("PRAGMA table_info(forge_developer_executions)").all() as Array<{ name: string; dflt_value: string }>).find((column) => column.name === "execution_kind")).toMatchObject({ dflt_value: "'agent'" });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the provider-observed base and performs no Git mutation when there is no drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-no-drift-"));
    try {
      const repository = await gitRepository(root);
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => execFile("git", ["remote", "add", "origin", root], { cwd: root }, (error) => error ? reject(error) : resolve()));
      const calls: string[] = [];
      const result = await new ForwardMergeService(undefined, {
        async getBranchHead() { calls.push("observe"); return repository.base; },
        async getRemoteRepository() { calls.push("remote"); return "acme/repo"; },
      }).reconcile({ worktreePath: root, repositoryPath: root, repository: "acme/repo", baseBranch: "main", branchName: "issue/task-1", expectedBaseSha: repository.base, expectedHeadSha: repository.head, expectedHeadTree: (await (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" })).trim() });
      expect(result.status).toBe("no_drift");
      expect(calls).toEqual(["remote", "observe", "remote", "observe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a base that advances during fetch without mutating either worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-target-base-race-"));
    const remote = join(root, "remote.git");
    const repository = join(root, "repository");
    const worktreeA = join(root, "worktrees", "a");
    const worktreeB = join(root, "worktrees", "b");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const git = (args: string[], cwd: string) => run("git", args, { cwd });
    try {
      await mkdir(repository, { recursive: true });
      await git(["init", "--bare", remote], root);
      await git(["init", "-b", "main"], repository);
      await git(["config", "user.name", "Forge Test"], repository);
      await git(["config", "user.email", "forge@example.test"], repository);
      await writeFile(join(repository, "base.txt"), "base\n");
      await git(["add", "."], repository); await git(["commit", "-m", "base"], repository);
      const oldBase = (await git(["rev-parse", "HEAD"], repository)).stdout.trim();
      await git(["remote", "add", "origin", remote], repository); await git(["push", "origin", "main"], repository);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await git(["worktree", "add", "-b", "issue/task-a", worktreeA, "main"], repository);
      await git(["worktree", "add", "-b", "issue/task-b", worktreeB, "main"], repository);
      await writeFile(join(worktreeA, "issue.txt"), "issue\n"); await git(["add", "issue.txt"], worktreeA); await git(["commit", "-m", "issue"], worktreeA);
      const issueHead = (await git(["rev-parse", "HEAD"], worktreeA)).stdout.trim();
      const worktreeBHead = (await git(["rev-parse", "HEAD"], worktreeB)).stdout.trim();
      await writeFile(join(repository, "base.txt"), "base one\n"); await git(["add", "base.txt"], repository); await git(["commit", "-m", "base-one"], repository);
      const firstBase = (await git(["rev-parse", "HEAD"], repository)).stdout.trim(); await git(["push", "origin", "main"], repository);
      await writeFile(join(repository, "base.txt"), "base two\n"); await git(["add", "base.txt"], repository); await git(["commit", "-m", "base-two"], repository);
      const secondBase = (await git(["rev-parse", "HEAD"], repository)).stdout.trim(); await git(["push", "origin", "main"], repository);
      const tree = (await git(["rev-parse", "HEAD^{tree}"], worktreeA)).stdout.trim();
      let observations = 0;
      await expect(new ForwardMergeService(undefined, {
        async getRemoteRepository() { return "acme/forge"; },
        async getBranchHead() { observations += 1; return observations === 1 ? firstBase : secondBase; },
      }).reconcile({ worktreePath: worktreeA, repositoryPath: repository, repository: "acme/forge", baseBranch: "main", branchName: "issue/task-a", expectedBaseSha: oldBase, expectedHeadSha: issueHead, expectedHeadTree: tree })).rejects.toMatchObject({ code: "base-advanced-again" });
      expect((await git(["rev-parse", "HEAD"], worktreeA)).stdout.trim()).toBe(issueHead);
      expect((await git(["status", "--porcelain"], worktreeA)).stdout).toBe("");
      expect((await git(["rev-parse", "HEAD"], worktreeB)).stdout.trim()).toBe(worktreeBHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the complete accepted project revision for reconciliation", () => {
    const valid = {
      repositoryPath: "/repositories/forge",
      worktreeRoot: "/worktrees",
      repository: "acme/forge",
      baseBranch: "main",
      targetBranch: "main",
      baseSha: sha("b"),
      targetSha: sha("c"),
      setupCommand: "pnpm install --frozen-lockfile",
      verificationCommand: "pnpm test",
      requiredChecks: ["Tests / unit"],
    };
    expect(AcceptedProjectRevisionSchema.parse(valid)).toEqual(valid);
    expect(() => AcceptedProjectRevisionSchema.parse({ ...valid, setupCommand: undefined })).toThrow();
  });
});
