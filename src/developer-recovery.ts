import type { ForgeDatabase } from "./database.js";
import { defaultProcessController, type ProcessInspection } from "./process-manager.js";
import type { DeveloperCancellationResult } from "./temporal/issue-contracts.js";

export interface DeveloperProcessInspection {
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
  command: string;
  executable?: string;
  argv?: string[];
  ownerUid?: number;
}

export interface DeveloperProcessController {
  inspect(pid: number): Promise<DeveloperProcessInspection | undefined>;
  signalGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  isProcessGroupAlive?: (processGroupId: number) => Promise<boolean>;
}

export interface DeveloperRecoveryOutcome {
  executionId: string;
  status: "active" | "failed";
  reason?: string;
}

export interface RestoredDeveloperRecoveryReport {
  executionId: string;
  status: "active" | "failed";
  reason: "process-alive" | "process-missing";
}

const controller: DeveloperProcessController = {
  async inspect(pid) {
    const process = await defaultProcessController.inspect(pid);
    return process ? { pid: process.pid, processGroupId: process.processGroup, processStartIdentity: `${process.pid}:${process.startTime}`, command: process.command, executable: process.executable, argv: process.argv, ...(process.ownerUid === undefined ? {} : { ownerUid: process.ownerUid }) } : undefined;
  },
  async signalGroup(processGroupId, signal) { await defaultProcessController.signalGroup?.(processGroupId, signal); },
  ...(defaultProcessController.isProcessGroupAlive ? { isProcessGroupAlive: defaultProcessController.isProcessGroupAlive } : {}),
};

interface RunningExecution { id: string; processPid: number | null }

function running(database: ForgeDatabase): RunningExecution[] {
  return database.authQuery((db) => db.prepare("SELECT id, process_pid AS processPid FROM forge_developer_executions WHERE status = 'running' ORDER BY started_at, id").all() as RunningExecution[]);
}

function fail(database: ForgeDatabase, executionId: string): void {
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = COALESCE(finished_at, ?), failure_code = 'developer-process-missing', failure_summary = 'Builder process is no longer running.' WHERE id = ? AND status = 'running'").run(now, executionId);
    db.prepare("UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = 'process_failed', wait_reason = NULL, updated_at = ? WHERE execution_kind = 'developer' AND execution_id = ? AND status = 'active'").run(now, now, executionId);
  });
}

/** A running execution remains untouched while its recorded Builder pid exists. */
export async function reconcileDeveloperExecutions(database: ForgeDatabase, processController: DeveloperProcessController = controller): Promise<DeveloperRecoveryOutcome[]> {
  const outcomes: DeveloperRecoveryOutcome[] = [];
  for (const execution of running(database)) {
    if (execution.processPid && await processController.inspect(execution.processPid)) outcomes.push({ executionId: execution.id, status: "active", reason: "process-alive" });
    else { fail(database, execution.id); outcomes.push({ executionId: execution.id, status: "failed", reason: "process-missing" }); }
  }
  return outcomes;
}

export async function reconcileRestoredDeveloperExecutions(database: ForgeDatabase, processController: DeveloperProcessController = controller): Promise<RestoredDeveloperRecoveryReport[]> {
  return (await reconcileDeveloperExecutions(database, processController)).map((outcome) => ({ executionId: outcome.executionId, status: outcome.status, reason: outcome.status === "active" ? "process-alive" : "process-missing" }));
}

export async function cancelDeveloperExecution(database: ForgeDatabase, executionId: string, processController: DeveloperProcessController = controller): Promise<DeveloperCancellationResult> {
  const execution = database.authQuery((db) => db.prepare("SELECT process_pid AS processPid, process_group_id AS processGroupId FROM forge_developer_executions WHERE id = ? AND status = 'running'").get(executionId) as { processPid: number | null; processGroupId: number | null } | undefined);
  if (!execution?.processPid || !await processController.inspect(execution.processPid)) {
    fail(database, executionId);
    return { status: "interrupted", executionId, reasonCode: "developer-process-missing", summary: "Builder process is no longer running." };
  }
  if (execution.processGroupId) await processController.signalGroup(execution.processGroupId, "SIGTERM");
  const now = new Date().toISOString();
  database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'cancelled', finished_at = ?, failure_code = NULL, failure_summary = NULL WHERE id = ? AND status = 'running'").run(now, executionId));
  return { status: "cancelled_confirmed", executionId, exitCode: null, exitSignal: "SIGTERM", evidenceArtifactId: null };
}

export type { ProcessInspection };
