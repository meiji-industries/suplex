import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { resolveAgentProvider } from "../src/agent-providers/index.js";
import { DeveloperService } from "../src/codex-developer.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

test("Developer transcript receipts persist incrementally and remain idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-events-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const executionId = "developer_events_test";
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_events', 'Events', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_events', 'company_events', 'Events', ?, ?, 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact_events', 'company_events', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'artifacts/brief.md', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_events', 'company_events', 'project_events', 'Events', 'artifact_events', '[]', '{}', 'workflow_events', 'revision_events', 'events', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_events', 'company_events', 'workflow_events', 1, 1, 'running', 'work/events', ?, ?, ?, ?)").run(executionId, root, "a".repeat(40), now, now);
    });
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_events" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "command_1", type: "command_execution", command: "pnpm test", exit_code: 0, output: "passed" } }),
      JSON.stringify({ type: "item.completed", item: { id: "change_1", type: "file_change", changes: [{ path: join(root, "proof.ts") }] } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    const provider = resolveAgentProvider();
    const service = new DeveloperService(database, config);
    const persist = (service as unknown as { persistDeveloperReceipts(id: string, receipts: unknown[]): void }).persistDeveloperReceipts.bind(service);
    let state: unknown;
    for (const line of lines) {
      const parsed = provider.parseExecutionTranscript([line], { executionId, attempt: 1, worktreePath: root, ...(state ? { state } : {}) });
      state = parsed.parserState;
      persist(executionId, parsed.receipts);
    }
    const rows = database.authQuery((db) => db.prepare("SELECT sequence, kind FROM forge_developer_execution_events WHERE execution_id = ? ORDER BY sequence").all(executionId) as Array<{ sequence: number; kind: string }>);
    expect(rows).toEqual([{ sequence: 1, kind: "command_finished" }, { sequence: 2, kind: "test_result" }, { sequence: 3, kind: "file_change" }]);
    const full = provider.parseExecutionTranscript(lines, { executionId, attempt: 1, worktreePath: root });
    persist(executionId, full.receipts);
    expect(database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_developer_execution_events WHERE execution_id = ?").get(executionId) as { count: number }).count).toBe(3);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
