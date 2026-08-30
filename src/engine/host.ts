import { fileURLToPath } from "node:url";
import { loadConfig, type ForgeConfig } from "../config.js";
import { ForgeDatabase } from "../database.js";
import { StructuredLogger } from "../logging.js";
import { runtimeIdentifiers } from "../runtime-identifiers.js";
import { json } from "../task-utils.js";
import { installIssueEngine } from "./index.js";
import { IssueWorkflowStateSchema } from "./issue-contracts.js";
import { IssueEngine, issueRunInputFromSnapshotRow } from "./runs.js";
import { reconcileActiveTurns } from "../active-turn-recovery.js";
import { reconcileWorktrees } from "../worktree-reconciliation.js";
import { reconcileGithubObservations } from "../github-observation-reconciliation.js";
import { reconcileTaskCreationIntents } from "../task-creation-recovery.js";
import { reconcileSuccessorIntents } from "../successor-recovery.js";
import { reconcileDonePullRequests } from "../done-pull-request-reconciliation.js";
import { CapacityManager } from "../capacity.js";

function recoverableSessionPredicate(roleSessionIds: readonly string[]): string {
  return roleSessionIds.length
    ? `session.id IN (${roleSessionIds.map(() => "?").join(", ")})`
    : "0";
}

export function reclaimOrphanedHerdrExecutions(database: ForgeDatabase, recoverableRoleSessionIds: ReadonlySet<string>, now = new Date().toISOString()): { agentExecutions: number; developerExecutions: number } {
  const sessionIds = [...recoverableRoleSessionIds];
  const recoverable = recoverableSessionPredicate(sessionIds);
  return database.authTransaction((db) => ({
    agentExecutions: db.prepare(`UPDATE forge_agent_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id AND session.is_current = 1 AND ${recoverable})`).run(now, ...sessionIds).changes,
    developerExecutions: db.prepare(`UPDATE forge_developer_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id AND session.is_current = 1 AND ${recoverable})`).run(now, ...sessionIds).changes,
  }));
}
export function recoverOrphanedHerdrExecutions(database: ForgeDatabase, recoverableRoleSessionIds: ReadonlySet<string>): { agentExecutions: number; developerExecutions: number } {
  const sessionIds = [...recoverableRoleSessionIds];
  const recoverable = recoverableSessionPredicate(sessionIds);
  return database.authTransaction((db) => ({
    agentExecutions: db.prepare(`UPDATE forge_agent_executions SET status = 'running', failure_code = NULL, finished_at = NULL WHERE status = 'failed' AND failure_code = 'worker-restart-orphan' AND EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id AND session.is_current = 1 AND ${recoverable} AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed'))`).run(...sessionIds).changes,
    developerExecutions: db.prepare(`UPDATE forge_developer_executions SET status = 'running', failure_code = NULL, finished_at = NULL WHERE status = 'failed' AND failure_code = 'worker-restart-orphan' AND EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id AND session.is_current = 1 AND ${recoverable} AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed'))`).run(...sessionIds).changes,
  }));
}
export function logReconciliation(logger: Pick<StructuredLogger, "debug" | "info">, name: string, durationMs: number, changes: number, counts: Record<string, number>): void {
  logger[changes === 0 ? "debug" : "info"](`Worker periodic reconciliation ${changes === 0 ? "idle" : "changed state"}: ${name}`, { durationMs, ...counts } as never);
}
export function createNonOverlappingRunner(operation: () => Promise<unknown> | unknown): () => Promise<void> {
  let active: Promise<void> | undefined;
  return () => active ??= Promise.resolve().then(operation).then(() => undefined, () => undefined).finally(() => { active = undefined; });
}

export async function loadIssueRuns(engine: IssueEngine): Promise<number> {
  const rows = engine.database.authQuery((db) => db.prepare(`SELECT s.task_id, s.state_json, t.brief_artifact_id, t.image_artifact_ids_json, t.role_agents_json, t.supplemental_review, t.request_hash, t.predecessor_task_id, t.auto_approve_plan, t.pull_request_mode, t.delivery_target, t.run_project_tests, t.visual_evidence FROM forge_workflow_snapshots s JOIN forge_tasks t ON t.id = s.task_id JOIN (SELECT task_id, max(revision) revision FROM forge_workflow_snapshots GROUP BY task_id) latest ON latest.task_id=s.task_id AND latest.revision=s.revision WHERE json_extract(s.state_json, '$.phase') NOT IN ('done','cancelled','failed')`).all() as Array<Record<string, unknown>>);
  for (const row of rows) {
    // A snapshot that no longer matches the schema must not stop every other issue from loading.
    const parsed = IssueWorkflowStateSchema.safeParse(json(String(row.state_json), undefined));
    if (!parsed.success) { new StructuredLogger().warn("Skipping issue snapshot that fails the state schema", {}, { taskId: String(row.task_id ?? ""), issues: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }); continue; }
    const state = parsed.data;
    if (engine.runs.has(state.workflowId)) continue;
    await engine.create(engine.database.authQuery((db) => issueRunInputFromSnapshotRow(db, row, state)));
  }
  return rows.length;
}
export function reconcileWorkflowStalls(engine: IssueEngine): { inspected: number; stalled: number } {
  let stalled = 0;
  for (const run of engine.runs.values()) {
    const status = run.error ? "stalled" : "current";
    if (run.error) stalled += 1;
    engine.database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET projection_status=?, projection_status_message=? WHERE workflow_id=?").run(status, run.error ? (run.error instanceof Error ? run.error.message : "Engine loop failed") : null, run.workflowId));
  }
  return { inspected: engine.runs.size, stalled };
}

export async function startEngineHost(config: ForgeConfig, database = new ForgeDatabase(config.databasePath)): Promise<IssueEngine> {
  // One process owns the in-flight ledger; rows left by a previous process are stale by definition.
  database.authTransaction((db) => db.prepare("DELETE FROM forge_engine_activities").run());
  const engine = new IssueEngine(config, database); installIssueEngine(config, engine); await loadIssueRuns(engine);
  const workerId = `${runtimeIdentifiers(config.installationId).workerPrefix}-${process.pid}`;
  const registration = { workerId, taskQueue: runtimeIdentifiers(config.installationId).taskQueue, buildId: runtimeIdentifiers(config.installationId).buildId };
  database.registerWorker(registration);
  new StructuredLogger().info("Forge worker RUNNING and polling");
  const schedule = (milliseconds: number, operation: () => Promise<unknown> | unknown): void => { const run = createNonOverlappingRunner(operation); void run(); const timer = setInterval(() => void run(), milliseconds); timer.unref(); };
  // The health page treats a worker whose heartbeat is older than its max age as unavailable.
  schedule(15_000, () => database.registerWorker(registration));
  schedule(60_000, () => reconcileTaskCreationIntents(database, config));
  schedule(60_000, () => reconcileActiveTurns(database, config));
  schedule(60_000, () => reconcileWorktrees(database, config));
  schedule(300_000, () => reconcileGithubObservations(database, config));
  schedule(60_000, () => reconcileWorkflowStalls(engine));
  schedule(300_000, () => reconcileDonePullRequests(database));
  schedule(300_000, () => reconcileSuccessorIntents(database, config));
  schedule(300_000, () => new CapacityManager(database, config).reconcileFromLedgers());
  return engine;
}
export async function runWorker(config: ForgeConfig = loadConfig()): Promise<void> {
  const database = new ForgeDatabase(config.databasePath); const engine = await startEngineHost(config, database);
  await new Promise<void>((resolve) => { const stop = () => { engine.dispose(); database.close(); resolve(); }; process.once("SIGTERM", stop); process.once("SIGINT", stop); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runWorker().catch((error) => { new StructuredLogger().error("Forge worker stopped", {}, { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
