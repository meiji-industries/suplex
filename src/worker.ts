import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerStatus } from "@temporalio/worker";

import { loadConfig, temporalConnectionOptions, type ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { createActivities } from "./temporal/activities.js";
import { StructuredLogger } from "./logging.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { reconcileDeveloperExecutions } from "./developer-recovery.js";
import { reconcileSuccessorIntents } from "./successor-recovery.js";
import { activityPayloadInterceptors } from "./temporal/payload-boundary-interceptors.js";
import { buildProductionWorkflowBundle, temporalDataConverter } from "./temporal/workflow-bundle.js";
import { reconcileAgentExecutions } from "./agent-recovery.js";
import { CapacityManager } from "./capacity.js";

export function workerHasLivePollers(status: Pick<WorkerStatus, "runState" | "workflowPollerState" | "activityPollerState">): boolean {
  return status.runState === "RUNNING"
    && status.workflowPollerState === "POLLING"
    && status.activityPollerState === "POLLING";
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
  const buildId = identifiers.buildId;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let shutdown: (() => void) | undefined;
  try {
    await reconcileAgentExecutions(database);
    await reconcileDeveloperExecutions(database);
    await reconcileSuccessorIntents(database, config);
    new CapacityManager(database, config).reconcileFromLedgers();
    connection = await NativeConnection.connect(temporalConnectionOptions(config));
    worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      identity: workerId,
      buildId,
      workflowBundle: await buildProductionWorkflowBundle(),
      dataConverter: temporalDataConverter,
      interceptors: { activity: activityPayloadInterceptors },
      activities: createActivities(database, config),
      shutdownGraceTime: "10 seconds",
      shutdownForceTime: "20 seconds",
    });
    const failure: { error?: unknown } = {};
    const workerRun = worker.run().catch((error: unknown) => {
      failure.error = error;
      throw error;
    });
    await waitForWorkerPolling(worker, failure);
    const refreshRegistration = (): void => {
      if (worker && workerHasLivePollers(worker.getStatus())) {
        database.registerWorker({ workerId, taskQueue: config.taskQueue, buildId });
      } else {
        database.unregisterWorker(workerId);
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
    worker?.shutdown();
    database.unregisterWorker(workerId);
    if (shutdown) {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
    await connection?.close();
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
