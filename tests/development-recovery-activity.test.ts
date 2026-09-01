import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { createDevelopmentActivities } from "../src/engine/activities/development.js";

test("finds a live developer turn for recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-development-recovery-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("b".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("c".repeat(64), now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, failure_code) VALUES ('execution', 'task', 'company', 'workflow', 1, 1, 'failed', 'forge/task', '/worktrees/task', ?, ?, 'worker-restart-orphan')").run("a".repeat(40), now);
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, status, created_at, updated_at) VALUES ('session', 'task', 'builder', 1, 1, 'codex', 'working', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn', 'task', 'session', 'builder', 'developer', 'execution', 'implementation', ?, 'results/turn.json', 0, 'waiting', ?, ?)").run("d".repeat(64), now, now);
    });
    const activities = createDevelopmentActivities(createActivityContext(database, config));
    await expect(activities.findRecoverableDeveloperExecution({ taskId: "task", companyId: "company", workflowId: "workflow" })).resolves.toMatchObject({ executionId: "execution", sessionRef: "session" });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
