import { HerdrCodexProvider } from "./agent-providers/herdr-codex.js";
import type { ForgeDatabase } from "./database.js";
import { CliHerdrClient } from "./herdr-client.js";
import { reconcileHerdrSessions } from "./herdr-recovery.js";

export interface AgentRecoveryOutcome { roleSessionId: string; status: "active" | "failed"; }

// Phase 5 owns pane/session liveness reconciliation. Legacy process checks are gone.
export async function reconcileAgentExecutions(database: ForgeDatabase): Promise<AgentRecoveryOutcome[]> {
  return (await reconcileHerdrSessions(database)).filter((outcome) => !outcome.sessionId.startsWith("tab:")).map((outcome) => ({ roleSessionId: outcome.sessionId, status: outcome.status === "failed" ? "failed" : "active" }));
}

export async function cancelAgentExecution(database: ForgeDatabase, executionId: string): Promise<{ status: "cancelled"; reason?: string }> {
  const execution = database.authQuery((db) =>
    db.prepare("SELECT task_id AS taskId FROM forge_agent_executions WHERE id = ? AND status IN ('starting', 'running')").get(executionId) as { taskId: string } | undefined,
  );
  if (!execution) return { status: "cancelled", reason: "execution-not-active" };
  await new HerdrCodexProvider(database, new CliHerdrClient()).interrupt(execution.taskId, "lead");
  return { status: "cancelled" };
}
