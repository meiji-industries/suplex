import { access, constants, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";
import { CodexReadinessProbe, checkGithubAuthentication } from "./provider-readiness.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { TemporalHealthProbe } from "./temporal/service.js";

const minimumFreeBytes = 100 * 1024 * 1024;
const workerHeartbeatMaxAgeMs = 30_000;

export async function checkDatabase(database: ForgeDatabase): Promise<HealthCheck> {
  try {
    const health = database.health();
    const healthy = health.migrationVersion >= 1 && health.walMode && health.readable && health.writable;
    return {
      id: "database",
      label: "SQLite database",
      status: healthy ? "healthy" : "unhealthy",
      summary: healthy ? "Migrations are current and WAL is enabled" : "Database migration or WAL state is not ready",
      details: { migrationVersion: health.migrationVersion, walMode: health.walMode },
    };
  } catch {
    return {
      id: "database",
      label: "SQLite database",
      status: "unhealthy",
      summary: "Database could not be read or written",
      details: {},
    };
  }
}

export async function checkArtifactRoot(root: string): Promise<HealthCheck> {
  const probeFilename = join(root, `.forge-health-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.R_OK | constants.W_OK);
    await writeFile(probeFilename, "ok", { encoding: "utf8", flag: "wx" });
    await unlink(probeFilename);
    const filesystem = await statfs(root);
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const healthy = freeBytes >= minimumFreeBytes;
    return {
      id: "artifact-root",
      label: "Artifact root",
      status: healthy ? "healthy" : "unhealthy",
      summary: healthy ? "Artifact storage is writable with sufficient space" : "Artifact storage is low on space",
      details: { root, freeBytes },
    };
  } catch {
    return {
      id: "artifact-root",
      label: "Artifact root",
      status: "unhealthy",
      summary: "Artifact storage is not writable or cannot be inspected",
      details: { root },
    };
  }
}

export async function checkWorker(database: ForgeDatabase, taskQueue: string, installationId: string): Promise<HealthCheck> {
  const worker = database.workerHealth(taskQueue);
  const identifiers = runtimeIdentifiers(installationId);
  if (!worker) {
    return {
      id: "worker",
      label: "Worker and task queue",
      status: "unhealthy",
      summary: "No worker registration is available",
      details: { taskQueue, workerId: "missing", buildId: identifiers.buildId, heartbeatAgeMs: -1 },
    };
  }
  const expectedWorkerPrefix = `${identifiers.workerPrefix}-`;
  const identityMatches = worker.workerId.startsWith(expectedWorkerPrefix);
  const buildMatches = worker.buildId === identifiers.buildId;
  const heartbeatIsRecent = worker.heartbeatAgeMs >= 0 && worker.heartbeatAgeMs <= workerHeartbeatMaxAgeMs;
  const healthy = identityMatches && buildMatches && heartbeatIsRecent;
  const summary = healthy
    ? "Worker identity, build, task queue, and heartbeat are current"
    : worker.heartbeatAgeMs > workerHeartbeatMaxAgeMs
      ? "Worker heartbeat is stale"
      : "Worker identity or build does not match this installation";
  return {
    id: "worker",
    label: "Worker and task queue",
    status: healthy ? "healthy" : "unhealthy",
    summary,
    details: {
      workerId: worker.workerId,
      taskQueue: worker.taskQueue,
      buildId: worker.buildId,
      heartbeatAt: worker.heartbeatAt,
      heartbeatAgeMs: worker.heartbeatAgeMs,
    },
  };
}

export function createHostHealthDependencies(config: ForgeConfig, database: ForgeDatabase) {
  const temporal = new TemporalHealthProbe(config);
  const codex = new CodexReadinessProbe(process.env.FORGE_CODEX_COMMAND ?? "codex");
  return {
    temporal: () => temporal.check(),
    database: () => checkDatabase(database),
    artifactRoot: () => checkArtifactRoot(config.artifactRoot),
    worker: () => checkWorker(database, config.taskQueue, config.installationId),
    codexAuth: () => codex.check(),
    ghAuth: checkGithubAuthentication(process.env.FORGE_GH_COMMAND ?? "gh"),
  };
}
