import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
// eslint-disable-next-line no-restricted-imports -- direct Git is required because the Developer guard intentionally blocks worktree commands.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createLocalWorktreeCleanup } from "../src/engine/activities/worktree.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("/usr/bin/git", args, { cwd })).stdout.trim();
}

async function fixture(input: { legacyConfiguration?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "forge-cleanup-fallback-"));
  const repositoryPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath); await mkdir(worktreeRoot);
  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await git(["add", "README.md"], repositoryPath); await git(["commit", "-m", "fixture"], repositoryPath);
  const baseSha = await git(["rev-parse", "HEAD"], repositoryPath);
  const worktreePath = join(worktreeRoot, "task_1");
  const branchName = "work/task_1";
  await git(["worktree", "add", "-b", branchName, worktreePath, baseSha], repositoryPath);
  const config = createTestConfig(root, { worktreeRoot });
  const database = new ForgeDatabase(config.databasePath);
  database.authQuery((db) => db.pragma("foreign_keys = OFF"));
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, created_at) VALUES ('company_1', 'Company', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/project', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(repositoryPath, worktreeRoot, now, now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_1', 'Builder', 'codex', 'gpt-5-codex', 'medium', 'standard', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_1', 'internal', 'Builder', 'builder', 'builder', 'profile_1', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief', '[]', '{\"builder\":\"agent_1\"}', 0, 'workflow_1', 'revision_1', 'key', ?, ?, ?)").run("a".repeat(64), now, now);
  });
  const configuration = { projectId: "project_1", projectName: "Project", repositoryPath, worktreeRoot, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha, targetSha: baseSha, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "agent_1" }, roleProfiles: { builder: "profile_1" }, capturedAt: now };
  const artifact = input.legacyConfiguration ? undefined : await new ArtifactStore(config.artifactRoot, database).putArtifact("company_1", "task-project-configuration", { taskId: "task_1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(configuration)) });
  database.authTransaction((db) => {
    if (artifact) db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ? WHERE id = 'task_1'").run(artifact.id);
    else db.prepare("INSERT INTO forge_task_configuration_backfill (task_id, created_at) VALUES ('task_1', ?)").run(now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer_1', 'task_1', 'company_1', 'workflow_1', 1, 1, 'completed', ?, ?, ?, ?)").run(branchName, worktreePath, baseSha, now);
  });
  const cleanupWorktree = createLocalWorktreeCleanup(database, config, { run: git });
  return { root, repositoryPath, worktreeRoot, worktreePath, config, database, cleanupWorktree };
}

test("removes a clean worktree that exists on disk", async () => {
  const value = await fixture();
  try {
    const result = await value.cleanupWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" });
    expect(result.outcome).toBe("cleaned");
    expect(existsSync(value.worktreePath)).toBe(false);
    expect(await git(["worktree", "list", "--porcelain"], value.repositoryPath)).not.toContain(value.worktreePath);
    expect(value.database.authQuery((db) => db.prepare("SELECT event_type FROM forge_issue_timeline WHERE task_id = 'task_1'").get())).toEqual({ event_type: "worktree_cleaned" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("reports already absent when the worktree path no longer exists", async () => {
  const value = await fixture();
  try {
    await rm(value.worktreePath, { recursive: true, force: true });
    const result = await value.cleanupWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" });
    expect(result).toMatchObject({ outcome: "already_absent", dirtyFileCount: 0 });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("materializes a legacy configuration before reporting an absent worktree", async () => {
  const value = await fixture({ legacyConfiguration: true });
  try {
    await rm(value.worktreePath, { recursive: true, force: true });
    const result = await value.cleanupWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" });
    expect(result).toMatchObject({ outcome: "already_absent", dirtyFileCount: 0 });
    expect(value.database.authQuery((db) => db.prepare("SELECT t.project_configuration_artifact_id AS artifactId, t.project_configuration_captured_at AS capturedAt, a.kind FROM forge_tasks t LEFT JOIN forge_artifacts a ON a.id = t.project_configuration_artifact_id WHERE t.id = 'task_1'").get())).toMatchObject({ artifactId: expect.any(String), capturedAt: expect.any(String), kind: "task-project-configuration" });
    expect(value.database.authQuery((db) => db.prepare("SELECT task_id FROM forge_task_configuration_backfill WHERE task_id = 'task_1'").get())).toBeUndefined();
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("requires confirmation for a dirty worktree and cleans it after confirmation", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.worktreePath, "dirty.txt"), "dirty\n");
    const blocked = await value.cleanupWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" });
    expect(blocked).toMatchObject({ outcome: "dirty_confirmation_required", dirtyFileCount: 1 });
    expect(existsSync(value.worktreePath)).toBe(true);
    const confirmed = await value.cleanupWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", confirmDiscardDirty: true });
    expect(confirmed.outcome).toBe("cleaned");
    expect(existsSync(value.worktreePath)).toBe(false);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
