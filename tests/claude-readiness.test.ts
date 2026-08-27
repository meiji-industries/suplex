import { expect, test } from "vitest";

import { ClaudeReadinessProbe } from "../src/agent-providers/claude-readiness.js";
import type { CommandRunner } from "../src/provider-readiness.js";

const runner = (version: string, auth = '{"loggedIn":true}'): CommandRunner => async (_command, args) => ({ stdout: args[0] === "--version" ? version : auth, stderr: "" });

test("reports healthy Claude Code when its version and auth are ready", async () => {
  await expect(new ClaudeReadinessProbe("claude", runner("2.1.247 (Claude Code)"), "/tmp").check()).resolves.toMatchObject({ id: "claude-auth", status: "healthy", details: { version: "2.1.247", authentication: "available" } });
});

test("rejects unsupported versions and missing commands", async () => {
  await expect(new ClaudeReadinessProbe("claude", runner("2.0.99"), "/tmp").check()).resolves.toMatchObject({ status: "unhealthy", details: { failure: "version-unsupported" } });
  const missing: CommandRunner = async () => { const error = Object.assign(new Error("not found"), { code: "ENOENT" }); throw error; };
  await expect(new ClaudeReadinessProbe("claude", missing, "/tmp").check()).resolves.toMatchObject({ status: "unhealthy", details: { failure: "command-missing" } });
});
