import { access, constants, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";
import { GhAuthStatusSchema } from "./schemas.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { TemporalHealthProbe } from "./temporal/service.js";

const execFileAsync = promisify(execFile);
const minimumFreeBytes = 100 * 1024 * 1024;
const workerHeartbeatMaxAgeMs = 30_000;
const codexReadinessCacheMs = 5 * 60_000;

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

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<CommandResult>;

const runCommand: CommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export function checkCommandAuthentication(id: "codex-auth" | "gh-auth", label: string, command: string, args: string[], runner: CommandRunner = runCommand): () => Promise<HealthCheck> {
  return async () => {
    try {
      await runner(command, args, { timeout: 3_000, maxBuffer: 16 * 1024 });
      return { id, label, status: "healthy", summary: "Local authentication is available", details: { command } };
    } catch {
      return { id, label, status: "unhealthy", summary: "Local authentication is unavailable", details: { command } };
    }
  };
}

export class CodexReadinessProbe {
  private cached: { key: string; expiresAt: number; check: HealthCheck } | undefined;

  constructor(
    private readonly command: string,
    private readonly runner: CommandRunner = runCommand,
    private readonly cacheDurationMs = codexReadinessCacheMs,
  ) {}

  async check(): Promise<HealthCheck> {
    let version = "unknown";
    let authenticated = false;
    try {
      const versionResult = await this.runner(this.command, ["--version"], { timeout: 3_000, maxBuffer: 4 * 1024 });
      version = versionResult.stdout.trim().split(/\s+/).slice(-1)[0] ?? "unknown";
      await this.runner(this.command, ["login", "status"], { timeout: 3_000, maxBuffer: 4 * 1024 });
      authenticated = true;
    } catch {
      // The bounded smoke below is not attempted when version or auth is unavailable.
    }

    const key = `${version}|${authenticated ? "authenticated" : "unauthenticated"}`;
    if (this.cached && this.cached.key === key && this.cached.expiresAt > Date.now()) {
      return this.cached.check;
    }

    let check: HealthCheck;
    if (!authenticated) {
      check = {
        id: "codex-auth",
        label: "Codex readiness",
        status: "unhealthy",
        summary: "Codex version or local authentication is unavailable",
        details: { command: this.command, version, authentication: "unavailable", smoke: "not-run" },
      };
    } else {
      try {
        const smoke = await this.runner(this.command, [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "Return exactly a JSON object with an ok boolean. Do not use tools.",
        ], { timeout: 12_000, maxBuffer: 64 * 1024 });
        const events = smoke.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
        if (events.length === 0) {
          throw new Error("Codex smoke returned no structured events");
        }
        check = {
          id: "codex-auth",
          label: "Codex readiness",
          status: "healthy",
          summary: "Codex version, authentication, and structured smoke are ready",
          details: { command: this.command, version, authentication: "available", smoke: "passed" },
        };
      } catch {
        check = {
          id: "codex-auth",
          label: "Codex readiness",
          status: "unhealthy",
          summary: "Codex authentication is available but the structured smoke failed",
          details: { command: this.command, version, authentication: "available", smoke: "failed" },
        };
      }
    }
    this.cached = { key, expiresAt: Date.now() + this.cacheDurationMs, check };
    return check;
  }
}

export function checkGithubAuthentication(command: string, runner: CommandRunner = runCommand): () => Promise<HealthCheck> {
  return async () => {
    try {
      const result = await runner(command, ["auth", "status", "--json", "hosts"], { timeout: 3_000, maxBuffer: 16 * 1024 });
      const parsed = GhAuthStatusSchema.safeParse(JSON.parse(result.stdout));
      const accounts = parsed.success ? Object.values(parsed.data.hosts).flat() : [];
      const authenticated = accounts.some((account) => account.active && account.state === "success");
      return {
        id: "gh-auth",
        label: "GitHub CLI authentication",
        status: authenticated ? "healthy" : "unhealthy",
        summary: authenticated ? "GitHub CLI authentication is available" : "GitHub CLI authentication is unavailable",
        details: { command, authentication: authenticated ? "available" : "unavailable" },
      };
    } catch {
      return { id: "gh-auth", label: "GitHub CLI authentication", status: "unhealthy", summary: "GitHub CLI authentication is unavailable", details: { command, authentication: "unavailable" } };
    }
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
