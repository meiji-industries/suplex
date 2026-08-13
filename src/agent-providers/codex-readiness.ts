import { basename } from "node:path";

import type { HealthCheck } from "../health.js";
import { commandFailure, runCommand, type CommandRunner } from "../provider-readiness.js";

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

export class CodexReadinessProbe {
  constructor(
    private readonly command: string,
    private readonly runner: CommandRunner = runCommand,
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

    const safeCommand = basename(this.command);
    const testedAt = new Date().toISOString();
    if (!authenticated || failure) {
      return {
        id: "codex-auth",
        label: "Codex readiness",
        status: "unhealthy",
        summary: failure === "version-unavailable" || failure === "command-missing"
          ? "Codex version is unavailable"
          : failure === "version-unsupported" || failure === "unsupported-version"
            ? `Codex version ${version === "unknown" ? "is unparseable" : version} is not supported`
            : "Codex local authentication is unavailable",
        details: { command: safeCommand, version, authentication: "unavailable", failure: failure ?? "unauthenticated", testedAt, minVersion: MINIMUM_CODEX_VERSION },
      };
    }
    return {
      id: "codex-auth",
      label: "Codex readiness",
      status: "healthy",
      summary: "Codex version and local authentication are ready",
      details: { command: safeCommand, version, authentication: "available", failure: "none", testedAt, minVersion: MINIMUM_CODEX_VERSION },
    };
  }
}
