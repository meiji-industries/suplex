import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { reconcileActiveTurns } from "../src/active-turn-recovery.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((remove) => remove())); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-active-turn-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  cleanup.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const now = "2026-08-27T00:00:00.000Z";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
    db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task', 'company', 'project', 'workflow', 1, 'planning', 'lead', '[]', NULL, ?, 'event')").run(now);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, status, created_at, updated_at) VALUES ('session', 'task', 'lead', 1, 1, 'codex', 'ready', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('turn', 'task', 'session', 'planner', 'agent', 'execution', 'plan', ?, 'herdr-results/task/lead/result-turn.json', 0, 'waiting', ?, ?)").run("c".repeat(64), now, now);
  });
  await mkdir(join(config.runtimeRoot, "herdr-results/task/lead"), { recursive: true });
  await writeFile(join(config.runtimeRoot, "herdr-results/task/lead/result-turn.json"), JSON.stringify({ status: "ok" }));
  return { database, config };
}

test("adopts a valid turn outcome idempotently", async () => {
  const { database, config } = await fixture();
  const herdr = { getAgent: async () => null };
  const first = await reconcileActiveTurns(database, config, { herdr: herdr as never });
  const rows = database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_herdr_turns").get());
  const second = await reconcileActiveTurns(database, config, { herdr: herdr as never });
  expect(first).toEqual(second);
  expect(first).toMatchObject([{ taskId: "task", turnId: "turn", role: "lead", action: "advance" }]);
  expect(database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE turn_id = 'turn'").get())).toEqual({ status: "completed" });
  expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_herdr_turns").get())).toEqual(rows);
});

test("a late result for a failed Developer execution triggers one reconcile-only retry", async () => {
  const { database, config } = await fixture();
  const now = "2026-08-27T00:00:00.000Z";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, status, created_at, updated_at) VALUES ('dev-session', 'task', 'developer', 1, 1, 'codex', 'ready', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at, finished_at, failure_code) VALUES ('dev-execution', 'task', 'company', 'workflow', 1, 1, 'failed', 'work/x', '/missing', ?, ?, ?, ?, 'prompt-not-accepted')").run("d".repeat(40), now, now, now);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, created_at, updated_at) VALUES ('dev-turn', 'task', 'dev-session', 'builder', 'developer', 'dev-execution', 'implementation', ?, 'herdr-results/task/developer/result-dev-turn.json', 0, 'completed', ?, ?)").run("e".repeat(64), now, now);
  });
  await mkdir(join(config.runtimeRoot, "herdr-results/task/developer"), { recursive: true });
  await writeFile(join(config.runtimeRoot, "herdr-results/task/developer/result-dev-turn.json"), JSON.stringify({ kind: "delivery" }));
  const calls: unknown[] = [];
  const reconcileDeveloper = async (_config: unknown, workflowId: string, input: unknown) => { calls.push({ workflowId, input }); database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', failure_code = NULL WHERE id = 'dev-execution'").run()); return {} as never; };
  const herdr = { getAgent: async () => null };
  await reconcileActiveTurns(database, config, { herdr: herdr as never, reconcileDeveloper: reconcileDeveloper as never });
  await reconcileActiveTurns(database, config, { herdr: herdr as never, reconcileDeveloper: reconcileDeveloper as never });
  expect(calls).toEqual([{ workflowId: "workflow", input: { expectedRevision: 1, actorUserId: "system", commandId: "late-result-dev-turn", reconcileOnly: true } }]);
});
