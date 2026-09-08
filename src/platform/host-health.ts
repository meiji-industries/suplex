import { access, constants, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";
import { checkGithubAuthentication } from "../profiles/provider-readiness.js";
import { checkBackupHealth } from "./backup.js";
import { resolveOpenCodeExecutable } from "./executable-resolver.js";
import { createHerdrReadinessCheck } from "../integrations/herdr/readiness.js";

const minimumFreeBytes = 100 * 1024 * 1024;

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

export function createHostHealthDependencies(config: ForgeConfig, database: ForgeDatabase) {
  return {
    database: () => checkDatabase(database),
    artifactRoot: () => checkArtifactRoot(config.artifactRoot),
    opencode: async (): Promise<HealthCheck> => {
      try { await resolveOpenCodeExecutable(); return { id: "opencode", label: "OpenCode", status: "healthy", summary: "Executable found. Model access is not tested.", details: {} }; }
      catch { return { id: "opencode", label: "OpenCode", status: "unhealthy", summary: "OpenCode is not available on the Forge host", details: {} }; }
    },
    herdrReadiness: createHerdrReadinessCheck(),
    ghAuth: checkGithubAuthentication(process.env.FORGE_GH_COMMAND ?? "gh"),
    backup: () => checkBackupHealth(config),
  };
}
