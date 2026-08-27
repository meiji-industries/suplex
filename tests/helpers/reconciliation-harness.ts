import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestConfig, type ForgeConfig } from "../../src/config.js";
import { ForgeDatabase } from "../../src/database.js";
import { reconcileActiveTurns } from "../../src/active-turn-recovery.js";
import { reconcileGithubObservations } from "../../src/github-observation-reconciliation.js";
import { reconcileWorktrees } from "../../src/worktree-reconciliation.js";

export type SeedTaskOptions = {
  phase: string;
  role: "lead" | "developer";
  turnStatus: string;
  resultFile?: string;
  worktree?: "clean" | "dirty" | "missing" | "new_commit";
  herdr: "live" | "idle" | "terminal" | "missing" | "unavailable";
  github?: Record<string, unknown>;
};

export type ReconciliationSnapshot = {
  phase: string | null;
  owner: string | null;
  pendingAction: string | null;
  blocker: unknown;
  allowedCommands: unknown;
  turnRows: unknown[];
  executionRows: unknown[];
  timelineRows: unknown[];
  claimRows: unknown[];
  pushes: unknown[];
};

/** A deliberately small, migrated database fixture for recovery seam tests. */
export async function createReconciliationHarness() {
  const root = await mkdtemp(join(tmpdir(), "forge-reconciliation-matrix-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = "2026-08-27T00:00:00.000Z";

  function seedTask(options: SeedTaskOptions, taskId = "task"): void {
    database.authTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT OR IGNORE INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', ?, 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(config.worktreeRoot, now, now);
      db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), now);
      db.prepare("INSERT OR IGNORE INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'company', 'project', 'Task', 'brief', '[]', '{}', 0, ?, 'revision', ?, ?, ?)").run(taskId, `workflow-${taskId}`, `key-${taskId}`, now, now);
      db.prepare("INSERT OR REPLACE INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES (?, 'company', 'project', ?, 1, ?, ?, '[]', NULL, ?, ?)").run(taskId, `workflow-${taskId}`, options.phase, options.role, now, `event-${taskId}`);
    });
  }

  async function runAllReconciliation(taskId?: string): Promise<void> {
    await reconcileActiveTurns(database, config, { herdr: { getAgent: async () => null } as never }, taskId);
    await reconcileWorktrees(database, config, { taskId });
    await reconcileGithubObservations(database, config, { taskId, observe: undefined });
  }

  function snapshot(taskId = "task"): ReconciliationSnapshot {
    return database.authQuery((db) => {
      const projection = db.prepare("SELECT phase, owner, pending_action AS pendingAction, allowed_commands_json AS allowedCommands FROM forge_issue_projections WHERE task_id = ?").get(taskId) as { phase?: string; owner?: string; pendingAction?: string; allowedCommands?: string } | undefined;
      const all = (sql: string): unknown[] => db.prepare(sql).all(taskId) as unknown[];
      return { phase: projection?.phase ?? null, owner: projection?.owner ?? null, pendingAction: projection?.pendingAction ?? null, blocker: null, allowedCommands: projection?.allowedCommands ? JSON.parse(projection.allowedCommands) : [], turnRows: all("SELECT turn_id, status, result_sha256 FROM forge_herdr_turns WHERE task_id = ? ORDER BY turn_id"), executionRows: all("SELECT id, status FROM forge_agent_executions WHERE task_id = ? ORDER BY id"), timelineRows: all("SELECT event_type, metadata_json FROM forge_issue_timeline WHERE task_id = ? ORDER BY id"), claimRows: all("SELECT * FROM forge_operation_claims WHERE task_id = ? ORDER BY id"), pushes: [] };
    });
  }

  return { root, config: config as ForgeConfig, database, seedTask, runAllReconciliation, snapshot, close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}
