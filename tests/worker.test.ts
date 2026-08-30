import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { reclaimOrphanedHerdrExecutions, recoverOrphanedHerdrExecutions } from "../src/worker.js";

test("reclaims non-terminal agent and developer execution ledgers after a worker restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-reclaim-test-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  const startedAt = "2026-08-24T12:00:00.000Z";
  const finishedAt = "2026-08-24T12:01:00.000Z";
  const reclaimedAt = "2026-08-24T12:02:00.000Z";
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(startedAt);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(startedAt, startedAt);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), startedAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), startedAt, startedAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('agent-orphan', 'task', 'company', 'workflow', 'planner', 'starting', 1, ?)").run(startedAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, finished_at) VALUES ('agent-terminal', 'task', 'company', 'workflow', 'planner', 'completed', 2, ?, ?)").run(startedAt, finishedAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer-orphan', 'task', 'company', 'workflow', 1, 1, 'running', 'forge/task', '/worktrees/task', ?, ?)").run("c".repeat(40), startedAt);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, finished_at) VALUES ('developer-terminal', 'task', 'company', 'workflow', 1, 2, 'completed', 'forge/task', '/worktrees/task', ?, ?, ?)").run("c".repeat(40), startedAt, finishedAt);
    });

    expect(reclaimOrphanedHerdrExecutions(database, new Set(), reclaimedAt)).toEqual({ agentExecutions: 1, developerExecutions: 1 });
    expect(database.authQuery((db) => db.prepare("SELECT id, status, failure_code, finished_at FROM forge_agent_executions ORDER BY id").all())).toEqual([
      { id: "agent-orphan", status: "failed", failure_code: "worker-restart-orphan", finished_at: reclaimedAt },
      { id: "agent-terminal", status: "completed", failure_code: null, finished_at: finishedAt },
    ]);
    expect(database.authQuery((db) => db.prepare("SELECT id, status, failure_code, finished_at FROM forge_developer_executions ORDER BY id").all())).toEqual([
      { id: "developer-orphan", status: "failed", failure_code: "worker-restart-orphan", finished_at: reclaimedAt },
      { id: "developer-terminal", status: "completed", failure_code: null, finished_at: finishedAt },
    ]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses explicit recoverable bindings instead of mirrored role-session status", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-recovery-test-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  const now = new Date().toISOString();
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?)").run(now);
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, created_at, updated_at) VALUES ('session', 'task', 'planner', 1, 1, 'codex', 'codex', 'planner', 'pane', 'working', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn', 'task', 'session', 'planner', 'agent', 'execution', 'plan', ?, 'result.json', 0, 'waiting', ?, ?)").run("c".repeat(64), now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer-execution', 'task', 'company', 'workflow', 1, 1, 'running', 'forge/task', '/worktrees/task', ?, ?)").run("d".repeat(40), now);
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, status, created_at, updated_at) VALUES ('developer-session', 'task', 'builder', 1, 1, 'codex', 'developer-codex', 'builder', 'developer-pane', 'working', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('developer-turn', 'task', 'developer-session', 'builder', 'developer', 'developer-execution', 'implementation', ?, 'developer-result.json', 0, 'waiting', ?, ?)").run("e".repeat(64), now, now);
    });
    const recoverableBindings = new Set(["session", "developer-session"]);
    database.authQuery((db) => {
      db.prepare("UPDATE forge_herdr_role_sessions SET status = 'missing' WHERE id = 'session'").run();
      db.prepare("UPDATE forge_herdr_role_sessions SET status = 'closed' WHERE id = 'developer-session'").run();
    });
    expect(reclaimOrphanedHerdrExecutions(database, recoverableBindings, now)).toEqual({ agentExecutions: 0, developerExecutions: 0 });
    database.authQuery((db) => {
      db.prepare("UPDATE forge_agent_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = ? WHERE id = 'execution'").run(now);
      db.prepare("UPDATE forge_developer_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = ? WHERE id = 'developer-execution'").run(now);
    });
    expect(recoverOrphanedHerdrExecutions(database, recoverableBindings)).toEqual({ agentExecutions: 1, developerExecutions: 1 });
    expect(database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_agent_executions WHERE id = 'execution'").get())).toEqual({ status: "running", failure_code: null, finished_at: null });
    expect(database.authQuery((db) => db.prepare("SELECT status, failure_code, finished_at FROM forge_developer_executions WHERE id = 'developer-execution'").get())).toEqual({ status: "running", failure_code: null, finished_at: null });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
