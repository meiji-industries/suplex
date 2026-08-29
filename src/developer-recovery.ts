import { HerdrCodexProvider } from "./agent-providers/herdr-codex.js";
import type { ForgeDatabase } from "./database.js";
import { CliHerdrClient } from "./herdr-client.js";
import { reconcileHerdrSessions } from "./herdr-recovery.js";
import type { DeveloperCancellationResult } from "./engine/issue-contracts.js";
import { cancelOperation, operationKey } from "./operation-claims.js";

export interface DeveloperRecoveryOutcome {
  executionId: string;
  status: "active" | "failed";
  reason?: string;
}

export interface RestoredDeveloperRecoveryReport {
  executionId: string;
  status: "active" | "failed";
  reason: "session-active" | "session-missing";
}

export async function reconcileDeveloperExecutions(database: ForgeDatabase): Promise<DeveloperRecoveryOutcome[]> {
  const sessionOutcomes = await reconcileHerdrSessions(database);
  const developerSessionIds = new Set(database.authQuery((db) => db.prepare("SELECT id FROM forge_herdr_role_sessions WHERE session_role IN ('builder', 'integrator') AND is_current = 1 AND status NOT IN ('closed')").all() as Array<{ id: string }>).map((session) => session.id));
  const sessionsByTask = new Map(
    sessionOutcomes
      .filter((outcome) => developerSessionIds.has(outcome.sessionId))
      .map((outcome) => [outcome.taskId, outcome]),
  );
  const executions = database.authQuery((db) => db
    .prepare("SELECT id, task_id AS taskId FROM forge_developer_executions WHERE status IN ('starting', 'running') ORDER BY started_at, id")
    .all() as Array<{ id: string; taskId: string }>);
  return executions.map((execution) => {
    const session = sessionsByTask.get(execution.taskId);
    if (session && session.status !== "failed" && session.status !== "unbound") {
      return { executionId: execution.id, status: "active" as const };
    }
    database.authTransaction((db) => db
      .prepare("UPDATE forge_developer_executions SET status = 'failed', finished_at = COALESCE(finished_at, ?), failure_code = 'developer-session-missing', failure_summary = 'Builder session cannot be recovered.' WHERE id = ? AND status IN ('starting', 'running')")
      .run(new Date().toISOString(), execution.id));
    return { executionId: execution.id, status: "failed" as const, reason: "herdr-session-missing" };
  });
}

export async function reconcileRestoredDeveloperExecutions(database: ForgeDatabase): Promise<RestoredDeveloperRecoveryReport[]> {
  return (await reconcileDeveloperExecutions(database)).map((outcome) => ({
    executionId: outcome.executionId,
    status: outcome.status,
    reason: outcome.status === "active" ? "session-active" : "session-missing",
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
