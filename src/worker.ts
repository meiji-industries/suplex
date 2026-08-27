import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerStatus } from "@temporalio/worker";

import { loadConfig, temporalConnectionOptions, type ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { createActivities } from "./temporal/activities.js";
import { StructuredLogger } from "./logging.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { reconcileHerdrSessions } from "./herdr-recovery.js";
import { activateLocalWorkerDeployment } from "./worker-deployment.js";
import { reconcileSuccessorIntents } from "./successor-recovery.js";
import { reconcileTaskCreationIntents } from "./task-creation-recovery.js";
import { activityPayloadInterceptors } from "./temporal/payload-boundary-interceptors.js";
import { buildProductionWorkflowBundle, temporalDataConverter, workflowBundleBuildId } from "./temporal/workflow-bundle.js";
import { CapacityManager } from "./capacity.js";
import { reconcileDonePullRequests } from "./done-pull-request-reconciliation.js";
import { migrateLegacyHerdrSessions } from "./herdr-session-migration.js";

export function workerHasLivePollers(status: Pick<WorkerStatus, "runState" | "workflowPollerState" | "activityPollerState">): boolean {
  return status.runState === "RUNNING"
    && status.workflowPollerState === "POLLING"
    && status.activityPollerState === "POLLING";
}

export function deploymentVersionOptions(installationId: string, buildId: string) {
  return { useWorkerVersioning: true as const, version: { deploymentName: runtimeIdentifiers(installationId).ownerLabel, buildId }, defaultVersioningBehavior: "AUTO_UPGRADE" as const };
}

export function reclaimOrphanedHerdrExecutions(database: ForgeDatabase, now = new Date().toISOString()): { agentExecutions: number; developerExecutions: number } {
  return database.authTransaction((db) => ({
    agentExecutions: db.prepare(`UPDATE forge_agent_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = COALESCE(finished_at, ?)
      WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (
        SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id
        WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id
          AND session.is_current = 1 AND session.status IN ('ready', 'working', 'blocked')
      )`).run(now).changes,
    developerExecutions: db.prepare(`UPDATE forge_developer_executions SET status = 'failed', failure_code = 'worker-restart-orphan', finished_at = COALESCE(finished_at, ?)
      WHERE status IN ('starting', 'running', 'cancelling') AND NOT EXISTS (
        SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id
        WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id
          AND session.is_current = 1 AND session.status IN ('ready', 'working', 'blocked')
      )`).run(now).changes,
  }));
}

export function recoverOrphanedHerdrExecutions(database: ForgeDatabase): { agentExecutions: number; developerExecutions: number } {
  return database.authTransaction((db) => ({
    agentExecutions: db.prepare(`UPDATE forge_agent_executions SET status = 'running', failure_code = NULL, finished_at = NULL
      WHERE status = 'failed' AND failure_code = 'worker-restart-orphan' AND EXISTS (
        SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id
        WHERE turn.ledger = 'agent' AND turn.execution_id = forge_agent_executions.id AND turn.task_id = forge_agent_executions.task_id
          AND session.is_current = 1 AND session.status IN ('ready', 'working', 'blocked')
          AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed')
      )`).run().changes,
    developerExecutions: db.prepare(`UPDATE forge_developer_executions SET status = 'running', failure_code = NULL, finished_at = NULL
      WHERE status = 'failed' AND failure_code = 'worker-restart-orphan' AND EXISTS (
        SELECT 1 FROM forge_herdr_turns turn JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id
        WHERE turn.ledger = 'developer' AND turn.execution_id = forge_developer_executions.id AND turn.task_id = forge_developer_executions.task_id
          AND session.is_current = 1 AND session.status IN ('ready', 'working', 'blocked')
          AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed')
      )`).run().changes,
  }));
}

async function waitForWorkerPolling(worker: Worker, failure: { error?: unknown }, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure.error) {
      throw failure.error;
    }
    if (workerHasLivePollers(worker.getStatus())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Temporal worker did not start polling its workflow and activity task queues");
}

const reconciliationTimeoutMs = 30_000;
const taskCreationReconciliationIntervalMs = 60_000;
const workflowStallReconciliationIntervalMs = 60_000;
const donePullRequestSyncIntervalMs = 5 * 60_000;

export async function reconcileWorkflowStalls(database: ForgeDatabase, connection: NativeConnection, config: ForgeConfig): Promise<{ inspected: number; stalled: number }> {
  const tasks = database.authQuery((db) => db.prepare("SELECT task_id AS taskId, workflow_id AS workflowId FROM forge_issue_projections WHERE phase NOT IN ('done', 'cancelled') ORDER BY task_id").all() as Array<{ taskId: string; workflowId: string }>);
  let stalled = 0;
  for (const task of tasks) {
    try {
      const description = await connection.workflowService.describeWorkflowExecution({ namespace: config.temporalNamespace, execution: { workflowId: task.workflowId } });
      const data = description as unknown as { workflowExecutionInfo?: { status?: number }; pendingWorkflowTask?: { attempt?: number } };
      const failedTask = JSON.stringify(description).includes("WorkflowTaskFailed");
      const closed = data.workflowExecutionInfo?.status !== undefined && data.workflowExecutionInfo.status !== 1;
      const attempts = data.pendingWorkflowTask?.attempt ?? 0;
      if (!closed && attempts <= 3 && !failedTask) continue;
      const message = closed ? "Temporal workflow closed before the task completed" : failedTask ? "Temporal reported WorkflowTaskFailed" : `Workflow task failed ${attempts} times`;
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET projection_status = 'stalled', projection_status_message = ?, reconciled_at = ? WHERE task_id = ?").run(message, new Date().toISOString(), task.taskId));
      stalled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Temporal workflow could not be described";
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET projection_status = 'stalled', projection_status_message = ?, reconciled_at = ? WHERE task_id = ?").run(message, new Date().toISOString(), task.taskId));
      stalled += 1;
    }
  }
  return { inspected: tasks.length, stalled };
}

/**
 * Recovery inspects local processes, SQLite, and Temporal. None of those
 * checks are allowed to keep a healthy worker from polling its task queue.
 */
export function logReconciliation(logger: Pick<StructuredLogger, "debug" | "info">, name: string, durationMs: number, changes: number, counts: Record<string, number>): void {
  const context = { durationMs, changes, ...counts };
  if (changes === 0) {
    logger.debug(`Worker periodic reconciliation idle: ${name}`, context as never);
    return;
  }
  logger.info(`Worker periodic reconciliation changed state: ${name}`, context as never);
}

function runReconciliation<T>(logger: StructuredLogger, name: string, sweep: () => Promise<T>, countChanges: (result: T) => number, counts: (result: T) => Record<string, number>, timeoutMs = reconciliationTimeoutMs): Promise<T | undefined> {
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
  });
  return Promise.race([Promise.resolve().then(sweep), deadline])
    .then((result) => {
      logReconciliation(logger, name, Date.now() - startedAt, countChanges(result), counts(result));
      return result;
    })
    .catch((error: unknown) => {
      logger.error(`Worker periodic reconciliation did not complete: ${name} (${Date.now() - startedAt}ms)`, {}, { error: error instanceof Error ? error.message : "unknown error" });
      return undefined;
    })
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });
}

export async function runWorker(config: ForgeConfig = loadConfig()): Promise<void> {
  const logger = new StructuredLogger();
  logger.info("Worker startup: opening database");
  const database = new ForgeDatabase(config.databasePath);
  logger.info("Worker startup: database ready");
  const legacySessions = await migrateLegacyHerdrSessions(database, config.runtimeRoot);
  if (legacySessions.unresolved.length) {
    logger.warn("Worker startup: terminalizing unresolved legacy Codex sessions", { executionIds: legacySessions.unresolved } as never);
    const now = new Date().toISOString();
    const placeholders = legacySessions.unresolved.map(() => "?").join(", ");
    database.authTransaction((db) => {
      db.prepare(`UPDATE forge_agent_executions SET status = 'failed', failure_code = 'legacy-session-unresolved', finished_at = ? WHERE id IN (${placeholders}) AND status IN ('starting', 'running', 'cancelling')`).run(now, ...legacySessions.unresolved);
      db.prepare(`UPDATE forge_developer_executions SET status = 'failed', failure_code = 'legacy-session-unresolved', finished_at = ? WHERE id IN (${placeholders}) AND status IN ('starting', 'running', 'cancelling')`).run(now, ...legacySessions.unresolved);
    });
  }
  const reclaimed = { agentExecutions: 0, developerExecutions: 0 };
  logger.info("Worker startup: deferred orphaned execution reconciliation until Herdr sessions are inspected", reclaimed as never);
  const identifiers = runtimeIdentifiers(config.installationId);
  const workerId = `${identifiers.workerPrefix}-${process.pid}`;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let creationReconciliationHeartbeat: NodeJS.Timeout | undefined;
  let workflowStallReconciliationHeartbeat: NodeJS.Timeout | undefined;
  let donePullRequestSyncHeartbeat: NodeJS.Timeout | undefined;
  let workerRun: Promise<void> | undefined;
  let creationRecovery: Promise<void> | undefined;
  let workflowStallRecovery: Promise<void> | undefined;
  let shutdown: (() => void) | undefined;
  try {
    connection = await NativeConnection.connect(temporalConnectionOptions(config));
    logger.info("Worker startup: Temporal connection ready");
    logger.info("Worker startup: creating workflow bundle");
    const workflowBundle = await buildProductionWorkflowBundle();
    logger.info("Worker startup: workflow bundle ready");
    const buildId = workflowBundleBuildId(config.installationId, workflowBundle);
    logger.info("Worker startup: creating Temporal worker");
    worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      identity: workerId,
      workerDeploymentOptions: deploymentVersionOptions(config.installationId, buildId),
      workflowBundle,
      dataConverter: temporalDataConverter,
      interceptors: { activity: activityPayloadInterceptors },
      activities: createActivities(database, config),
      shutdownGraceTime: "10 seconds",
      shutdownForceTime: "20 seconds",
    });
    logger.info("Worker startup: Temporal worker created");
    const failure: { error?: unknown } = {};
    logger.info("Worker startup: starting Temporal worker run loop");
    workerRun = worker.run().catch((error: unknown) => {
      failure.error = error;
      throw error;
    });
    logger.info("Worker startup: waiting for task-queue pollers");
    await waitForWorkerPolling(worker, failure);
    logger.info(`Forge worker RUNNING and polling (${workerId})`);
    logger.info("Worker startup: activating local deployment");
    await activateLocalWorkerDeployment(connection, config, buildId, workerId);
    logger.info("Worker startup: local deployment activated");
    const refreshRegistration = (): void => {
      if (worker && workerHasLivePollers(worker.getStatus())) {
        database.registerWorker({ workerId, taskQueue: config.taskQueue, buildId });
      } else {
        database.unregisterWorker(workerId);
      }
    };
    const reconcileTaskCreation = (): void => {
      if (creationRecovery) return;
      creationRecovery = runReconciliation(
        logger,
        "task-creation-reconciliation",
        () => reconcileTaskCreationIntents(database, config),
        (result) => result.started + result.failed,
        (result) => ({ inspected: result.inspected, started: result.started, failed: result.failed }),
      ).then(() => undefined).finally(() => { creationRecovery = undefined; });
    };
    refreshRegistration();
    reconcileTaskCreation();
    void runReconciliation(logger, "herdr-session-reconciliation", async () => {
      const sessions = await reconcileHerdrSessions(database);
      const recovered = recoverOrphanedHerdrExecutions(database);
      const reclaimed = reclaimOrphanedHerdrExecutions(database);
      return { sessions, recovered, reclaimed };
    }, (result) => result.sessions.filter((outcome) => outcome.status === "failed").length + result.reclaimed.agentExecutions + result.reclaimed.developerExecutions, (result) => ({ inspected: result.sessions.length, recoveredAgentExecutions: result.recovered.agentExecutions, recoveredDeveloperExecutions: result.recovered.developerExecutions, reclaimedAgentExecutions: result.reclaimed.agentExecutions, reclaimedDeveloperExecutions: result.reclaimed.developerExecutions }));
    const reconcileWorkflowStall = (): void => {
      if (workflowStallRecovery || !connection) return;
      workflowStallRecovery = runReconciliation(
        logger,
        "workflow-stall-reconciliation",
        () => reconcileWorkflowStalls(database, connection!, config),
        (result) => result.stalled,
        (result) => ({ inspected: result.inspected, stalled: result.stalled }),
      ).then(() => undefined).finally(() => { workflowStallRecovery = undefined; });
    };
    const reconcileDonePullRequestSync = (): void => {
      void runReconciliation(logger, "done-pull-request-sync", () => reconcileDonePullRequests(database), (result) => result.changed.length, (result) => {
        for (const task of result.changed) logger.info("Done pull request synced with GitHub", task as never);
        return { inspected: result.inspected, changed: result.changed.length };
      });
    };
    void runReconciliation(logger, "successor-intent-reconciliation", () => reconcileSuccessorIntents(database, config), (result) => result.linked, (result) => ({ inspected: result.inspected, linked: result.linked }));
    void runReconciliation(logger, "capacity-ledger-reconciliation", async () => new CapacityManager(database, config).reconcileFromLedgers(), (result) => result, (result) => ({ reconciled: result }));
    heartbeat = setInterval(refreshRegistration, 10_000);
    heartbeat.unref();
    creationReconciliationHeartbeat = setInterval(reconcileTaskCreation, taskCreationReconciliationIntervalMs);
    creationReconciliationHeartbeat.unref();
    reconcileWorkflowStall();
    reconcileDonePullRequestSync();
    workflowStallReconciliationHeartbeat = setInterval(reconcileWorkflowStall, workflowStallReconciliationIntervalMs);
    workflowStallReconciliationHeartbeat.unref();
    donePullRequestSyncHeartbeat = setInterval(reconcileDonePullRequestSync, donePullRequestSyncIntervalMs);
    donePullRequestSyncHeartbeat.unref();

    let shuttingDown = false;
    shutdown = (): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      worker?.shutdown();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    await workerRun;

    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (creationReconciliationHeartbeat) {
      clearInterval(creationReconciliationHeartbeat);
    }
    if (workflowStallReconciliationHeartbeat) {
      clearInterval(workflowStallReconciliationHeartbeat);
    }
    if (donePullRequestSyncHeartbeat) clearInterval(donePullRequestSyncHeartbeat);
    await creationRecovery;
    await workflowStallRecovery;
    database.unregisterWorker(workerId);
    if (shutdown) {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
    await connection.close();
    database.close();
  } catch (error) {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (creationReconciliationHeartbeat) {
      clearInterval(creationReconciliationHeartbeat);
    }
    if (workflowStallReconciliationHeartbeat) {
      clearInterval(workflowStallReconciliationHeartbeat);
    }
    if (donePullRequestSyncHeartbeat) clearInterval(donePullRequestSyncHeartbeat);
    await creationRecovery;
    await workflowStallRecovery;
    // Cleanup must never mask the original startup error: drain the worker
    // before closing the connection, and swallow secondary failures.
    try { worker?.shutdown(); } catch { /* worker already stopped */ }
    await workerRun?.catch(() => undefined);
    database.unregisterWorker(workerId);
    if (shutdown) {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
    await connection?.close().catch(() => undefined);
    database.close();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runWorker().catch((error: unknown) => {
    new StructuredLogger().error("Forge worker stopped", {}, { error: error instanceof Error ? error.message : "unknown error" });
    process.exitCode = 1;
  });
}
