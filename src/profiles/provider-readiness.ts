import { basename } from "node:path";
import { spawn } from "node:child_process";

import type { HealthCheck } from "../platform/health.js";
import { GhAuthStatusSchema } from "../platform/schemas.js";


export type GithubFailure = "command-missing" | "auth-timeout" | "auth-format" | "unauthenticated" | "auth-failed";

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], options: { timeout: number; maxBuffer: number; cwd?: string }) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
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

export function commandFailure(error: unknown, fallback: string, timeoutFailure: string): string {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return "command-missing";
  }
  if (error instanceof Error && /timed out/i.test(error.message)) {
    return timeoutFailure;
  }
  return fallback;
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
