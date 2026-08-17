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
}

export interface AgentRecoveryOutcome {
  executionId: string;
  status: "active" | "terminal_result" | "ownership_ambiguous";
  reason: "live-wrapper" | "stored-wrapper-result" | "wrapper-missing" | "wrapper-identity-mismatch";
}

function rows(database: ForgeDatabase): AgentExecutionRow[] {
  return database.authQuery((db) => db.prepare("SELECT id, task_id, status, process_pid, process_group_id, process_start_identity, wrapper_id, wrapper_path FROM forge_agent_executions WHERE status IN ('starting', 'running', 'cancelling') AND (wrapper_id IS NOT NULL OR wrapper_path IS NOT NULL) ORDER BY started_at, id").all() as AgentExecutionRow[]);
}

function markAmbiguous(database: ForgeDatabase, row: AgentExecutionRow, reason: string): void {
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_agent_executions SET status = 'ownership_ambiguous', finished_at = ?, heartbeat_at = ?, failure_code = 'ownership-ambiguous', failure_summary = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(new Date().toISOString(), new Date().toISOString(), reason, row.id);
    db.prepare("UPDATE forge_issue_projections SET owner = 'human', allowed_commands_json = '[]', pending_action = ?, updated_at = ? WHERE task_id = ?").run("Operator must verify Agent ownership", new Date().toISOString(), row.task_id);
  });
}

/** Reconcile Agent wrappers before the Temporal worker begins polling. */
export async function reconcileAgentExecutions(database: ForgeDatabase, controller: ProcessController = defaultProcessController): Promise<AgentRecoveryOutcome[]> {
  const outcomes: AgentRecoveryOutcome[] = [];
  for (const row of rows(database)) {
    if (!row.wrapper_id || !row.wrapper_path) {
      markAmbiguous(database, row, "Agent wrapper identity is missing");
      outcomes.push({ executionId: row.id, status: "ownership_ambiguous", reason: "wrapper-missing" });
      continue;
    }
    if (!row.process_pid || !row.process_group_id || !row.process_start_identity) {
      markAmbiguous(database, row, "Agent process ownership evidence is incomplete");
      outcomes.push({ executionId: row.id, status: "ownership_ambiguous", reason: "wrapper-identity-mismatch" });
      continue;
    }
    const inspection = await inspectDurableExecution({ controller, executionId: row.id, wrapperPath: row.wrapper_path, processPid: row.process_pid, processGroupId: row.process_group_id, processStartIdentity: row.process_start_identity });
    if (inspection.status === "terminal_result") {
      database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running')").run(new Date().toISOString(), row.id));
      outcomes.push({ executionId: row.id, status: "terminal_result", reason: "stored-wrapper-result" });
      continue;
    }
    if (inspection.status !== "live") {
      markAmbiguous(database, row, "Agent wrapper or child process identity does not match the durable ledger");
      outcomes.push({ executionId: row.id, status: "ownership_ambiguous", reason: inspection.status === "missing" ? "wrapper-missing" : "wrapper-identity-mismatch" });
      continue;
    }
    database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET heartbeat_at = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling')").run(new Date().toISOString(), row.id));
    outcomes.push({ executionId: row.id, status: "active", reason: "live-wrapper" });
  }
  return outcomes;
}

async function agentRow(database: ForgeDatabase, executionId: string): Promise<AgentExecutionRow | undefined> {
  return database.authQuery((db) => db.prepare("SELECT id, task_id, status, process_pid, process_group_id, process_start_identity, wrapper_id, wrapper_path FROM forge_agent_executions WHERE id = ?").get(executionId) as AgentExecutionRow | undefined);
}

export async function cancelAgentExecution(database: ForgeDatabase, executionId: string, controller: ProcessController = defaultProcessController): Promise<{ status: "cancelled" | "ownership_ambiguous"; reason?: string }> {
  const row = await agentRow(database, executionId);
  if (!row || !["starting", "running"].includes(row.status)) return { status: "ownership_ambiguous", reason: "execution-not-active" };
  if (!row.process_pid || !row.process_group_id || !row.process_start_identity || !row.wrapper_id || !row.wrapper_path) {
    markAmbiguous(database, row, "Forge cannot prove ownership of the recorded Agent process");
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
    markAmbiguous(database, row, "Forge refused cancellation because Agent process ownership could not be proven");
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
    markAmbiguous(database, row, "Forge could not prove the Agent process group terminated");
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
