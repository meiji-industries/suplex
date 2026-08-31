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
import { CliHerdrClient, snapshotHerdrRuntime, type HerdrClient } from "../herdr-client.js";
import { observeHerdrSessions, type HerdrSessionObservation } from "../herdr-recovery.js";

type ExecutionConvergenceCounts = { agentExecutions: number; developerExecutions: number };

const workerRestartOrphanCode = "worker-restart-orphan";
const reviewRestartOrphanCode = "process-failed";
const reviewRestartOrphanSummary = "The delivery review stopped because its linked agent process was not resumable after the Forge worker restarted.";
const terminalHerdrLifecycle = /(?:^|[\s_-])(?:done|complete|completed|cancelled|canceled|failed|failure|error|errored|exited|stopped|terminated)(?:$|[\s_-])/i;
const resumableTurnPredicate = "turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating')";

function recoverableSessionPredicate(roleSessionIds: readonly string[]): string {
  return roleSessionIds.length
    ? `session.id IN (${roleSessionIds.map(() => "?").join(", ")})`
    : "0";
}

export function reclaimOrphanedHerdrExecutions(database: ForgeDatabase, recoverableRoleSessionIds: ReadonlySet<string>, now = new Date().toISOString()): ExecutionConvergenceCounts {
  const sessionIds = [...recoverableRoleSessionIds];
  const recoverable = recoverableSessionPredicate(sessionIds);
  return database.authTransaction((db) => {
    const agentIds = (db.prepare(`UPDATE forge_agent_executions SET status = 'failed', failure_code = '${workerRestartOrphanCode}', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id AND session.is_current = 1 AND ${recoverable} AND ${resumableTurnPredicate}) RETURNING id`).all(now, ...sessionIds) as Array<{ id: string }>).map((row) => row.id);
    const developerIds = (db.prepare(`UPDATE forge_developer_executions SET status = 'failed', failure_code = '${workerRestartOrphanCode}', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id AND session.is_current = 1 AND ${recoverable} AND ${resumableTurnPredicate}) RETURNING id`).all(now, ...sessionIds) as Array<{ id: string }>).map((row) => row.id);
    if (agentIds.length) db.prepare(`UPDATE forge_delivery_review_attempts SET status = 'failed', failure_code = ?, failure_summary = ?, finished_at = COALESCE(finished_at, ?) WHERE status = 'running' AND lead_execution_id IN (${agentIds.map(() => "?").join(", ")})`).run(reviewRestartOrphanCode, reviewRestartOrphanSummary, now, ...agentIds);
    return { agentExecutions: agentIds.length, developerExecutions: developerIds.length };
  });
}
export function recoverOrphanedHerdrExecutions(database: ForgeDatabase, recoverableRoleSessionIds: ReadonlySet<string>): ExecutionConvergenceCounts {
  const sessionIds = [...recoverableRoleSessionIds];
  const recoverable = recoverableSessionPredicate(sessionIds);
  return database.authTransaction((db) => {
    const agentIds = (db.prepare(`UPDATE forge_agent_executions SET status = 'running', failure_code = NULL, failure_summary = NULL, finished_at = NULL WHERE status = 'failed' AND failure_code = '${workerRestartOrphanCode}' AND EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id AND session.is_current = 1 AND ${recoverable} AND ${resumableTurnPredicate}) RETURNING id`).all(...sessionIds) as Array<{ id: string }>).map((row) => row.id);
    const developerIds = (db.prepare(`UPDATE forge_developer_executions SET status = 'running', failure_code = NULL, failure_summary = NULL, finished_at = NULL WHERE status = 'failed' AND failure_code = '${workerRestartOrphanCode}' AND EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id AND session.is_current = 1 AND ${recoverable} AND ${resumableTurnPredicate}) RETURNING id`).all(...sessionIds) as Array<{ id: string }>).map((row) => row.id);
    if (agentIds.length) db.prepare(`UPDATE forge_delivery_review_attempts SET status = 'running', failure_code = NULL, failure_summary = NULL, finished_at = NULL WHERE status = 'failed' AND failure_code IN (?, ?) AND lead_execution_id IN (${agentIds.map(() => "?").join(", ")})`).run(reviewRestartOrphanCode, workerRestartOrphanCode, ...agentIds);
    return { agentExecutions: agentIds.length, developerExecutions: developerIds.length };
  });
}

function resumableHerdrObservation(observation: HerdrSessionObservation): boolean {
  return observation.classification === "active"
    && (observation.lifecycleStatus === null || !terminalHerdrLifecycle.test(observation.lifecycleStatus));
}

export async function convergeOrphanedHerdrExecutions(database: ForgeDatabase, herdr: HerdrClient = new CliHerdrClient(), logger: Pick<StructuredLogger, "info" | "warn"> = new StructuredLogger()): Promise<{ reclaimed: ExecutionConvergenceCounts; recovered: ExecutionConvergenceCounts } | null> {
  let observations: HerdrSessionObservation[];
  try {
    const snapshot = await snapshotHerdrRuntime(typeof herdr.listAgents === "function" ? herdr : {
      runtimeSnapshot: () => herdr.runtimeSnapshot(),
      listAgents: async () => { throw new Error("Herdr client has no compatible snapshot fallback"); },
    });
    observations = await observeHerdrSessions(database, herdr, undefined, snapshot);
  } catch (error) {
    logger.warn("Skipping startup execution convergence because Herdr could not be observed", {}, { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const recoverableRoleSessionIds = new Set(observations.filter(resumableHerdrObservation).map((observation) => observation.sessionId));
  const reclaimed = reclaimOrphanedHerdrExecutions(database, recoverableRoleSessionIds);
  const recovered = recoverOrphanedHerdrExecutions(database, recoverableRoleSessionIds);
  logger.info("Startup execution state converged from Herdr", { observedSessions: observations.length, recoverableSessions: recoverableRoleSessionIds.size, reclaimed, recovered } as never);
  return { reclaimed, recovered };
}
export function logReconciliation(logger: Pick<StructuredLogger, "debug" | "info">, name: string, durationMs: number, changes: number, counts: Record<string, number>): void {
  logger[changes === 0 ? "debug" : "info"](`Worker periodic reconciliation ${changes === 0 ? "idle" : "changed state"}: ${name}`, { durationMs, ...counts } as never);
}
export function logScheduledReconciliationFailure(logger: Pick<StructuredLogger, "error">, error: unknown): void {
  logger.error("Worker periodic reconciliation failed", {}, { error: error instanceof Error ? error.message : String(error) });
}
export function createNonOverlappingRunner(operation: () => Promise<unknown> | unknown, onError: (error: unknown) => void = (error) => logScheduledReconciliationFailure(new StructuredLogger(), error)): () => Promise<void> {
  let active: Promise<void> | undefined;
  return () => active ??= Promise.resolve().then(operation).then(() => undefined, onError).finally(() => { active = undefined; });
}

export async function loadIssueRuns(engine: IssueEngine): Promise<number> {
  const rows = engine.database.authQuery((db) => db.prepare(`SELECT s.task_id, s.state_json, t.brief_artifact_id, t.image_artifact_ids_json, t.role_agents_json, t.supplemental_review, t.request_hash, t.predecessor_task_id, t.auto_approve_plan, t.pull_request_mode, t.delivery_target, t.run_project_tests, t.visual_evidence FROM forge_workflow_snapshots s JOIN forge_tasks t ON t.id = s.task_id JOIN (SELECT task_id, max(revision) revision FROM forge_workflow_snapshots GROUP BY task_id) latest ON latest.task_id=s.task_id AND latest.revision=s.revision WHERE t.archived_at IS NULL AND json_extract(s.state_json, '$.phase') NOT IN ('done','cancelled','failed')`).all() as Array<Record<string, unknown>>);
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

export interface EngineHostOptions {
  herdr?: HerdrClient;
  logger?: Pick<StructuredLogger, "info" | "warn">;
  loadRuns?: (engine: IssueEngine) => Promise<number>;
  schedule?: (milliseconds: number, operation: () => Promise<unknown> | unknown) => void;
}

export async function startEngineHost(config: ForgeConfig, database = new ForgeDatabase(config.databasePath), options: EngineHostOptions = {}): Promise<IssueEngine> {
  // Engine activity rows are process-local; Herdr-backed execution rows converge from live observation below.
  database.authTransaction((db) => db.prepare("DELETE FROM forge_engine_activities").run());
  const logger = options.logger ?? new StructuredLogger();
  const errorLogger = logger instanceof StructuredLogger ? logger : new StructuredLogger();
  await convergeOrphanedHerdrExecutions(database, options.herdr ?? new CliHerdrClient(), logger);
  const engine = new IssueEngine(config, database); installIssueEngine(config, engine); await (options.loadRuns ?? loadIssueRuns)(engine);
  const workerId = `${runtimeIdentifiers(config.installationId).workerPrefix}-${process.pid}`;
  const registration = { workerId, taskQueue: runtimeIdentifiers(config.installationId).taskQueue, buildId: runtimeIdentifiers(config.installationId).buildId };
  database.registerWorker(registration);
  logger.info("Forge worker RUNNING and polling");
  const schedule = options.schedule ?? ((milliseconds: number, operation: () => Promise<unknown> | unknown): void => { const run = createNonOverlappingRunner(operation, (error) => logScheduledReconciliationFailure(errorLogger, error)); void run(); const timer = setInterval(() => void run(), milliseconds); timer.unref(); });
  // The health page treats a worker whose heartbeat is older than its max age as unavailable.
  schedule(15_000, () => database.registerWorker(registration));
  schedule(60_000, () => reconcileTaskCreationIntents(database, config));
  schedule(60_000, () => reconcileActiveTurns(database, config, { logger: errorLogger }));
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
