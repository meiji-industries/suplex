import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { checkWorker } from "../src/host-health.js";
import { CodexReadinessProbe, checkGithubAuthentication } from "../src/provider-readiness.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { workerHasLivePollers } from "../src/worker.js";

test("worker readiness requires both live Temporal pollers", () => {
  expect(workerHasLivePollers({ runState: "RUNNING", workflowPollerState: "POLLING", activityPollerState: "POLLING" })).toBe(true);
  expect(workerHasLivePollers({ runState: "RUNNING", workflowPollerState: "FAILED", activityPollerState: "POLLING" })).toBe(false);
  expect(workerHasLivePollers({ runState: "STOPPED", workflowPollerState: "POLLING", activityPollerState: "POLLING" })).toBe(false);
});

test("worker readiness distinguishes missing, stale, and current registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-health-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const identifiers = runtimeIdentifiers("test-installation");
  try {
    expect((await checkWorker(database, "tasks-test-installation", "test-installation")).status).toBe("unhealthy");

    database.registerWorker({
      workerId: `${identifiers.workerPrefix}-123`,
      taskQueue: identifiers.taskQueue,
      buildId: identifiers.buildId,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await checkWorker(database, identifiers.taskQueue, "test-installation")).summary).toBe("Worker heartbeat is stale");

    database.registerWorker({
      workerId: `${identifiers.workerPrefix}-123`,
      taskQueue: identifiers.taskQueue,
      buildId: identifiers.buildId,
    });
    const current = await checkWorker(database, identifiers.taskQueue, "test-installation");
    expect(current.status).toBe("healthy");
    expect(current.details.buildId).toBe(identifiers.buildId);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex readiness caches the bounded structured smoke", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "codex-cli 0.144.1\n", stderr: "" };
    if (args[0] === "login") return { stdout: "Logged in using ChatGPT\n", stderr: "" };
    return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}\n{"type":"turn.completed"}\n', stderr: "" };
  };
  const probe = new CodexReadinessProbe("codex", runner, 60_000);

  expect((await probe.check()).status).toBe("healthy");
  expect((await probe.check()).status).toBe("healthy");
  expect(calls.filter(([command]) => command === "exec").length).toBe(1);
  expect(calls.length).toBe(5);
});

test("Codex readiness invalidates the smoke cache when version or authentication changes", async () => {
  let version = "0.144.1";
  let authenticated = true;
  let smokeCalls = 0;
  const probe = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: `codex-cli ${version}\n`, stderr: "" };
    if (args[0] === "login" && !authenticated) throw new Error("not authenticated");
    if (args[0] === "exec") smokeCalls += 1;
    return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}\n{"type":"turn.completed"}\n', stderr: "" };
  });

  await probe.check();
  version = "0.144.2";
  await probe.check();
  expect(smokeCalls).toBe(2);

  authenticated = false;
  const result = await probe.check();
  expect(result.details.authentication).toBe("unavailable");
  expect(smokeCalls).toBe(2);
});

test("GitHub readiness parses bounded JSON without exposing account details", async () => {
  const check = checkGithubAuthentication("gh", async () => ({
    stdout: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "private" }] } }),
    stderr: "",
  }));
  const result = await check();
  expect(result.details).toEqual({ command: "gh", authentication: "available" });
});

test("Codex readiness reports missing commands and malformed smoke output distinctly", async () => {
  const missing = new CodexReadinessProbe("codex", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    throw error;
  });
  const missingResult = await missing.check();
  expect(missingResult.details.failure).toBe("command-missing");

  const malformed = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 1.0.0", stderr: "" };
    if (args[0] === "login") return { stdout: "logged in", stderr: "" };
    return { stdout: "not-json", stderr: "" };
  });
  const malformedResult = await malformed.check();
  expect(malformedResult.details.failure).toBe("smoke-invalid-output");

  const unsupported = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "Codex CLI development build", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const unsupportedResult = await unsupported.check();
  expect(unsupportedResult.details.failure).toBe("unsupported-version");

  const falseSmoke = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 1.0.0", stderr: "" };
    if (args[0] === "login") return { stdout: "logged in", stderr: "" };
    return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":false}"}}\n{"type":"turn.completed"}\n', stderr: "" };
  });
  expect((await falseSmoke.check()).details.failure).toBe("smoke-invalid-output");

  const versionTimeout = new CodexReadinessProbe("codex", async () => {
    throw new Error("codex timed out");
  });
  expect((await versionTimeout.check()).details.failure).toBe("version-timeout");

  const authTimeout = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 1.0.0", stderr: "" };
    throw new Error("codex timed out");
  });
  expect((await authTimeout.check()).details.failure).toBe("auth-timeout");

  const smokeTimeout = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 1.0.0", stderr: "" };
    if (args[0] === "login") return { stdout: "logged in", stderr: "" };
    throw new Error("codex timed out");
  });
  expect((await smokeTimeout.check()).details.failure).toBe("smoke-timeout");
});
