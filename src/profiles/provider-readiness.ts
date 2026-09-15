import { basename } from "node:path";
import { spawn } from "node:child_process";

import type { HealthCheck } from "../platform/health.js";
import { providerCheckId, providerCheckLabel } from "../platform/health-contract.js";
import { resolveClaudeExecutable, resolveCodexExecutable, resolveOpenCodeExecutable } from "../platform/executable-resolver.js";
import { GhAuthStatusSchema } from "../platform/schemas.js";
import type { ProviderHarnessKind } from "../platform/health-contract.js";


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
      ...(!authenticated ? { remedy: failure === "command-missing" ? "brew install gh" : "gh auth login" } : {}),
      details: { command: safeCommand, authentication: authenticated ? "available" : "unavailable", failure: failure ?? "none" },
    };
  };
}

export type ProviderProbeResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };
export type ProviderProbeRunner = (command: string, args: readonly string[], options: { timeout: number; env?: NodeJS.ProcessEnv }) => Promise<ProviderProbeResult>;

/** Resolves on non-zero exits; rejects only when the process cannot run at all. */
export const probeCommand: ProviderProbeRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env: options.env });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGTERM");
    resolve({ stdout, stderr, exitCode: null, timedOut: true });
  }, options.timeout);
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ stdout, stderr, exitCode: code, timedOut: false });
  });
});

export type ProviderState = "absent" | "present" | "signed-out" | "signed-in" | "unknown";

export interface ProviderReadinessOptions {
  resolveExecutable?: () => Promise<string>;
  runCommand?: ProviderProbeRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

const PROVIDER_PROBES: Record<ProviderHarnessKind, {
  resolve: () => Promise<string>;
  installRemedy: (platform: NodeJS.Platform) => Pick<HealthCheck, "remedy" | "remedyKind">;
  loginRemedy: string;
  authArgs: readonly string[];
  /** Classifies a completed probe; "present" means the tool ran but reported no usable sign-in signal. */
  classify: (result: ProviderProbeResult) => { state: ProviderState; credentials?: number };
}> = {
  opencode: {
    // Sources: `opencode auth --help`; https://opencode.ai install script (macOS/Linux); https://opencode.ai/docs (Windows).
    resolve: () => resolveOpenCodeExecutable(),
    installRemedy: (platform) => platform === "win32"
      ? { remedy: "https://opencode.ai/docs", remedyKind: "link" }
      : { remedy: "curl -fsSL https://opencode.ai/install | bash", remedyKind: "command" },
    loginRemedy: "opencode auth login",
    authArgs: ["auth", "list"],
    classify: (result) => {
      if (result.exitCode !== 0 || result.timedOut) return { state: "unknown" };
      const count = /(\d+)\s+credentials?/.exec(stripAnsi(result.stdout))?.[1];
      if (count === undefined) return { state: "present" };
      const credentials = Number(count);
      if (!Number.isSafeInteger(credentials)) return { state: "present" };
      return credentials > 0 ? { state: "signed-in", credentials } : { state: "signed-out", credentials };
    },
  },
  "claude-code": {
    // Sources: `claude auth --help` (login/status subcommands); https://claude.ai/install.sh (macOS/Linux); https://code.claude.com/docs/en/setup (Windows).
    resolve: () => resolveClaudeExecutable(),
    installRemedy: (platform) => platform === "win32"
      ? { remedy: "https://code.claude.com/docs/en/setup", remedyKind: "link" }
      : { remedy: "curl -fsSL https://claude.ai/install.sh | bash", remedyKind: "command" },
    loginRemedy: "claude auth login",
    authArgs: ["auth", "status", "--json"],
    classify: (result) => {
      if (result.timedOut) return { state: "unknown" };
      try {
        const status: unknown = JSON.parse(result.stdout);
        if (status && typeof status === "object" && "loggedIn" in status && typeof status.loggedIn === "boolean") {
          return { state: status.loggedIn ? "signed-in" : "signed-out" };
        }
      } catch { /* Unrecognized status output is not proof of any sign-in state. */ }
      return result.exitCode === 0 ? { state: "present" } : { state: "unknown" };
    },
  },
  codex: {
    // Sources: `codex login status` on codex-cli 0.154.0 prints "Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1); https://www.npmjs.com/package/@openai/codex.
    resolve: () => resolveCodexExecutable(),
    installRemedy: () => ({ remedy: "npm install -g @openai/codex", remedyKind: "command" }),
    loginRemedy: "codex login",
    authArgs: ["login", "status"],
    classify: (result) => {
      const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
      if (/not logged in/i.test(output)) return { state: "signed-out" };
      if (/logged in using/i.test(output)) return { state: "signed-in" };
      if (result.timedOut) return { state: "unknown" };
      return result.exitCode === 0 ? { state: "signed-in" } : { state: "unknown" };
    },
  },
};

/** Readiness for one registered task runtime, probed fresh on every call. */
export function createProviderReadinessCheck(kind: ProviderHarnessKind, options: ProviderReadinessOptions = {}): () => Promise<HealthCheck> {
  const probe = PROVIDER_PROBES[kind];
  const label = providerCheckLabel(kind);
  const id = providerCheckId(kind);
  const resolve = options.resolveExecutable ?? probe.resolve;
  const runCommand = options.runCommand ?? probeCommand;
  const platform = options.platform ?? process.platform;
  const base = { id, label, provider: kind };
  return async () => {
    let executable: string;
    try {
      executable = await resolve();
    } catch {
      return { ...base, status: "unhealthy", summary: `${label} is not installed`, ...probe.installRemedy(platform), details: { state: "absent" satisfies ProviderState } };
    }
    let result: ProviderProbeResult;
    try {
      result = await runCommand(executable, probe.authArgs, { timeout: 5_000, ...(options.env ? { env: options.env } : {}) });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { ...base, status: "unhealthy", summary: `${label} is not installed`, ...probe.installRemedy(platform), details: { state: "absent" satisfies ProviderState } };
      }
      return { ...base, status: "warning", summary: `Forge could not check the ${label} sign-in`, details: { command: basename(executable), state: "unknown" satisfies ProviderState } };
    }
    const classified = probe.classify(result);
    const details = { command: basename(executable), state: classified.state, ...(classified.credentials === undefined ? {} : { credentials: classified.credentials }) };
    if (classified.state === "signed-in") return { ...base, status: "healthy", summary: `${label} is signed in. Model access is not tested.`, details };
    if (classified.state === "signed-out") return { ...base, status: "unhealthy", summary: `${label} is not signed in`, remedy: probe.loginRemedy, remedyKind: "command", details };
    if (classified.state === "present") return { ...base, status: "warning", summary: `${label} is installed. Forge could not check the sign-in.`, details };
    return { ...base, status: "warning", summary: `Forge could not check the ${label} sign-in`, details };
  };
}

/** One readiness probe per runtime kind registered in src/task-harness-registry.ts. */
export function createProviderReadiness(options: ProviderReadinessOptions | undefined, kinds: readonly ProviderHarnessKind[]): (kind: ProviderHarnessKind) => Promise<HealthCheck> {
  const checks = new Map(kinds.map((kind) => [kind, createProviderReadinessCheck(kind, options)]));
  return async (kind) => {
    const check = checks.get(kind);
    if (!check) throw new Error(`No provider readiness check is registered for ${kind}`);
    return check();
  };
}
