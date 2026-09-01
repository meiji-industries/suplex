import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { failOrphanedExecutions } from "../src/worker.js";

test("fails active executions without a live Herdr turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('agent', 'task', 'company', 'workflow', 'planner', 'running', 1, ?)").run(now);
    });
    expect(failOrphanedExecutions(database, new Set(), now)).toEqual({ agentExecutions: 1, developerExecutions: 0 });
    expect(database.authQuery((db) => db.prepare("SELECT status, failure_code FROM forge_agent_executions WHERE id = 'agent'").get())).toEqual({ status: "failed", failure_code: "worker-restart-orphan" });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
