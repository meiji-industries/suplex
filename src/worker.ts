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

export async function runWorker(config: ForgeConfig = loadConfig()): Promise<void> {
  const database = new ForgeDatabase(config.databasePath);
  const identifiers = runtimeIdentifiers(config.installationId);
  const workerId = `${identifiers.workerPrefix}-${process.pid}`;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let workerRun: Promise<void> | undefined;
  let creationRecovery: Promise<void> | undefined;
  let deliveryRecovery: Promise<number> | undefined;
  let shutdown: (() => void) | undefined;
  try {
    await reconcileAgentExecutions(database);
    await reconcileDeveloperExecutions(database);
    await reconcileSuccessorIntents(database, config);
    await reconcileTaskCreationIntents(database, config);
    new CapacityManager(database, config).reconcileFromLedgers();
    connection = await NativeConnection.connect(temporalConnectionOptions(config));
    const workflowBundle = await buildProductionWorkflowBundle();
    const buildId = workflowBundleBuildId(config.installationId, workflowBundle);
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
    const failure: { error?: unknown } = {};
    workerRun = worker.run().catch((error: unknown) => {
      failure.error = error;
      throw error;
    });
    await waitForWorkerPolling(worker, failure);
    await activateLocalWorkerDeployment(connection, config, buildId, workerId);
    const refreshRegistration = (): void => {
      if (worker && workerHasLivePollers(worker.getStatus())) {
        database.registerWorker({ workerId, taskQueue: config.taskQueue, buildId });
      } else {
        database.unregisterWorker(workerId);
      }
      if (!creationRecovery) {
        creationRecovery = reconcileTaskCreationIntents(database, config)
          .catch((error: unknown) => new StructuredLogger().error("Task creation reconciliation failed", {}, { error: error instanceof Error ? error.message : "unknown error" }))
          .finally(() => { creationRecovery = undefined; });
      }
      if (!deliveryRecovery) {
        deliveryRecovery = reconcileBlockedDeveloperDeliveries(database, config, undefined, (workflowId) => routeWorkflowToCurrentDeployment(connection!, config, workflowId, workerId))
          .catch((error: unknown) => { new StructuredLogger().error("Developer delivery reconciliation failed", {}, { error: error instanceof Error ? error.message : "unknown error" }); return 0; })
          .finally(() => { deliveryRecovery = undefined; });
      }
    };
    refreshRegistration();
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
