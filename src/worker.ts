import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";

import { loadConfig, type ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { createActivities } from "./temporal/activities.js";
import { StructuredLogger } from "./logging.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";

export async function runWorker(config: ForgeConfig = loadConfig()): Promise<void> {
  const database = new ForgeDatabase(config.databasePath);
  const identifiers = runtimeIdentifiers(config.installationId);
  const workerId = `${identifiers.workerPrefix}-${process.pid}`;
  const buildId = identifiers.buildId;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    connection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      identity: workerId,
      buildId,
      workflowsPath: fileURLToPath(new URL("./temporal/workflows.ts", import.meta.url)),
      activities: createActivities(database),
      shutdownGraceTime: "10 seconds",
      shutdownForceTime: "20 seconds",
    });
    database.registerWorker({ workerId, taskQueue: config.taskQueue, buildId });
    heartbeat = setInterval(() => {
      database.registerWorker({ workerId, taskQueue: config.taskQueue, buildId });
    }, 10_000);
    heartbeat.unref();
  } catch (error) {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    worker?.shutdown();
    await connection?.close();
    database.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    worker?.shutdown();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  try {
    await worker.run();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    database.unregisterWorker(workerId);
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    await connection.close();
    database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runWorker().catch((error: unknown) => {
    new StructuredLogger().error("Forge worker stopped", {}, { error: error instanceof Error ? error.message : "unknown error" });
    process.exitCode = 1;
  });
}
