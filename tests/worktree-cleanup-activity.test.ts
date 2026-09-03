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
import { createActivityContext } from "../src/engine/activities/context.js";
import { createWorktreeActivities } from "../src/engine/activities/worktree.js";
import { WorktreeManager } from "../src/worktrees.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("/usr/bin/git", args, { cwd })).stdout.trim();
}

function activities(value: Awaited<ReturnType<typeof fixture>>) {
  const context = createActivityContext(value.database, value.config);
  Object.assign(context, { worktrees: new WorktreeManager({ run: git }) });
  return createWorktreeActivities(context);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-cleanup-activity-"));
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
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief', '[]', '{}', 0, 'workflow_1', 'revision_1', 'key', ?, ?, ?)").run("a".repeat(64), now, now);
  });
  const configuration = { projectId: "project_1", projectName: "Project", repositoryPath, worktreeRoot, repository: "acme/project", baseBranch: "main", targetBranch: "main", baseSha, targetSha: baseSha, setupCommand: "true", verificationCommand: "true", requiredChecks: [], roleAgents: { builder: "builder" }, roleProfiles: { builder: "profile" }, capturedAt: now };
  const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact("company_1", "task-project-configuration", { taskId: "task_1", filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(configuration)) });
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ? WHERE id = 'task_1'").run(artifact.id);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer_1', 'task_1', 'company_1', 'workflow_1', 1, 1, 'completed', ?, ?, ?, ?)").run(branchName, worktreePath, baseSha, now);
  });
  return { root, repositoryPath, worktreeRoot, worktreePath, config, database };
}

test("cleans a worktree recorded only by a developer execution", async () => {
  const value = await fixture();
  try {
    const result = await activities(value).cleanupTaskWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" });
    expect(result.outcome).toBe("cleaned");
    expect(existsSync(value.worktreePath)).toBe(false);
    expect(await git(["worktree", "list", "--porcelain"], value.repositoryPath)).not.toContain(value.worktreePath);
    expect(value.database.authQuery((db) => db.prepare("SELECT event_type FROM forge_issue_timeline WHERE task_id = 'task_1'").get())).toEqual({ event_type: "worktree_cleaned" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("cleans a worktree when a stale dispatching turn belongs to a failed execution", async () => {
  const value = await fixture();
  try {
    const now = new Date().toISOString();
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = ? WHERE id = 'developer_1'").run(now);
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn_stale', 'task_1', 'session_1', 'builder', 'developer', 'developer_1', 'implementation', ?, 'herdr-results/task_1/developer/result-turn_stale.json', 0, 'dispatching', ?, ?)").run("c".repeat(64), now, now);
    });
    const resultPath = join(value.config.runtimeRoot, "herdr-results/task_1/developer/result-turn_stale.json");
    await mkdir(join(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, JSON.stringify({ kind: "delivery", summary: "Done", steps: [{ number: 1, status: "completed", filesChanged: [], notes: "Done" }], authorizedStepsNotCompleted: [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean", blocker: null }));
    await expect(activities(value).cleanupTaskWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" })).resolves.toMatchObject({ outcome: "cleaned" });
    expect(existsSync(value.worktreePath)).toBe(false);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("keeps a worktree when a dispatching turn belongs to a starting execution", async () => {
  const value = await fixture();
  try {
    const now = new Date().toISOString();
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_developer_executions SET status = 'starting' WHERE id = 'developer_1'").run();
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn_stale', 'task_1', 'session_1', 'builder', 'developer', 'developer_1', 'implementation', ?, 'herdr-results/task_1/developer/result-turn_stale.json', 0, 'dispatching', ?, ?)").run("c".repeat(64), now, now);
    });
    await expect(activities(value).cleanupTaskWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" })).resolves.toMatchObject({ outcome: "not_owned" });
    expect(existsSync(value.worktreePath)).toBe(true);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("rejects a developer worktree outside the configured root", async () => {
  const value = await fixture();
  try {
    value.database.authTransaction((db) => db.prepare("UPDATE forge_developer_executions SET worktree_path = ? WHERE id = 'developer_1'").run(join(value.root, "outside")));
    await expect(activities(value).cleanupTaskWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" })).resolves.toMatchObject({ outcome: "not_owned" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("requires confirmation for a dirty developer worktree", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.worktreePath, "dirty.txt"), "dirty\n");
    await expect(activities(value).cleanupTaskWorktree({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1" })).resolves.toMatchObject({ outcome: "dirty_confirmation_required", dirtyFileCount: 1 });
    expect(existsSync(value.worktreePath)).toBe(true);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
