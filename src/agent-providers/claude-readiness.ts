import { basename } from "node:path";
import type { HealthCheck } from "../health.js";
import { commandFailure, runCommand, type CommandRunner } from "../provider-readiness.js";
import { jsonRequired } from "../task-utils.js";

export const MINIMUM_CLAUDE_VERSION = "2.1.0";
const supported = (version: string) => {
  const current = version.split(".").map(Number);
  const minimum = MINIMUM_CLAUDE_VERSION.split(".").map(Number);
  if (current.length !== 3) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! !== minimum[index]!) return current[index]! > minimum[index]!;
  }
  return true;
};
export class ClaudeReadinessProbe {
  constructor(private readonly command = process.env.FORGE_CLAUDE_COMMAND ?? "claude", private readonly runner: CommandRunner = runCommand, private readonly cwd = process.cwd()) {}
  async check(): Promise<HealthCheck> {
    let version = "unknown", failure: string | undefined, authenticated = false;
    try { const result = await this.runner(this.command, ["--version"], { timeout: 3_000, maxBuffer: 4096, cwd: this.cwd }); const match = /\b\d+\.\d+\.\d+\b/.exec(result.stdout); if (!match) failure = "unsupported-version"; else { version = match[0]; if (!supported(version)) failure = "version-unsupported"; } } catch (error) { failure = commandFailure(error, "version-unavailable", "version-timeout"); }
    if (!failure) try { const result = await this.runner(this.command, ["auth", "status"], { timeout: 3_000, maxBuffer: 4096, cwd: this.cwd }); authenticated = (jsonRequired(result.stdout) as { loggedIn?: boolean }).loggedIn === true; if (!authenticated) failure = "unauthenticated"; } catch (error) { failure = commandFailure(error, "unauthenticated", "auth-timeout"); }
    const details = { command: basename(this.command), version, authentication: authenticated ? "available" : "unavailable", failure: failure ?? "none", testedAt: new Date().toISOString(), minVersion: MINIMUM_CLAUDE_VERSION };
    return failure ? { id: "claude-auth", label: "Claude Code readiness", status: "unhealthy", summary: failure.includes("version") || failure === "command-missing" ? "Claude Code version is unavailable" : "Claude Code local authentication is unavailable", details } : { id: "claude-auth", label: "Claude Code readiness", status: "healthy", summary: "Claude Code version and local authentication are ready", details };
  }
}
