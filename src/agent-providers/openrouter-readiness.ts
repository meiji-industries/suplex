import { basename } from "node:path";
import type { HealthCheck } from "../health.js";
import { commandFailure, runCommand, type CommandRunner } from "../provider-readiness.js";
import { ProviderCredentialStore, testOpenRouterKey } from "../provider-credentials.js";
export const MINIMUM_OMP_VERSION = "18.0.0";
const supported = (version: string) => {
  const current = version.split(".").map(Number);
  const minimum = MINIMUM_OMP_VERSION.split(".").map(Number);
  if (current.length !== 3 || !current.every(Number.isFinite)) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! !== minimum[index]!) return current[index]! > minimum[index]!;
  }
  return true;
};
export class OpenRouterReadinessProbe {
  constructor(private readonly command = process.env.FORGE_OMP_COMMAND ?? "omp", private readonly credentials?: ProviderCredentialStore, private readonly runner: CommandRunner = runCommand, private readonly keyTest = testOpenRouterKey, private readonly cwd = process.cwd()) {}
  async check(): Promise<HealthCheck> {
    let version = "unknown", failure: string | undefined;
    try { const result = await this.runner(this.command, ["--version"], { timeout: 3_000, maxBuffer: 4096, cwd: this.cwd }); const match = /\b\d+\.\d+\.\d+\b/.exec(result.stdout); if (!match) failure = "version-unsupported"; else { version = match[0]; if (!supported(version)) failure = "version-unsupported"; } } catch (error) { failure = commandFailure(error, "command-missing", "version-timeout"); }
    const credential = this.credentials?.get("openrouter");
    if (!failure && !credential) failure = "key-missing";
    let summary = "OpenRouter readiness is ready";
    if (!failure && credential) { const result = await this.keyTest(credential.secret); summary = result.summary; this.credentials?.recordTest("openrouter", result.ok ? "healthy" : "unhealthy", result.summary); if (!result.ok) failure = result.summary === "OpenRouter rejected the API key" ? "key-rejected" : "unreachable"; }
    const details = { command: basename(this.command), version, harness: "omp", authentication: credential ? "available" : "unavailable", failure: failure ?? "none", testedAt: new Date().toISOString(), minVersion: MINIMUM_OMP_VERSION };
    if (failure) return { id: "openrouter-auth", label: "OpenRouter readiness", status: "unhealthy", summary: failure === "key-missing" ? "OpenRouter API key is not configured" : summary === "OpenRouter readiness is ready" ? "omp is unavailable or unsupported" : summary, details };
    return { id: "openrouter-auth", label: "OpenRouter readiness", status: "healthy", summary, details };
  }
}
