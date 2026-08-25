import { basename } from "node:path";

import type { HealthCheck } from "../health.js";
import { commandFailure, runCommand, type CommandRunner } from "../provider-readiness.js";

export const MINIMUM_HERDR_VERSION = "0.8.2";
export const MINIMUM_INTERACTIVE_CODEX_VERSION = "0.149.0";
const version = (text: string): string | undefined => /\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/.exec(text)?.[0];
const atLeast = (actual: string, minimum: string): boolean => { const a = actual.split(".").map(Number); const b = minimum.split(".").map(Number); for (let index = 0; index < 3; index += 1) { if (a[index]! > b[index]!) return true; if (a[index]! < b[index]!) return false; } return true; };

export class HerdrReadinessProbe {
  constructor(private readonly herdr = "herdr", private readonly codex = "codex", private readonly runner: CommandRunner = runCommand, private readonly cwd = process.cwd()) {}
  async check(): Promise<HealthCheck> {
    let herdrVersion = "unknown"; let codexVersion = "unknown"; let failure: string | undefined;
    try { herdrVersion = version((await this.runner(this.herdr, ["--version"], { timeout: 3_000, maxBuffer: 4096, cwd: this.cwd })).stdout) ?? "unknown"; if (!atLeast(herdrVersion, MINIMUM_HERDR_VERSION)) failure = "herdr-version"; await this.runner(this.herdr, ["api", "schema"], { timeout: 3_000, maxBuffer: 16 * 1024, cwd: this.cwd }); } catch (error) { failure = commandFailure(error, "herdr-unavailable", "herdr-timeout"); }
    try { codexVersion = version((await this.runner(this.codex, ["--version"], { timeout: 3_000, maxBuffer: 4096, cwd: this.cwd })).stdout) ?? "unknown"; if (!atLeast(codexVersion, MINIMUM_INTERACTIVE_CODEX_VERSION)) failure ??= "codex-version"; await this.runner(this.codex, ["login", "status"], { timeout: 3_000, maxBuffer: 4096, cwd: this.cwd }); } catch (error) { failure ??= commandFailure(error, "unauthenticated", "auth-timeout"); }
    return { id: "codex-auth", label: "Herdr and Codex readiness", status: failure ? "unhealthy" : "healthy", summary: failure ? "Herdr or interactive Codex is unavailable" : "Herdr socket, Codex version, and local authentication are ready", details: { herdr: basename(this.herdr), herdrVersion, codex: basename(this.codex), codexVersion, failure: failure ?? "none", testedAt: new Date().toISOString() } };
  }
}
