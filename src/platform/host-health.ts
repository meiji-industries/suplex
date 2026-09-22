import { access, constants, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import { isTailscaleAddress, type SuplexConfig } from "./config.js";
import type { SuplexDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";
import { readEnvironmentSettings } from "./environment-settings.js";
import { checkGithubAuthentication, commandFailure, createProviderReadiness, runCommand, type CommandRunner } from "../profiles/provider-readiness.js";
import { checkBackupHealth } from "./backup.js";
import { parseTailscaleHostname } from "./tailscale.js";
import { createHerdrReadinessCheck } from "../integrations/herdr/readiness.js";
import type { ProviderHarnessKind } from "./health-contract.js";
import { HARNESS_KINDS } from "../runtimes/task-harness-registry.js";

async function onPath(binary: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      await access(join(directory, binary), constants.X_OK);
      return true;
    } catch { /* Keep looking. */ }
  }
  return false;
}

export interface GitCheckOptions {
  platform?: NodeJS.Platform;
  brewOnPath?: () => Promise<boolean>;
}

export function checkGit(command: string, runner: CommandRunner = runCommand, options: GitCheckOptions = {}): () => Promise<HealthCheck> {
  return async () => {
    let failure = "version-format";
    try {
      const result = await runner(command, ["--version"], { timeout: 3_000, maxBuffer: 4 * 1024 });
      const version = /git version (\S+)/.exec(result.stdout)?.[1];
      if (version) return { id: "git", label: "Git", status: "healthy", summary: `git version ${version}`, details: { version } };
    } catch (error) {
      failure = commandFailure(error, "version-failed", "version-timeout");
    }
    if (failure !== "command-missing") {
      // A failed or timed-out probe is not evidence that Git is absent.
      return { id: "git", label: "Git", status: "unhealthy", summary: "Git did not report a version", details: { failure } };
    }
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") {
      return { id: "git", label: "Git", status: "unhealthy", summary: "Git is not installed", remedy: "https://git-scm.com/downloads", remedyKind: "link", details: { failure } };
    }
    const brewAvailable = await (options.brewOnPath ?? (() => onPath("brew")))();
    return { id: "git", label: "Git", status: "unhealthy", summary: "Git is not installed", remedy: "xcode-select --install", details: { failure, ...(brewAvailable ? { alternative: "brew install git" } : {}) } };
  };
}

export function checkPnpm(command: string, runner: CommandRunner = runCommand): () => Promise<HealthCheck> {
  return async () => {
    let failure = "version-format";
    try {
      const result = await runner(command, ["--version"], { timeout: 3_000, maxBuffer: 4 * 1024 });
      const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(result.stdout.trim())?.[0];
      if (version) return { id: "pnpm", label: "pnpm", status: "healthy", summary: `pnpm ${version}`, details: { version } };
    } catch (error) {
      failure = commandFailure(error, "version-failed", "version-timeout");
    }
    return { id: "pnpm", label: "pnpm", status: "warning", summary: "pnpm is not installed. Self-update needs pnpm.", remedy: "corepack enable", details: { failure } };
  };
}

export function checkTailscale(command: string, runner: CommandRunner = runCommand): () => Promise<HealthCheck> {
  return async () => {
    let failure = "status-format";
    try {
      const result = await runner(command, ["status", "--json"], { timeout: 5_000, maxBuffer: 256 * 1024 });
      try {
        const hostname = parseTailscaleHostname(result.stdout);
        return { id: "tailscale", label: "Tailscale", status: "healthy", summary: "Tailscale is available", details: { hostname } };
      } catch { /* Invalid status is reported without the raw host or account data. */ }
    } catch (error) {
      failure = commandFailure(error, "status-failed", "status-timeout");
    }
    return { id: "tailscale", label: "Tailscale", status: "warning", summary: failure === "command-missing" ? "Tailscale CLI is not installed" : "Tailscale is not running", remedy: failure === "command-missing" ? "brew install --cask tailscale" : "Open the Tailscale app and sign in", details: { failure } };
  };
}

const minimumFreeBytes = 100 * 1024 * 1024;

export async function checkDatabase(database: SuplexDatabase): Promise<HealthCheck> {
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
  const probeFilename = join(root, `.suplex-health-${process.pid}-${randomUUID()}`);
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

type FilesystemReader = (root: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export function checkDiskSpace(config: SuplexConfig, database: SuplexDatabase, readFilesystem: FilesystemReader = statfs): () => Promise<HealthCheck> {
  return async () => {
    try {
      const minFreeBytes = readEnvironmentSettings(database).minFreeDiskGb * 1024 ** 3;
      const filesystems = await Promise.all([readFilesystem(config.worktreeRoot), readFilesystem(config.artifactRoot)]);
      const freeBytes = Math.min(...filesystems.map((filesystem) => Number(filesystem.bavail) * Number(filesystem.bsize)));
      const healthy = minFreeBytes === 0 || freeBytes >= minFreeBytes;
      return {
        id: "disk-space",
        label: "Disk space",
        status: healthy ? "healthy" : "warning",
        summary: healthy ? "Free disk space meets the configured minimum" : `${(freeBytes / 1024 ** 3).toFixed(2)} GB free; minimum is ${(minFreeBytes / 1024 ** 3).toFixed(2)} GB`,
        details: { freeBytes, minFreeBytes },
      };
    } catch {
      return { id: "disk-space", label: "Disk space", status: "warning", summary: "Free disk space could not be read", details: {} };
    }
  };
}

export function createHostHealthDependencies(config: SuplexConfig, database: SuplexDatabase, providers: readonly ProviderHarnessKind[] = HARNESS_KINDS) {
  return {
    database: () => checkDatabase(database),
    artifactRoot: () => checkArtifactRoot(config.artifactRoot),
    diskSpace: checkDiskSpace(config, database),
    git: checkGit(process.env.SUPLEX_GIT_BIN ?? "git"),
    herdrReadiness: createHerdrReadinessCheck(),
    ghAuth: checkGithubAuthentication(process.env.SUPLEX_GH_COMMAND ?? "gh"),
    pnpm: checkPnpm("pnpm"),
    ...(config.tailscaleExposure === "serve" || isTailscaleAddress(config.bindAddress) ? { tailscale: checkTailscale(process.env.SUPLEX_TAILSCALE_COMMAND ?? "tailscale") } : {}),
    backup: () => checkBackupHealth(config),
    provider: createProviderReadiness(undefined, providers),
  };
}
