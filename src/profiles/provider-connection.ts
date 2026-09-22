import { resolveDevinExecutable as resolveDevinCli } from "../platform/executable-resolver.js";
import type { ProviderConnection } from "../http/contracts/providers.js";
import type { HarnessKind } from "../runtimes/harness-kind.js";
import { createProviderReadinessCheck, probeCommand, type ProviderProbeResult, type ProviderProbeRunner } from "./provider-readiness.js";

export type ProviderConnectionProbe = (providerId: HarnessKind) => Promise<ProviderConnection>;

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

/** Maps a health-check outcome onto the provider sign-in vocabulary. */
export function providerConnectionFromHealth(check: { status: "healthy" | "warning" | "unhealthy"; summary: string; details?: Record<string, string | number | boolean> }): ProviderConnection {
  return {
    status: check.status === "healthy" ? "connected" : check.status === "unhealthy" ? "not-connected" : "unknown",
    summary: check.summary,
    ...(check.status === "healthy" && typeof check.details?.account === "string" ? { account: check.details.account } : {}),
  };
}

/** `devin auth status` prints "Logged in (via …)" details or reports that no credentials exist. */
export function classifyDevinAuthStatus(result: ProviderProbeResult): ProviderConnection {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (/not logged in|logged out|unauthenticated|no credentials/i.test(output)) return { status: "not-connected", summary: "Devin CLI is not signed in" };
  if (result.timedOut) return { status: "unknown", summary: "The Devin CLI sign-in check timed out" };
  if (/logged in/i.test(output)) return { status: "connected", summary: "Devin CLI is signed in. Model access is not tested." };
  return { status: "unknown", summary: "Suplex could not check the Devin CLI sign-in" };
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
      return { status: "unknown", summary: `Suplex could not check the ${options.label} sign-in` };
    }
  };
}

export function createDevinConnectionCheck(options: { resolveExecutable?: () => Promise<string>; runCommand?: ProviderProbeRunner } = {}): () => Promise<ProviderConnection> {
  return createCliLoginCheck({ label: "Devin CLI", resolve: options.resolveExecutable ?? resolveDevinCli, args: ["auth", "status"], classify: classifyDevinAuthStatus, ...(options.runCommand ? { runCommand: options.runCommand } : {}) });
}

export interface ProviderConnectionProbeOptions {
  runCommand?: ProviderProbeRunner;
  env?: NodeJS.ProcessEnv;
  resolveDevinExecutable?: () => Promise<string>;
}

/** One sign-in probe per harness kind, shared by every caller within one provider listing. */
export function createProviderConnectionProbe(options: ProviderConnectionProbeOptions = {}): ProviderConnectionProbe {
  const readiness = { ...(options.runCommand ? { runCommand: options.runCommand } : {}), ...(options.env ? { env: options.env } : {}) };
  const checks: Record<HarnessKind, () => Promise<ProviderConnection>> = {
    opencode: async () => providerConnectionFromHealth(await createProviderReadinessCheck("opencode", readiness)()),
    "claude-code": async () => providerConnectionFromHealth(await createProviderReadinessCheck("claude-code", { ...readiness, includeAccount: true })()),
    devin: createDevinConnectionCheck({ ...(options.runCommand ? { runCommand: options.runCommand } : {}), ...(options.resolveDevinExecutable ? { resolveExecutable: options.resolveDevinExecutable } : {}) }),
    codex: async () => providerConnectionFromHealth(await createProviderReadinessCheck("codex", readiness)()),
  };
  const pending = new Map<HarnessKind, Promise<ProviderConnection>>();
  return (providerId) => {
    let check = pending.get(providerId);
    if (!check) {
      check = checks[providerId]();
      pending.set(providerId, check);
    }
    return check;
  };
}
