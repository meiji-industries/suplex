import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createTargetBaseActivities } from "../src/engine/activities/target-base.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import type { VerificationResult } from "../src/verification.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture(baseOutcome: VerificationResult["outcome"]) {
  const root = await mkdtemp(join(tmpdir(), "forge-target-base-base-verification-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  await mkdir(config.runtimeRoot, { recursive: true });
  await writeFile(join(root, ".gitignore"), "artifacts/\nruntime/\nforge.sqlite*\n");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Forge Test"]);
  await git(root, ["config", "user.email", "forge@example.test"]);
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  await git(root, ["remote", "add", "origin", root]);
  const acceptedBase = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "-b", "issue/task-1"]);
  await writeFile(join(root, "task.txt"), "task\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "task"]);
  const taskHead = await git(root, ["rev-parse", "HEAD"]);
  const taskTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
  await git(root, ["checkout", "main"]);
  await writeFile(join(root, "base-advance.txt"), "advance\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "advance"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "issue/task-1"]);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'company-1/brief-1', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'task-key', ?, ?)").run(now, now);
  });
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  const configuration = await artifacts.putArtifact("company-1", "task-project-configuration", { taskId: "task-1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project-1", projectName: "Project", repositoryPath: root, worktreeRoot: root, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha: acceptedBase, targetSha: acceptedBase, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "builder" }, capturedAt: now })) });
  const delivery = await artifacts.putArtifact("company-1", "developer-delivery", { taskId: "task-1", filename: "delivery.json", mimeType: "application/json", bytes: Buffer.from("{}") });
  const evidence = await artifacts.putArtifact("company-1", "agent-evidence", { taskId: "task-1", filename: "evidence.json", mimeType: "application/json", bytes: Buffer.from("{}") });
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_tasks SET project_revision_id = ?, project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = 'task-1'").run(configuration.id, configuration.id, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer-1', 'task-1', 'company-1', 'workflow-1', 1, 1, 'completed', 'issue/task-1', ?, ?, 'session-1', ?, ?, ?, ?, 'clean', ?, ?)").run(root, acceptedBase, now, now, taskHead, taskTree, delivery.id, evidence.id);
  });
  let calls = 0;
  const taskFailure: VerificationResult = { outcome: "failed", code: "verification_failed", summary: "Task verification failed", commands: [] };
  const baseResult: VerificationResult = baseOutcome === "passed" ? { outcome: "passed", summary: "Base verification passed", commands: [] } : { outcome: "failed", code: "verification_failed", summary: "Base verification failed", commands: [] };
  const context = createActivityContext(database, config, { githubRelease: { getRemoteRepository: async () => "acme/project", getBranchHead: async () => baseSha } as never });
  const activities = createTargetBaseActivities({ ...context, runPinnedVerification: async () => (++calls === 1 ? taskFailure : baseResult) });
  const input = { taskId: "task-1", companyId: "company-1", workflowId: "workflow-1", projectRevisionId: configuration.id, checkpoint: "pre_release" as const, developerExecutionId: "developer-1", expectedBaseSha: acceptedBase, expectedHeadSha: taskHead, expectedHeadTree: taskTree };
  return { root, database, activities, input, baseSha, calls: () => calls };
}

test("continues when task and base verification both fail and records the base outcome", async () => {
  const value = await fixture("failed");
  try {
    const result = await value.activities.reconcileTargetBase(value.input);
    expect(result).toMatchObject({ outcome: "revalidated" });
    expect(value.calls()).toBe(2);
    const artifact = value.database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath, sha256 FROM forge_artifacts WHERE task_id = 'task-1' AND kind = 'forward-merge-verification' ORDER BY created_at DESC LIMIT 1").get() as { storagePath: string; sha256: string });
    const payload = JSON.parse((await new ArtifactStore(join(value.root, "artifacts"), value.database).getArtifact({ companyId: "company-1", storagePath: artifact.storagePath, sha256: artifact.sha256 })).toString("utf8"));
    expect(payload).toMatchObject({ base: { sha: value.baseSha, outcome: "failed", summary: "Base verification failed" }, summary: "The base branch does not pass verification. GitHub CI judges the pull request." });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("blocks when the task fails but the base passes", async () => {
  const value = await fixture("passed");
  try {
    await expect(value.activities.reconcileTargetBase(value.input)).resolves.toMatchObject({ outcome: "blocked", code: "verification_failed" });
    expect(value.calls()).toBe(2);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
