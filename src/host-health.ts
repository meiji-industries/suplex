import { access, constants, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";
import { TemporalHealthProbe } from "./temporal/service.js";

const execFileAsync = promisify(execFile);
const minimumFreeBytes = 100 * 1024 * 1024;

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

export async function checkWorker(database: ForgeDatabase, taskQueue: string): Promise<HealthCheck> {
  const healthy = database.workerIsHealthy(taskQueue);
  return {
    id: "worker",
    label: "Worker and task queue",
    status: healthy ? "healthy" : "unhealthy",
    summary: healthy ? "A Forge worker has a recent registration" : "No recent Forge worker registration is available",
    details: { taskQueue },
  };
}

export function checkCommandAuthentication(id: "codex-auth" | "gh-auth", label: string, command: string, args: string[]): () => Promise<HealthCheck> {
  return async () => {
    try {
      await execFileAsync(command, args, { timeout: 3_000, maxBuffer: 1_024 });
      return { id, label, status: "healthy", summary: "Local authentication is available", details: { command } };
    } catch {
      return { id, label, status: "unhealthy", summary: "Local authentication is unavailable", details: { command } };
    }
  };
}

export function createHostHealthDependencies(config: ForgeConfig, database: ForgeDatabase) {
  const temporal = new TemporalHealthProbe(config);
  return {
    temporal: () => temporal.check(),
    database: () => checkDatabase(database),
    artifactRoot: () => checkArtifactRoot(config.artifactRoot),
    worker: () => checkWorker(database, config.taskQueue),
    codexAuth: checkCommandAuthentication("codex-auth", "Codex authentication", process.env.FORGE_CODEX_COMMAND ?? "codex", ["login", "status"]),
    ghAuth: checkCommandAuthentication("gh-auth", "GitHub CLI authentication", process.env.FORGE_GH_COMMAND ?? "gh", ["auth", "status"]),
  };
}
