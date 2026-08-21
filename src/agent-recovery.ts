import type { ForgeDatabase } from "./database.js";
import { cleanupAgentWrapper, readAgentWrapperManifest } from "./agent-wrapper.js";
import { inspectDurableExecution, terminateOwnedProcessGroup, defaultProcessController, type ProcessController } from "./execution-recovery.js";

interface AgentExecutionRow {
  id: string;
  task_id: string;
  status: string;
  process_pid: number | null;
  process_group_id: number | null;
  process_start_identity: string | null;
  wrapper_id: string | null;
  wrapper_path: string | null;
  wrapper_pid: number | null;
  wrapper_start_identity: string | null;
}

export interface AgentRecoveryOutcome {
  executionId: string;
  status: "active" | "terminal_result" | "ownership_ambiguous" | "failed";
  reason: "live-wrapper" | "live-process" | "stored-wrapper-result" | "wrapper-missing" | "wrapper-identity-mismatch" | "process-gone";
}

const EXECUTION_COLUMNS = "id, task_id, status, process_pid, process_group_id, process_start_identity, wrapper_id, wrapper_path, wrapper_pid, wrapper_start_identity";

function rows(database: ForgeDatabase): AgentExecutionRow[] {
  return database.authQuery((db) => db.prepare(`SELECT ${EXECUTION_COLUMNS} FROM forge_agent_executions WHERE status IN ('starting', 'running', 'cancelling', 'ownership_ambiguous') ORDER BY started_at, id`).all() as AgentExecutionRow[]);
}

function markFailed(database: ForgeDatabase, row: AgentExecutionRow, summary: string): void {
  const now = new Date().toISOString();
  database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = 'worker-restart', failure_summary = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling', 'ownership_ambiguous')").run(now, now, summary, row.id));
}

function heartbeat(database: ForgeDatabase, row: AgentExecutionRow): void {
  database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(new Date().toISOString(), row.id));
}

/**
 * The recorded process identities decide the turn: every one still running is
 * proof of life, every one gone is proof of death. Only a partial match, or no
 * recorded identity at all, is genuinely ambiguous.
 */
async function recordedProcessLiveness(controller: ProcessController, row: AgentExecutionRow): Promise<"live" | "gone" | "unknown"> {
  const recorded = [
    row.process_pid && row.process_start_identity ? { pid: row.process_pid, identity: row.process_start_identity } : undefined,
    row.wrapper_pid && row.wrapper_start_identity ? { pid: row.wrapper_pid, identity: row.wrapper_start_identity } : undefined,
  ].filter((entry): entry is { pid: number; identity: string } => Boolean(entry));
  if (recorded.length === 0) return "unknown";
  const alive = await Promise.all(recorded.map(async (entry) => (await controller.inspect(entry.pid))?.processStartIdentity === entry.identity));
  if (alive.every(Boolean)) return "live";
  return alive.some(Boolean) ? "unknown" : "gone";
}

/** Reconcile Agent wrappers before the Temporal worker begins polling. */
export async function reconcileAgentExecutions(database: ForgeDatabase, controller: ProcessController = defaultProcessController): Promise<AgentRecoveryOutcome[]> {
  const outcomes: AgentRecoveryOutcome[] = [];
  for (const row of rows(database)) {
    const liveness = await recordedProcessLiveness(controller, row);
    if (liveness === "live") {
      // The recorded PID identities are sufficient to resume a turn. Wrapper
      // metadata is helpful for cleanup, but cannot turn a live Agent into a
      // human-owned ownership gate.
      heartbeat(database, row);
      outcomes.push({ executionId: row.id, status: "active", reason: "live-process" });
      continue;
    }
    if (liveness === "gone") {
      markFailed(database, row, "The recorded Agent process is gone; Forge failed the turn so the workflow can retry.");
      outcomes.push({ executionId: row.id, status: "failed", reason: "process-gone" });
      continue;
    }
    if (!row.wrapper_id || !row.wrapper_path || !row.process_pid || !row.process_group_id || !row.process_start_identity) {
      // Too little evidence for a wrapper inspection: the process identity decides.
      markFailed(database, row, "The recorded Agent process is no longer running; Forge failed the turn so the workflow can retry.");
      outcomes.push({ executionId: row.id, status: "failed", reason: row.wrapper_path ? "wrapper-identity-mismatch" : "wrapper-missing" });
      continue;
    }
    const inspection = await inspectDurableExecution({ controller, executionId: row.id, wrapperPath: row.wrapper_path, processPid: row.process_pid, processGroupId: row.process_group_id, processStartIdentity: row.process_start_identity });
    if (inspection.status === "terminal_result") {
      heartbeat(database, row);
      outcomes.push({ executionId: row.id, status: "terminal_result", reason: "stored-wrapper-result" });
      continue;
    }
    if (inspection.status !== "live") {
      markFailed(database, row, "The recorded Agent process is no longer running; Forge failed the turn so the workflow can retry.");
      outcomes.push({ executionId: row.id, status: "failed", reason: inspection.status === "missing" ? "wrapper-missing" : "wrapper-identity-mismatch" });
      continue;
    }
    heartbeat(database, row);
    outcomes.push({ executionId: row.id, status: "active", reason: "live-wrapper" });
  }
  return outcomes;
}

async function agentRow(database: ForgeDatabase, executionId: string): Promise<AgentExecutionRow | undefined> {
  return database.authQuery((db) => db.prepare(`SELECT ${EXECUTION_COLUMNS} FROM forge_agent_executions WHERE id = ?`).get(executionId) as AgentExecutionRow | undefined);
}

export async function cancelAgentExecution(database: ForgeDatabase, executionId: string, controller: ProcessController = defaultProcessController): Promise<{ status: "cancelled" | "ownership_ambiguous"; reason?: string }> {
  const row = await agentRow(database, executionId);
  if (!row || !["starting", "running"].includes(row.status)) return { status: "ownership_ambiguous", reason: "execution-not-active" };
  if (!row.process_pid || !row.process_group_id || !row.process_start_identity || !row.wrapper_id || !row.wrapper_path) {
    markFailed(database, row, "The recorded Agent process is no longer running; Forge failed the turn so the workflow can retry.");
    return { status: "ownership_ambiguous", reason: "ownership-missing" };
  }
  const inspection = await inspectDurableExecution({ controller, executionId: row.id, wrapperPath: row.wrapper_path, processPid: row.process_pid, processGroupId: row.process_group_id, processStartIdentity: row.process_start_identity });
  if (inspection.status === "terminal_result") {
    const finishedAt = new Date().toISOString();
    database.authTransaction((db) => db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = 'cancelled', failure_summary = 'Agent execution cancelled' WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(finishedAt, finishedAt, row.id));
    await cleanupAgentWrapper(inspection.wrapper.manifest.runtimeRoot, row.id).catch(() => undefined);
    return { status: "cancelled" };
  }
  if (inspection.status !== "live") {
    markFailed(database, row, "The recorded Agent process is no longer running; Forge failed the turn so the workflow can retry.");
    return { status: "ownership_ambiguous", reason: "identity-mismatch" };
  }
  database.authTransaction((db) => db.prepare("UPDATE forge_agent_executions SET status = 'cancelling', heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(new Date().toISOString(), row.id));
  let terminalProof = false;
  try {
    terminalProof = await terminateOwnedProcessGroup({
      controller,
      processPid: row.process_pid,
      processGroupId: row.process_group_id,
      processStartIdentity: row.process_start_identity,
      isTerminal: async () => (await inspectDurableExecution({ controller, executionId: row.id, wrapperPath: row.wrapper_path!, processPid: row.process_pid!, processGroupId: row.process_group_id!, processStartIdentity: row.process_start_identity! })).status === "terminal_result",
    });
  } catch {
    terminalProof = false;
  }
  if (!terminalProof) {
    markFailed(database, row, "The recorded Agent process is no longer running; Forge failed the turn so the workflow can retry.");
    return { status: "ownership_ambiguous", reason: "cancellation-timeout" };
  }
  database.authTransaction((db) => {
    const finishedAt = new Date().toISOString();
    db.prepare("UPDATE forge_agent_executions SET status = 'failed', finished_at = ?, heartbeat_at = ?, failure_code = 'cancelled', failure_summary = 'Agent execution cancelled' WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(finishedAt, finishedAt, row.id);
  });
  const manifest = await readAgentWrapperManifest(`${row.wrapper_path}/manifest.json`).catch(() => undefined);
  if (manifest) await cleanupAgentWrapper(manifest.manifest.runtimeRoot, row.id).catch(() => undefined);
  return { status: "cancelled" };
}
