import { HerdrCodexProvider } from "./agent-providers/herdr-codex.js";
import type { ForgeDatabase } from "./database.js";
import { CliHerdrClient, type HerdrClient } from "./herdr-client.js";
import { observeHerdrSessions } from "./herdr-recovery.js";
import type { DeveloperCancellationResult } from "./engine/issue-contracts.js";
import { cancelOperation, operationKey } from "./operation-claims.js";

export interface DeveloperRecoveryOutcome {
  executionId: string;
  status: "active" | "recoverable" | "failed";
  reason?: "herdr-runtime-missing" | "herdr-binding-conflict";
}

export interface RestoredDeveloperRecoveryReport {
  executionId: string;
  status: "active" | "recoverable" | "failed";
  reason: "session-active" | "runtime-missing" | "identity-conflict";
}

export async function reconcileDeveloperExecutions(database: ForgeDatabase, herdr: HerdrClient = new CliHerdrClient()): Promise<DeveloperRecoveryOutcome[]> {
  const observationsBySession = new Map((await observeHerdrSessions(database, herdr)).map((observation) => [observation.sessionId, observation]));
  const executions = database.authQuery((db) => db
    .prepare(`SELECT execution.id, execution.task_id AS taskId,
      COALESCE((SELECT turn.role_session_id
        FROM forge_herdr_turns turn
        JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.is_current = 1 AND session.session_role IN ('builder', 'integrator')
        WHERE turn.ledger = 'developer' AND turn.execution_id = execution.id AND turn.task_id = execution.task_id
        ORDER BY turn.created_at DESC, turn.turn_id DESC LIMIT 1), execution.session_ref) AS sessionId
      FROM forge_developer_executions execution
      WHERE execution.status IN ('starting', 'running')
      ORDER BY execution.started_at, execution.id`)
    .all() as Array<{ id: string; taskId: string; sessionId: string | null }>);
  return executions.map((execution) => {
    const observation = execution.sessionId ? observationsBySession.get(execution.sessionId) : undefined;
    if (observation?.classification === "active") {
      return { executionId: execution.id, status: "active" as const };
    }
    if (observation?.classification !== "failed") {
      return { executionId: execution.id, status: "recoverable" as const, reason: "herdr-runtime-missing" as const };
    }
    database.authTransaction((db) => db
      .prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = COALESCE(finished_at, ?), failure_code = 'developer-session-identity-conflict', failure_summary = 'Builder pane identity conflicts with its Forge binding.' WHERE id = ? AND status IN ('starting', 'running')")
      .run(new Date().toISOString(), execution.id));
    return { executionId: execution.id, status: "failed" as const, reason: "herdr-binding-conflict" as const };
  });
}

export async function reconcileRestoredDeveloperExecutions(database: ForgeDatabase): Promise<RestoredDeveloperRecoveryReport[]> {
  return (await reconcileDeveloperExecutions(database)).map((outcome) => ({
    executionId: outcome.executionId,
    status: outcome.status,
    reason: outcome.status === "active" ? "session-active" : outcome.status === "recoverable" ? "runtime-missing" : "identity-conflict",
  }));
}

export async function cancelDeveloperExecution(database: ForgeDatabase, executionId: string, taskId?: string): Promise<DeveloperCancellationResult> {
  const execution = database.authQuery((db) => db.prepare("SELECT task_id AS taskId FROM forge_developer_executions WHERE id = ? AND status IN ('starting', 'running')").get(executionId) as { taskId: string } | undefined);
  if (!execution) {
    // An activity may be waiting in the worker-local capacity queue, before it
    // creates its execution ledger row. Its durable operation key is still
    // known to the workflow, so stop it at the next pre-start check.
    if (taskId) cancelOperation(database, { key: operationKey(["turn", taskId, executionId]), taskId, kind: "turn" });
    return { status: "cancelled", reason: "execution-not-started" } as DeveloperCancellationResult;
  }
  await new HerdrCodexProvider(database, new CliHerdrClient()).interrupt(execution.taskId, "developer");
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("UPDATE forge_developer_executions SET status = 'cancelled', finished_at = ?, failure_code = NULL, failure_summary = NULL WHERE id = ? AND status IN ('starting', 'running')").run(now, executionId);
    // `closed` is the established terminal role-session status.  Retiring the
    // current row makes the next ensure allocate a new generation and Codex
    // session, while deliberately leaving its pane alone for its owner.
    db.prepare("UPDATE forge_herdr_role_sessions SET is_current = 0, status = 'closed', updated_at = ? WHERE task_id = ? AND session_role IN ('builder', 'integrator') AND is_current = 1").run(now, execution.taskId);
  });
  return { status: "cancelled_confirmed", executionId, exitCode: null, exitSignal: "SIGINT", evidenceArtifactId: null };
}
