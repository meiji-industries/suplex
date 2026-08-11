import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ForgeDatabase } from "./database.js";

const execFileAsync = promisify(execFile);

export interface DeveloperProcessInspection {
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
  command: string;
}

export interface DeveloperProcessController {
  inspect(pid: number): Promise<DeveloperProcessInspection | undefined>;
  signalGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface DeveloperRecoveryOutcome {
  executionId: string;
  status: "active" | "recovered" | "interrupted" | "ownership_ambiguous";
  reason?: string;
}

export interface RestoredDeveloperRecoveryReport {
  executionId: string;
  status: "recovered" | "interrupted";
  reason: "stored-delivery-result" | "restore-invalidated-process-ownership";
}

interface DeveloperExecutionRow {
  id: string;
  task_id: string;
  company_id: string;
  workflow_id: string;
  status: string;
  process_pid: number | null;
  process_group_id: number | null;
  process_start_identity: string | null;
  wrapper_id: string | null;
  wrapper_path: string | null;
  worktree_path: string;
  delivery_artifact_id: string | null;
  evidence_artifact_id: string | null;
  result_commit: string | null;
  result_tree: string | null;
}

const defaultController: DeveloperProcessController = {
  async inspect(pid) {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], { maxBuffer: 32 * 1024 });
      const tokens = result.stdout.trim().split(/\s+/);
      if (tokens.length < 8) return undefined;
      const actualPid = Number(tokens[0]);
      const processGroupId = Number(tokens[1]);
      const startText = tokens.slice(2, 7).join(" ");
      const command = tokens.slice(7).join(" ");
      if (!Number.isInteger(actualPid) || !Number.isInteger(processGroupId) || !command) return undefined;
      return { pid: actualPid, processGroupId, processStartIdentity: `${actualPid}:${startText}`, command };
    } catch {
      return undefined;
    }
  },
  async signalGroup(processGroupId, signal) {
    if (!Number.isInteger(processGroupId) || processGroupId <= 1) throw new Error("Refusing to signal an unsafe process group");
    process.kill(-processGroupId, signal);
  },
};

function now(): string { return new Date().toISOString(); }

function activeRow(database: ForgeDatabase, executionId: string): DeveloperExecutionRow | undefined {
  return database.authQuery((db) => db.prepare("SELECT id, task_id, company_id, workflow_id, status, process_pid, process_group_id, process_start_identity, wrapper_id, wrapper_path, worktree_path, delivery_artifact_id, evidence_artifact_id, result_commit, result_tree FROM forge_developer_executions WHERE id = ?").get(executionId) as DeveloperExecutionRow | undefined);
}

function matchesOwnership(row: DeveloperExecutionRow, inspection: DeveloperProcessInspection): boolean {
  return row.process_pid === inspection.pid
    && row.process_group_id === inspection.processGroupId
    && Boolean(row.process_start_identity && row.process_start_identity === inspection.processStartIdentity)
    && Boolean(row.wrapper_id && row.wrapper_path)
    && inspection.command.includes(row.worktree_path);
}

function markInterrupted(database: ForgeDatabase, row: DeveloperExecutionRow, code: string, summary: string, status: "interrupted" | "ownership_ambiguous" = "interrupted"): void {
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_developer_executions SET status = ?, finished_at = ?, heartbeat_at = ?, failure_code = ?, failure_summary = ? WHERE id = ? AND status IN ('starting', 'running')").run(status, now(), now(), code, summary, row.id);
    db.prepare("UPDATE forge_issue_projections SET phase = 'development', owner = 'human', allowed_commands_json = ?, pending_action = ?, updated_at = ? WHERE task_id = ? AND phase = 'development'").run(JSON.stringify(status === "ownership_ambiguous" ? [] : ["retry_development", "cancel_development"]), status === "ownership_ambiguous" ? "Operator must verify Developer ownership" : "Developer turn interrupted", now(), row.task_id);
  });
}

/**
 * A restored installation cannot trust PIDs, process groups, or wrapper paths
 * copied from the source host. Reconcile those rows before the new worker can
 * admit another Developer turn. A fully persisted result is safe to consume
 * once; every other active row becomes an explicit interrupted attempt.
 */
export function reconcileRestoredDeveloperExecutions(database: ForgeDatabase): RestoredDeveloperRecoveryReport[] {
  const rows = database.authQuery((db) => db.prepare("SELECT id, task_id, company_id, workflow_id, status, process_pid, process_group_id, process_start_identity, wrapper_id, wrapper_path, worktree_path, delivery_artifact_id, evidence_artifact_id, result_commit, result_tree FROM forge_developer_executions WHERE status IN ('starting', 'running') ORDER BY started_at, id").all() as DeveloperExecutionRow[]);
  const reports: RestoredDeveloperRecoveryReport[] = [];
  for (const row of rows) {
    const restoredAt = now();
    if (row.delivery_artifact_id && row.evidence_artifact_id && row.result_commit && row.result_tree) {
      database.authTransaction((db) => {
        db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(restoredAt, restoredAt, row.id);
        db.prepare("UPDATE forge_issue_projections SET phase = 'delivery_ready', owner = 'lead', allowed_commands_json = '[\"review_delivery\",\"cancel_issue\"]', pending_action = 'Lead delivery review', updated_at = ? WHERE task_id = ? AND phase = 'development'").run(restoredAt, row.task_id);
      });
      reports.push({ executionId: row.id, status: "recovered", reason: "stored-delivery-result" });
      continue;
    }
    database.authTransaction((db) => {
      db.prepare("UPDATE forge_developer_executions SET status = 'interrupted', finished_at = ?, heartbeat_at = ?, failure_code = 'restore-process-invalidated', failure_summary = 'The source-host Developer process cannot be resumed from a restored installation.' WHERE id = ? AND status IN ('starting', 'running')").run(restoredAt, restoredAt, row.id);
      db.prepare("UPDATE forge_issue_projections SET phase = 'development', owner = 'human', allowed_commands_json = '[\"retry_development\",\"cancel_development\",\"cancel_issue\"]', pending_action = 'Developer turn interrupted during restore', updated_at = ? WHERE task_id = ? AND phase = 'development'").run(restoredAt, row.task_id);
    });
    reports.push({ executionId: row.id, status: "interrupted", reason: "restore-invalidated-process-ownership" });
  }
  return reports;
}

export async function reconcileDeveloperExecutions(database: ForgeDatabase, controller: DeveloperProcessController = defaultController): Promise<DeveloperRecoveryOutcome[]> {
  const rows = database.authQuery((db) => db.prepare("SELECT id, task_id, company_id, workflow_id, status, process_pid, process_group_id, process_start_identity, wrapper_id, wrapper_path, worktree_path, delivery_artifact_id, evidence_artifact_id, result_commit, result_tree FROM forge_developer_executions WHERE status IN ('starting', 'running') ORDER BY started_at, id").all() as DeveloperExecutionRow[]);
  const outcomes: DeveloperRecoveryOutcome[] = [];
  for (const row of rows) {
    if (!row.process_pid || !row.process_group_id || !row.process_start_identity || !row.wrapper_id || !row.wrapper_path) {
      markInterrupted(database, row, "ownership-missing", "Developer process ownership evidence is incomplete", "ownership_ambiguous");
      outcomes.push({ executionId: row.id, status: "ownership_ambiguous", reason: "ownership-missing" });
      continue;
    }
    const inspection = await controller.inspect(row.process_pid);
    if (!inspection) {
      if (row.delivery_artifact_id && row.evidence_artifact_id && row.result_commit && row.result_tree) {
        database.authTransaction((db) => {
          db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(now(), now(), row.id);
          db.prepare("UPDATE forge_issue_projections SET phase = 'delivery_ready', owner = 'lead', allowed_commands_json = '[]', pending_action = 'Lead delivery review', updated_at = ? WHERE task_id = ? AND phase = 'development'").run(now(), row.task_id);
        });
        outcomes.push({ executionId: row.id, status: "recovered", reason: "stored-delivery-result" });
      } else {
        markInterrupted(database, row, "process-missing", "The recorded Developer process is no longer present");
        outcomes.push({ executionId: row.id, status: "interrupted", reason: "process-missing" });
      }
      continue;
    }
    if (!matchesOwnership(row, inspection)) {
      markInterrupted(database, row, "ownership-ambiguous", "The recorded PID, process group, start identity, wrapper, or worktree does not match");
      outcomes.push({ executionId: row.id, status: "ownership_ambiguous", reason: "identity-mismatch" });
      continue;
    }
    database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(now(), row.id));
    outcomes.push({ executionId: row.id, status: "active" });
  }
  return outcomes;
}

export async function cancelDeveloperExecution(database: ForgeDatabase, executionId: string, controller: DeveloperProcessController = defaultController): Promise<{ status: "cancelled" | "ownership_ambiguous"; reason?: string }> {
  const row = activeRow(database, executionId);
  if (!row) throw new Error("Developer execution is unavailable");
  if (!row.process_pid || !row.process_group_id || !row.process_start_identity || !row.wrapper_id || !row.wrapper_path) {
    markInterrupted(database, row, "ownership-missing", "Forge cannot prove ownership of the recorded Developer process", "ownership_ambiguous");
    return { status: "ownership_ambiguous", reason: "ownership-missing" };
  }
  const inspection = await controller.inspect(row.process_pid);
  if (!inspection || !matchesOwnership(row, inspection)) {
    markInterrupted(database, row, "ownership-ambiguous", "Forge refused cancellation because process ownership could not be proven", "ownership_ambiguous");
    return { status: "ownership_ambiguous", reason: inspection ? "identity-mismatch" : "process-missing" };
  }
  await controller.signalGroup(row.process_group_id, "SIGTERM");
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_developer_executions SET status = 'cancelled', finished_at = ?, heartbeat_at = ?, failure_code = NULL, failure_summary = NULL WHERE id = ? AND status IN ('starting', 'running')").run(now(), now(), row.id);
    db.prepare("UPDATE forge_issue_projections SET phase = 'delivery_blocked', owner = 'human', allowed_commands_json = '[\"retry_development\"]', pending_action = 'Developer turn cancelled; retry or continue', updated_at = ? WHERE task_id = ? AND phase = 'development'").run(now(), row.task_id);
  });
  return { status: "cancelled" };
}
