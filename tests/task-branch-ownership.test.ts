import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { TaskService } from "../src/tasks.js";

const now = "2026-08-28T00:00:00.000Z";
const sha = "a".repeat(40);

async function fixture(phase: "planning" | "done" | "cancelled" | "failed", archived = false) {
  const root = await mkdtemp(join(tmpdir(), "forge-branch-owner-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile', 'Profile', 'codex', 'gpt-5.6-sol', 'medium', 'standard', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('builder', 'internal', 'Builder', 'builder', 'builder', 'profile', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'main', 'main', '', '', '[]', ?, 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), JSON.stringify({ builder: "builder" }), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'company/brief.bin', ?)").run("0".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('owner-task', 'company', 'project', 'Existing source task', 'brief', '[]', '{}', 0, 'owner-workflow', 'revision', 'owner-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('owner-task', 'company', 'project', 'owner-workflow', 1, ?, 'lead', '[]', 'Working', ?, 'owner-workflow:1')").run(phase, now);
    db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES ('owner-worktree', 'owner-task', 'company', 'project', 'owner-workflow', ?, ?, ?, 'feat/owned', ?, 'lease', 'active', ?)").run(join(root, "repo"), join(root, "worktrees"), join(root, "worktrees", "owner"), sha, now);
  });
  if (archived) database.authTransaction((db) => db.prepare("UPDATE forge_tasks SET archived_at = ? WHERE id = 'owner-task'").run(now));
  const project = { id: "project", companyId: "company", name: "Project", repositoryPath: join(root, "repo"), worktreeRoot: join(root, "worktrees"), repository: "acme/project", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: [], roleDefaults: { builder: "builder" }, createdAt: now, updatedAt: now };
  const tasks = new TaskService(database, { requireCompanyAccess() { return { status: "active" }; }, recordAuditEventInTransaction() {} } as never, {
    getProject() { return project; },
    async resolveTaskSource() { return { kind: "branch" as const, branch: "feat/owned", headSha: sha }; },
    async captureTaskConfiguration() { return { baseSha: sha, targetSha: sha }; },
  } as never, config, { workflow: { async start() { return { workflowId: "new-workflow", runId: "run" }; } } as never });
  return { root, database, tasks };
}

test("task creation rejects an active task that owns the source branch", async () => {
  const value = await fixture("planning");
  try {
    const input = { projectId: "project", title: "Duplicate source task", description: "Body", idempotencyKey: "duplicate-owned-branch", images: [], source: { kind: "branch" as const, branch: "feat/owned" } };
    const rejected = {
      statusCode: 409,
      ownerTaskId: "owner-task",
      findings: [expect.objectContaining({ code: "branch-owned-by-task", field: "source", message: "Existing source task (owner-task) already owns feat/owned. Finish or cancel it first." })],
    };
    await expect(value.tasks.createTask("member", "company", input)).rejects.toMatchObject(rejected);
    await expect(value.tasks.createTask("member", "company", input)).rejects.toMatchObject(rejected);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test.each(["done", "cancelled"] as const)("task creation allows a %s task that previously owned the source branch", async (phase) => {
  const value = await fixture(phase);
  try {
    await expect(value.tasks.createTask("member", "company", { projectId: "project", title: "New source task", description: "Body", idempotencyKey: `new-${phase}-branch`, images: [], source: { kind: "branch", branch: "feat/owned" } })).resolves.toMatchObject({ created: true });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("task creation allows an archived task that previously owned the source branch even when its phase is failed", async () => {
  const value = await fixture("failed", true);
  try {
    await expect(value.tasks.createTask("member", "company", { projectId: "project", title: "New source task", description: "Body", idempotencyKey: "new-archived-branch", images: [], source: { kind: "branch", branch: "feat/owned" } })).resolves.toMatchObject({ created: true });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
