import { access, constants, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";
import { resolveAgentProvider } from "./agent-providers/index.js";
import { HerdrOpenRouterProvider } from "./agent-providers/herdr-openrouter.js";
import { checkGithubAuthentication } from "./provider-readiness.js";
import { checkBackupHealth } from "./backup.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { EngineHealthProbe } from "./engine/service.js";
import { CliHerdrClient } from "./herdr-client.js";

async function checkHerdrReadiness(): Promise<HealthCheck> {
  try {
    await new CliHerdrClient().listWorkspaces();
    return { id: "herdr-readiness", label: "Herdr readiness", status: "healthy", summary: "Herdr API is reachable", details: {} };
  } catch {
    return { id: "herdr-readiness", label: "Herdr readiness", status: "unhealthy", summary: "Herdr API is unavailable", details: {} };
  }
}

const minimumFreeBytes = 100 * 1024 * 1024;
const workerHeartbeatMaxAgeMs = 30_000;

export async function checkDatabase(database: ForgeDatabase): Promise<HealthCheck> {
  try {
    const health = database.health();
    const ahead = health.schemaState === "ahead" && health.walMode && health.readable && health.writable;
    const healthy = health.schemaState === "current" && health.walMode && health.readable && health.writable;
    return {
      id: "database",
      label: "SQLite database",
      status: healthy ? "healthy" : ahead ? "warning" : "unhealthy",
      summary: healthy
        ? "Schema is current and WAL is enabled"
        : ahead
          ? `Database has ${health.appliedMigrations - health.expectedMigrations} migration${health.appliedMigrations - health.expectedMigrations === 1 ? "" : "s"} this build does not know about — pull/restart`
          : health.schemaState === "current" && !health.walMode
          ? "Schema is current but WAL is disabled"
          : `Schema state is ${health.schemaState}`,
      details: {
        schemaState: health.schemaState,
        expectedMigrations: health.expectedMigrations,
        appliedMigrations: health.appliedMigrations,
        walMode: health.walMode,
      },
    };
  } catch {
    return {
      id: "database",
      label: "SQLite database",
      status: "unhealthy",
      summary: "Database could not be read or written",
      details: { schemaState: "unavailable" },
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
      details: { writable: true, readable: true, freeBytes },
    };
  } catch {
    return {
      id: "artifact-root",
      label: "Artifact root",
      status: "unhealthy",
      summary: "Artifact storage is not writable or cannot be inspected",
      details: { writable: false, readable: false },
    };
  }
}

export async function checkWorker(database: ForgeDatabase, taskQueue: string, installationId: string, expectedBuildId = runtimeIdentifiers(installationId).buildId): Promise<HealthCheck> {
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
  const buildMatches = worker.buildId === expectedBuildId;
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
  const engine = new EngineHealthProbe(config);
  const agent = resolveAgentProvider().readinessProbe();
  const claude = resolveAgentProvider("claude").readinessProbe();
  const openrouter = new HerdrOpenRouterProvider(database).readinessProbe();
  return {
    engine: () => engine.check(),
    database: () => checkDatabase(database),
    artifactRoot: () => checkArtifactRoot(config.artifactRoot),
    worker: async () => checkWorker(database, runtimeIdentifiers(config.installationId).taskQueue, config.installationId),
    codexAuth: () => agent.check(),
    claudeAuth: () => claude.check(),
    openrouterAuth: () => openrouter.check(),
    herdrReadiness: () => checkHerdrReadiness(),
    ghAuth: checkGithubAuthentication(process.env.FORGE_GH_COMMAND ?? "gh"),
    backup: () => checkBackupHealth(config),
  };
}
