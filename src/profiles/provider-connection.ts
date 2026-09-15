import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCodexExecutable as resolveCodexCli, resolveDevinExecutable as resolveDevinCli } from "../platform/executable-resolver.js";
import type { ProviderConnection } from "../http/contracts/providers.js";
import { profileHarness, type HarnessKind } from "../runtimes/task-harness.js";
import { createProviderReadinessCheck, probeCommand, type ProviderProbeResult, type ProviderProbeRunner } from "./provider-readiness.js";

export type ProviderConnectionProbe = (providerId: string) => Promise<ProviderConnection>;

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

/** Maps a health-check outcome onto the provider sign-in vocabulary. */
export function providerConnectionFromHealth(check: { status: "healthy" | "warning" | "unhealthy"; summary: string }): ProviderConnection {
  return {
    status: check.status === "healthy" ? "connected" : check.status === "unhealthy" ? "not-connected" : "unknown",
    summary: check.summary,
  };
}

/** `devin auth status` prints "Logged in (via …)" details or reports that no credentials exist. */
export function classifyDevinAuthStatus(result: ProviderProbeResult): ProviderConnection {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (/not logged in|logged out|unauthenticated|no credentials/i.test(output)) return { status: "not-connected", summary: "Devin CLI is not signed in" };
  if (result.timedOut) return { status: "unknown", summary: "The Devin CLI sign-in check timed out" };
  if (/logged in/i.test(output)) return { status: "connected", summary: "Devin CLI is signed in. Model access is not tested." };
  return { status: "unknown", summary: "Forge could not check the Devin CLI sign-in" };
}

/** `codex login status` prints "Logged in using …" and exits 0, or reports that no credentials exist. */
export function classifyCodexLoginStatus(result: ProviderProbeResult): ProviderConnection {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const connected: ProviderConnection = { status: "connected", summary: "Codex CLI is signed in. Model access is not tested." };
  if (/not logged in/i.test(output)) return { status: "not-connected", summary: "Codex CLI is not signed in" };
  if (/logged in using/i.test(output)) return connected;
  if (result.exitCode === 0) return connected;
  if (result.timedOut) return { status: "unknown", summary: "The Codex CLI sign-in check timed out" };
  return { status: "unknown", summary: "Forge could not check the Codex CLI sign-in" };
}

/** One sign-in probe for a CLI that answers a status subcommand. */
function createCliLoginCheck(options: { label: string; resolve: () => Promise<string>; args: string[]; classify: (result: ProviderProbeResult) => ProviderConnection; runCommand?: ProviderProbeRunner }): () => Promise<ProviderConnection> {
  const run = options.runCommand ?? probeCommand;
  const missing: ProviderConnection = { status: "not-connected", summary: `${options.label} is not installed` };
  return async () => {
    let executable: string;
    try {
      executable = await options.resolve();
    } catch {
      return missing;
    }
    try {
      return options.classify(await run(executable, options.args, { timeout: 5_000 }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return missing;
      return { status: "unknown", summary: `Forge could not check the ${options.label} sign-in` };
    }
  };
}

export function createDevinConnectionCheck(options: { resolveExecutable?: () => Promise<string>; runCommand?: ProviderProbeRunner } = {}): () => Promise<ProviderConnection> {
  return createCliLoginCheck({ label: "Devin CLI", resolve: options.resolveExecutable ?? resolveDevinCli, args: ["auth", "status"], classify: classifyDevinAuthStatus, ...(options.runCommand ? { runCommand: options.runCommand } : {}) });
}

export function createCodexConnectionCheck(options: { resolveExecutable?: () => Promise<string>; runCommand?: ProviderProbeRunner } = {}): () => Promise<ProviderConnection> {
  return createCliLoginCheck({ label: "Codex CLI", resolve: options.resolveExecutable ?? resolveCodexCli, args: ["login", "status"], classify: classifyCodexLoginStatus, ...(options.runCommand ? { runCommand: options.runCommand } : {}) });
}

/** OpenCode stores credentials in `<XDG_DATA_HOME|~/.local/share>/opencode/auth.json`, keyed by provider id. */
export function openCodeAuthFilePath(env: NodeJS.ProcessEnv = process.env, homeDirectory: string = homedir()): string {
  return join(env.XDG_DATA_HOME || join(homeDirectory, ".local", "share"), "opencode", "auth.json");
}

type ReadAuthFile = (path: string) => Promise<string>;

/**
 * Provider ids with a stored OpenCode credential. `opencode auth list` renders
 * display names that cannot be mapped back to provider ids reliably, so the
 * auth file it reads is the per-provider signal. A missing file means no stored
 * credentials; an unreadable or unparsable file returns null so callers can
 * keep the shared probe result. Credentials supplied through environment
 * variables or opencode.json are not recorded in the file.
 */
async function readOpenCodeCredentialProviders(path: string, readAuthFile: ReadAuthFile): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await readAuthFile(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return new Set();
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return new Set(Object.keys(parsed));
  } catch {
    return null;
  }
}

export interface ProviderConnectionProbeOptions {
  runCommand?: ProviderProbeRunner;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  resolveDevinExecutable?: () => Promise<string>;
  resolveCodexExecutable?: () => Promise<string>;
  readAuthFile?: ReadAuthFile;
}

/** One sign-in probe per harness kind; OpenCode rows refine it per provider when the auth file is readable. */
export function createProviderConnectionProbe(options: ProviderConnectionProbeOptions = {}): ProviderConnectionProbe {
  const readiness = { ...(options.runCommand ? { runCommand: options.runCommand } : {}), ...(options.env ? { env: options.env } : {}) };
  const checks: Record<HarnessKind, () => Promise<ProviderConnection>> = {
    opencode: async () => providerConnectionFromHealth(await createProviderReadinessCheck("opencode", readiness)()),
    "claude-code": async () => providerConnectionFromHealth(await createProviderReadinessCheck("claude-code", readiness)()),
    devin: createDevinConnectionCheck({ ...(options.runCommand ? { runCommand: options.runCommand } : {}), ...(options.resolveDevinExecutable ? { resolveExecutable: options.resolveDevinExecutable } : {}) }),
    codex: createCodexConnectionCheck({ ...(options.runCommand ? { runCommand: options.runCommand } : {}), ...(options.resolveCodexExecutable ? { resolveExecutable: options.resolveCodexExecutable } : {}) }),
  };
  const pending = new Map<HarnessKind, Promise<ProviderConnection>>();
  const shared = (kind: HarnessKind): Promise<ProviderConnection> => {
    let check = pending.get(kind);
    if (!check) {
      check = checks[kind]();
      pending.set(kind, check);
    }
    return check;
  };
  let credentials: Promise<Set<string> | null> | undefined;
  return async (providerId) => {
    if (profileHarness(providerId) !== "opencode") return shared(profileHarness(providerId));
    credentials ??= readOpenCodeCredentialProviders(openCodeAuthFilePath(options.env, options.homeDirectory), options.readAuthFile ?? (path => readFile(path, "utf8")));
    const providers = await credentials;
    if (providers === null) return shared("opencode");
    return providers.has(providerId)
      ? { status: "connected", summary: "OpenCode has a stored credential for this provider. Model access is not tested." }
      : { status: "not-connected", summary: "OpenCode has no stored credential for this provider" };
  };
}
