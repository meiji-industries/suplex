import { basename } from "node:path";
import { spawn } from "node:child_process";

import type { HealthCheck } from "./health.js";
import { GhAuthStatusSchema } from "./schemas.js";

export type GithubFailure = "command-missing" | "auth-timeout" | "auth-format" | "unauthenticated" | "auth-failed";

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], options: { timeout: number; maxBuffer: number; cwd?: string }) => Promise<CommandResult>;

const codexReadinessCacheMs = 5 * 60_000;

export const MINIMUM_CODEX_VERSION = "0.140.0";

function parseSemver(value: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
}

export function isSupportedCodexVersion(version: string): boolean {
  const parsed = parseSemver(version);
  const minimum = parseSemver(MINIMUM_CODEX_VERSION);
  if (parsed.length !== 3 || minimum.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i]! > minimum[i]!) return true;
    if (parsed[i]! < minimum[i]!) return false;
  }
  return true;
}

const runCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    if (!settled) {
      settled = true;
      reject(new Error(`${command} timed out`));
    }
  }, options.timeout);
  const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
    if (settled) return;
    if (target === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (stdout.length + stderr.length > options.maxBuffer) {
      child.kill("SIGTERM");
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command} exceeded its output limit`));
    }
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
  });
});

export class CodexReadinessProbe {
  private cached: { key: string; expiresAt: number; check: HealthCheck } | undefined;

  constructor(
    private readonly command: string,
    private readonly runner: CommandRunner = runCommand,
    private readonly cacheDurationMs = codexReadinessCacheMs,
    private readonly workingDirectory = process.cwd(),
  ) {}

  async check(): Promise<HealthCheck> {
    let version = "unknown";
    let authenticated = false;
    let failure: string | undefined;
    try {
      const versionResult = await this.runner(this.command, ["--version"], { timeout: 3_000, maxBuffer: 4 * 1024, cwd: this.workingDirectory });
      const versionMatch = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.exec(versionResult.stdout);
      if (!versionMatch) {
        failure = "unsupported-version";
      } else {
        version = versionMatch[0];
        if (!isSupportedCodexVersion(version)) {
          failure = "version-unsupported";
        }
      }
    } catch (error) {
      failure = commandFailure(error, "version-unavailable", "version-timeout");
    }
    if (!failure && version !== "unknown") {
      try {
        await this.runner(this.command, ["login", "status"], { timeout: 3_000, maxBuffer: 4 * 1024, cwd: this.workingDirectory });
        authenticated = true;
      } catch (error) {
        failure = commandFailure(error, "unauthenticated", "auth-timeout");
      }
    }

    const cacheKey = `${version}|${authenticated ? "authenticated" : "unauthenticated"}|${failure ?? "none"}`;
    if (this.cached && this.cached.expiresAt > Date.now() && this.cached.key === cacheKey) {
      return this.cached.check;
    }

    const safeCommand = basename(this.command);
    const cacheExpiresAt = new Date(Date.now() + this.cacheDurationMs).toISOString();
    let check: HealthCheck;
    const testedAt = new Date().toISOString();
    if (!authenticated || failure) {
      check = {
        id: "codex-auth",
        label: "Codex readiness",
        status: "unhealthy",
        summary: failure === "version-unavailable" || failure === "command-missing"
          ? "Codex version is unavailable"
          : failure === "version-unsupported" || failure === "unsupported-version"
            ? `Codex version ${version === "unknown" ? "is unparseable" : version} is not supported`
            : "Codex local authentication is unavailable",
        details: { command: safeCommand, version, authentication: "unavailable", smoke: "not-run", failure: failure ?? "unauthenticated", testedAt, cacheExpiresAt, minVersion: MINIMUM_CODEX_VERSION },
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
        ], { timeout: 20_000, maxBuffer: 64 * 1024, cwd: this.workingDirectory });
        const events = smoke.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
        const completed = events.some((event) => event && typeof event === "object" && "type" in event && event.type === "turn.completed");
        const validOutput = events.some((event) => {
          if (!event || typeof event !== "object" || !("type" in event) || event.type !== "item.completed" || !("item" in event)) return false;
          const item = event.item;
          if (!item || typeof item !== "object" || !("type" in item) || item.type !== "agent_message" || !("text" in item) || typeof item.text !== "string") return false;
          try {
            const output = JSON.parse(item.text) as unknown;
            return Boolean(output && typeof output === "object" && "ok" in output && output.ok === true);
          } catch {
            return false;
          }
        });
        if (!completed || !validOutput) {
          throw new Error("Codex smoke did not produce a completed structured JSON object");
        }
        check = {
          id: "codex-auth",
          label: "Codex readiness",
          status: "healthy",
          summary: "Codex version, authentication, and structured smoke are ready",
          details: { command: safeCommand, version, authentication: "available", smoke: "passed", failure: "none", testedAt, cacheExpiresAt, minVersion: MINIMUM_CODEX_VERSION },
        };
      } catch (error) {
        const smokeFailure = smokeFailureKind(error);
        check = {
          id: "codex-auth",
          label: "Codex readiness",
          status: "unhealthy",
          summary: "Codex authentication is available but the structured smoke failed",
          details: { command: safeCommand, version, authentication: "available", smoke: "failed", failure: smokeFailure, testedAt, cacheExpiresAt, minVersion: MINIMUM_CODEX_VERSION },
        };
      }
    }
    this.cached = { key: cacheKey, expiresAt: Date.now() + this.cacheDurationMs, check };
    return check;
  }
}

function commandFailure(error: unknown, fallback: string, timeoutFailure: string): string {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return "command-missing";
  }
  if (error instanceof Error && /timed out/i.test(error.message)) {
    return timeoutFailure;
  }
  return fallback;
}

function smokeFailureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return "smoke-timeout";
  if (/JSON|structured turn/i.test(message)) return "smoke-invalid-output";
  return "smoke-failed";
}

export function checkGithubAuthentication(command: string, runner: CommandRunner = runCommand): () => Promise<HealthCheck> {
  return async () => {
    const safeCommand = basename(command);
    let failure: GithubFailure | undefined;
    let authenticated = false;
    try {
      const result = await runner(command, ["auth", "status", "--json", "hosts"], { timeout: 3_000, maxBuffer: 16 * 1024 });
      const parsed = GhAuthStatusSchema.safeParse(JSON.parse(result.stdout));
      if (!parsed.success) {
        failure = "auth-format";
      } else {
        const accounts = Object.values(parsed.data.hosts).flat();
        authenticated = accounts.some((account) => account.active && account.state === "success");
        if (!authenticated) failure = "unauthenticated";
      }
    } catch (error) {
      failure = commandFailure(error, "auth-failed", "auth-timeout") as GithubFailure;
      if (!failure) failure = "auth-failed";
    }
    const summary = authenticated
      ? "GitHub CLI authentication is available"
      : failure === "command-missing"
        ? "GitHub CLI is not installed"
        : failure === "auth-timeout"
          ? "GitHub CLI auth status timed out"
          : failure === "auth-format"
            ? "GitHub CLI auth status returned an unexpected format"
            : "GitHub CLI authentication is unavailable";
    return {
      id: "gh-auth",
      label: "GitHub CLI authentication",
      status: authenticated ? "healthy" : "unhealthy",
      summary,
      details: { command: safeCommand, authentication: authenticated ? "available" : "unavailable", failure: failure ?? "none" },
    };
  };
}
