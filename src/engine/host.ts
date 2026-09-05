import { fileURLToPath } from "node:url";
import { loadConfig, type ForgeConfig } from "../config.js";
import { ForgeDatabase } from "../database.js";
import { StructuredLogger } from "../logging.js";
import { runtimeIdentifiers } from "../runtime-identifiers.js";
import { installIssueEngine } from "./index.js";
import { createRunFromLatestSnapshot, deleteEngineActivities, IssueEngine } from "./runs.js";
import { reconcile } from "../reconcile.js";
import { CliHerdrClient, snapshotHerdrRuntime, type HerdrClient } from "../herdr-client.js";
import { observeHerdrSessions, recoverTaskControls, type HerdrSessionObservation } from "../herdr-recovery.js";
import { ISSUE_PHASES } from "../issue-phases.js";
import { ProjectionRebuildService } from "../projection-rebuild.js";

type ExecutionConvergenceCounts = { agentExecutions: number; developerExecutions: number };

const workerRestartOrphanCode = "worker-restart-orphan";
const reviewRestartOrphanCode = "process-failed";
const reviewRestartOrphanSummary = "The delivery review stopped because its linked agent process was not resumable after the Forge worker restarted.";
const terminalHerdrLifecycle = /(?:^|[\s_-])(?:done|complete|completed|cancelled|canceled|failed|failure|error|errored|exited|stopped|terminated)(?:$|[\s_-])/i;
const latestRoleSessionTurnPredicate = "turn.turn_id = (SELECT latest_turn.turn_id FROM forge_herdr_turns latest_turn WHERE latest_turn.role_session_id = turn.role_session_id ORDER BY latest_turn.created_at DESC, latest_turn.correction_index DESC, latest_turn.turn_id DESC LIMIT 1)";

function recoverableSessionPredicate(roleSessionIds: readonly string[]): string {
  return roleSessionIds.length
    ? `session.id IN (${roleSessionIds.map(() => "?").join(", ")})`
    : "0";
}

export function failOrphanedExecutions(database: ForgeDatabase, recoverableRoleSessionIds: ReadonlySet<string>, now = new Date().toISOString()): ExecutionConvergenceCounts {
  const sessionIds = [...recoverableRoleSessionIds];
  const recoverable = recoverableSessionPredicate(sessionIds);
  return database.authTransaction((db) => {
    const agentIds = (db.prepare(`UPDATE forge_agent_executions SET status = 'failed', failure_code = '${workerRestartOrphanCode}', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id AND session.is_current = 1 AND ${recoverable} AND ${latestRoleSessionTurnPredicate}) RETURNING id`).all(now, ...sessionIds) as Array<{ id: string }>).map((row) => row.id);
    const developerIds = (db.prepare(`UPDATE forge_developer_executions SET status = 'failed', failure_code = '${workerRestartOrphanCode}', finished_at = COALESCE(finished_at, ?) WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id AND session.is_current = 1 AND ${recoverable} AND ${latestRoleSessionTurnPredicate}) RETURNING id`).all(now, ...sessionIds) as Array<{ id: string }>).map((row) => row.id);
    if (agentIds.length) db.prepare(`UPDATE forge_delivery_review_attempts SET status = 'failed', failure_code = ?, failure_summary = ?, finished_at = COALESCE(finished_at, ?) WHERE status = 'running' AND lead_execution_id IN (${agentIds.map(() => "?").join(", ")})`).run(reviewRestartOrphanCode, reviewRestartOrphanSummary, now, ...agentIds);
    return { agentExecutions: agentIds.length, developerExecutions: developerIds.length };
  });
}

function resumableHerdrObservation(observation: HerdrSessionObservation): boolean {
  return observation.classification === "active"
    && (observation.lifecycleStatus === null || !terminalHerdrLifecycle.test(observation.lifecycleStatus));
}

export async function failOrphanedExecutionsFromHerdr(database: ForgeDatabase, herdr: HerdrClient = new CliHerdrClient(), logger: Pick<StructuredLogger, "info" | "warn"> = new StructuredLogger()): Promise<ExecutionConvergenceCounts | null> {
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
  const failed = failOrphanedExecutions(database, recoverableRoleSessionIds);
  logger.info("Startup execution state updated from Herdr", { observedSessions: observations.length, recoverableSessions: recoverableRoleSessionIds.size, failed } as never);
  return failed;
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
  const rows = engine.database.authQuery((db) => db.prepare(`SELECT s.workflow_id FROM forge_workflow_snapshots s JOIN forge_tasks t ON t.id = s.task_id JOIN (SELECT task_id, max(revision) revision FROM forge_workflow_snapshots GROUP BY task_id) latest ON latest.task_id=s.task_id AND latest.revision=s.revision WHERE t.archived_at IS NULL AND json_extract(s.state_json, '$.phase') NOT IN ('done','cancelled')`).all() as Array<{ workflow_id: string }>);
  for (const row of rows) {
    if (engine.runs.has(row.workflow_id)) continue;
    try {
      await createRunFromLatestSnapshot(engine, row.workflow_id);
    } catch (error) {
      new StructuredLogger().warn("Skipping issue snapshot that fails the state schema", {}, { workflowId: row.workflow_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return rows.length;
}

export async function rebuildDriftedIssueProjections(database: ForgeDatabase, config: ForgeConfig): Promise<number> {
  const phases = ISSUE_PHASES.map(() => "?").join(", ");
  const taskIds = database.authQuery((db) => db.prepare(`SELECT task_id FROM forge_issue_projections WHERE step IS NULL OR phase NOT IN (${phases})`).all(...ISSUE_PHASES) as Array<{ task_id: string }>);
  const rebuild = new ProjectionRebuildService(database, config);
  let rebuilt = 0;
  for (const { task_id: taskId } of taskIds) rebuilt += (await rebuild.rebuild({ taskId })).rebuilt;
  return rebuilt;
}

export interface EngineHostOptions {
  herdr?: HerdrClient;
  logger?: Pick<StructuredLogger, "info" | "warn">;
  loadRuns?: (engine: IssueEngine) => Promise<number>;
  schedule?: (milliseconds: number, operation: () => Promise<unknown> | unknown) => void;
}

export async function startEngineHost(config: ForgeConfig, database = new ForgeDatabase(config.databasePath), options: EngineHostOptions = {}): Promise<IssueEngine> {
  const logger = options.logger ?? new StructuredLogger();
  const orphanedActivityCount = deleteEngineActivities(database);
  if (orphanedActivityCount) logger.info("Removed orphaned engine activities from the stopped worker", { orphanedActivityCount } as never);
  const errorLogger = logger instanceof StructuredLogger ? logger : new StructuredLogger();
  const rebuiltProjections = await rebuildDriftedIssueProjections(database, config);
  logger.info(`Rebuilt ${rebuiltProjections} drifted issue projections`);
  await failOrphanedExecutionsFromHerdr(database, options.herdr ?? new CliHerdrClient(), logger);
  await recoverTaskControls(database, options.herdr ?? new CliHerdrClient()).catch((error: unknown) => logScheduledReconciliationFailure(errorLogger, error));
  const engine = new IssueEngine(config, database); installIssueEngine(config, engine); await (options.loadRuns ?? loadIssueRuns)(engine);
  const workerId = `${runtimeIdentifiers(config.installationId).workerPrefix}-${process.pid}`;
  const registration = { workerId, taskQueue: runtimeIdentifiers(config.installationId).taskQueue, buildId: runtimeIdentifiers(config.installationId).buildId };
  database.registerWorker(registration);
  logger.info("Forge worker RUNNING and polling");
  const schedule = options.schedule ?? ((milliseconds: number, operation: () => Promise<unknown> | unknown): void => { const run = createNonOverlappingRunner(operation, (error) => logScheduledReconciliationFailure(errorLogger, error)); void run(); const timer = setInterval(() => void run(), milliseconds); timer.unref(); });
  // The health page treats a worker whose heartbeat is older than its max age as unavailable.
  schedule(15_000, () => database.registerWorker(registration));
  schedule(15_000, () => recoverTaskControls(database, options.herdr ?? new CliHerdrClient()));
  schedule(60_000, () => reconcile(database, config, engine, { herdr: options.herdr, logger: errorLogger }));
  return engine;
}
export async function runWorker(config: ForgeConfig = loadConfig()): Promise<void> {
  const database = new ForgeDatabase(config.databasePath); const engine = await startEngineHost(config, database);
  await new Promise<void>((resolve) => { const stop = () => { engine.dispose(); database.close(); resolve(); }; process.once("SIGTERM", stop); process.once("SIGINT", stop); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runWorker().catch((error) => { new StructuredLogger().error("Forge worker stopped", {}, { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
