import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createTestConfig } from "../src/config.js";
import { createForgeServer, type ForgeServer } from "../src/server.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/temporal/activities.js";
import { ensureTemporalFoundation, queryProbeWorkflow, startProbeWorkflow } from "../src/temporal/service.js";

const execFileAsync = promisify(execFile);
async function containerId(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("docker", ["inspect", "--format", "{{.Id}}", name]);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function publishedTemporalPort(name: string): Promise<number> {
  const result = await execFileAsync("docker", ["port", name, "7233/tcp"]);
  const match = /:(\d+)\s*$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`Docker did not publish a host port for ${name}`);
  }
  return Number(match[1]);
}

test("starts, persists, restarts, and queries a probe Workflow without touching the live Forge container", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-temporal-test-"));
  const containerName = `temporal-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const liveForgeContainerId = await containerId("forge-temporal");
  let config = createTestConfig(root, { taskQueue: `tasks-test-${process.pid}-${randomUUID().slice(0, 8)}` });
  let worker: Worker | undefined;
  let workerConnection: NativeConnection | undefined;
  let database: ForgeDatabase | undefined;
  let api: ForgeServer | undefined;
  let workflowId = "";

  try {
    await execFileAsync("docker", [
      "run", "--detach", "--name", containerName,
      "--publish", "127.0.0.1::7233",
      "temporalio/temporal:latest", "server", "start-dev", "--ip", "0.0.0.0", "--namespace", config.temporalNamespace,
    ]);
    config = createTestConfig(root, {
      taskQueue: config.taskQueue,
      temporalAddress: `127.0.0.1:${await publishedTemporalPort(containerName)}`,
    });
    let temporalConnection: Connection | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.ok(temporalConnection);
    await ensureTemporalFoundation(temporalConnection, config);
    temporalConnection.close();

    database = new ForgeDatabase(config.databasePath);
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
      activities: createActivities(database),
    });
    const workerRun = worker.run();
    api = await createForgeServer(config);
    assert.equal((await api.app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);

    const started = await startProbeWorkflow(config, { probeId: "probe-restart", companyId: "company-1" });
    workflowId = started.workflowId;
    let state = await queryProbeWorkflow(config, workflowId, started.runId);
    for (let attempt = 0; attempt < 20 && state.status !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await queryProbeWorkflow(config, workflowId, started.runId);
    }
    assert.equal(state.status, "running");
    assert.deepEqual(database.getProbe("probe-restart"), {
      workflowId,
      probeId: "probe-restart",
      companyId: "company-1",
      status: "running",
    });

    worker.shutdown();
    await workerRun;
    worker = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;

    const reopenedDatabase = new ForgeDatabase(config.databasePath);
    database = reopenedDatabase;
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
      activities: createActivities(reopenedDatabase),
    });
    const restartedWorkerRun = worker.run();
    api = await createForgeServer(config);
    assert.equal((await api.app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
    const afterRestart = await queryProbeWorkflow(config, workflowId, started.runId);
    assert.equal(afterRestart.status, "running");
    assert.equal(reopenedDatabase.getProbe("probe-restart")?.workflowId, workflowId);
    worker.shutdown();
    await restartedWorkerRun;
    worker = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;
  } finally {
    worker?.shutdown();
    await workerConnection?.close();
    database?.close();
    if (api) {
      await api.app.close().catch(() => undefined);
      api.database.close();
    }
    await execFileAsync("docker", ["rm", "--force", containerName]).catch(() => undefined);
    assert.equal(await containerId("forge-temporal"), liveForgeContainerId);
    await rm(root, { recursive: true, force: true });
  }
});
