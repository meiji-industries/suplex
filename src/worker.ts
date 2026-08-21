import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerStatus } from "@temporalio/worker";

import { loadConfig, temporalConnectionOptions, type ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { createActivities } from "./temporal/activities.js";
import { StructuredLogger } from "./logging.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { reconcileDeveloperExecutions } from "./developer-recovery.js";
import { activateLocalWorkerDeployment, reconcileBlockedDeveloperDeliveries, routeWorkflowToCurrentDeployment } from "./developer-reconciliation-recovery.js";
import { reconcileSuccessorIntents } from "./successor-recovery.js";
import { reconcileTaskCreationIntents } from "./task-creation-recovery.js";
import { activityPayloadInterceptors } from "./temporal/payload-boundary-interceptors.js";
import { buildProductionWorkflowBundle, temporalDataConverter, workflowBundleBuildId } from "./temporal/workflow-bundle.js";
import { reconcileAgentExecutions } from "./agent-recovery.js";
import { CapacityManager } from "./capacity.js";

export function workerHasLivePollers(status: Pick<WorkerStatus, "runState" | "workflowPollerState" | "activityPollerState">): boolean {
  return status.runState === "RUNNING"
    && status.workflowPollerState === "POLLING"
    && status.activityPollerState === "POLLING";
}

export function deploymentVersionOptions(installationId: string, buildId: string) {
  return { useWorkerVersioning: true as const, version: { deploymentName: runtimeIdentifiers(installationId).ownerLabel, buildId }, defaultVersioningBehavior: "AUTO_UPGRADE" as const };
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

const startupSweepTimeoutMs = 30_000;

/**
 * Recovery inspects local processes, SQLite, and Temporal. None of those
 * checks are allowed to keep a healthy worker from polling its task queue.
 */
function runStartupSweep<T>(logger: StructuredLogger, name: string, sweep: () => Promise<T>, timeoutMs = startupSweepTimeoutMs): Promise<T | undefined> {
  const startedAt = Date.now();
  logger.info(`Worker startup sweep started: ${name}`);
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
  });
  return Promise.race([Promise.resolve().then(sweep), deadline])
    .then((result) => {
      logger.info(`Worker startup sweep completed: ${name} (${Date.now() - startedAt}ms)`);
      return result;
    })
    .catch((error: unknown) => {
      logger.error(`Worker startup sweep did not complete: ${name} (${Date.now() - startedAt}ms)`, {}, { error: error instanceof Error ? error.message : "unknown error" });
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
  const identifiers = runtimeIdentifiers(config.installationId);
  const workerId = `${identifiers.workerPrefix}-${process.pid}`;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let workerRun: Promise<void> | undefined;
  let creationRecovery: Promise<void> | undefined;
  let deliveryRecovery: Promise<number | undefined> | undefined;
  let shutdown: (() => void) | undefined;
  try {
    logger.info("Worker startup: connecting to Temporal");
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
      if (!creationRecovery) {
        creationRecovery = runStartupSweep(logger, "task-creation-reconciliation", () => reconcileTaskCreationIntents(database, config))
          .finally(() => { creationRecovery = undefined; });
      }
      if (!deliveryRecovery) {
        deliveryRecovery = runStartupSweep(logger, "developer-delivery-reconciliation", () => reconcileBlockedDeveloperDeliveries(database, config, undefined, (workflowId) => routeWorkflowToCurrentDeployment(connection!, config, workflowId, workerId)))
          .finally(() => { deliveryRecovery = undefined; });
      }
    };
    refreshRegistration();
    void runStartupSweep(logger, "agent-execution-reconciliation", () => reconcileAgentExecutions(database));
    void runStartupSweep(logger, "developer-execution-reconciliation", () => reconcileDeveloperExecutions(database));
    void runStartupSweep(logger, "successor-intent-reconciliation", () => reconcileSuccessorIntents(database, config));
    void runStartupSweep(logger, "capacity-ledger-reconciliation", async () => new CapacityManager(database, config).reconcileFromLedgers());
    heartbeat = setInterval(refreshRegistration, 10_000);
    heartbeat.unref();

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
    await creationRecovery;
    await deliveryRecovery;
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
    await creationRecovery;
    await deliveryRecovery;
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
