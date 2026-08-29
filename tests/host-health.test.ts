import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { checkWorker } from "../src/host-health.js";
import { CodexReadinessProbe, checkGithubAuthentication } from "../src/provider-readiness.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { logReconciliation } from "../src/worker.js";

test("idle periodic reconciliations do not emit info logs", () => {
  const debug: Array<{ message: string; context: object }> = [];
  const info: Array<{ message: string; context: object }> = [];
  const logger = {
    debug(message: string, context: object) { debug.push({ message, context }); },
    info(message: string, context: object) { info.push({ message, context }); },
  };

  logReconciliation(logger, "task-creation-reconciliation", 0, 0, { inspected: 0, started: 0, failed: 0 });
  expect(info).toEqual([]);
  expect(debug).toEqual([expect.objectContaining({ message: "Worker periodic reconciliation idle: task-creation-reconciliation" })]);

  logReconciliation(logger, "task-creation-reconciliation", 4, 1, { inspected: 1, started: 1, failed: 0 });
  expect(info).toEqual([expect.objectContaining({ message: "Worker periodic reconciliation changed state: task-creation-reconciliation" })]);
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

test("Codex readiness uses only version and local authentication checks", async () => {
  const calls: string[][] = [];
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "codex-cli 0.144.1\n", stderr: "" };
    if (args[0] === "login") return { stdout: "Logged in using ChatGPT\n", stderr: "" };
    throw new Error(`Unexpected Codex readiness command: ${args[0]}`);
  };
  const probe = new CodexReadinessProbe("codex", runner);

  expect((await probe.check()).status).toBe("healthy");
  expect(calls).toEqual([["--version"], ["login", "status"]]);
});

test("GitHub readiness parses bounded JSON without exposing account details", async () => {
  const check = checkGithubAuthentication("gh", async () => ({
    stdout: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "private" }] } }),
    stderr: "",
  }));
  const result = await check();
  expect(result.details).toMatchObject({ command: "gh", authentication: "available", failure: "none" });
});

test("Codex readiness reports command, version, and authentication failures distinctly", async () => {
  const missing = new CodexReadinessProbe("codex", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    throw error;
  });
  const missingResult = await missing.check();
  expect(missingResult.details.failure).toBe("command-missing");

  const unsupported = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "Codex CLI development build", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const unsupportedResult = await unsupported.check();
  expect(unsupportedResult.details.failure).toBe("unsupported-version");

  const belowMin = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 0.100.0", stderr: "" };
    if (args[0] === "login") return { stdout: "logged in", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const belowMinResult = await belowMin.check();
  expect(belowMinResult.details.failure).toBe("version-unsupported");

  const versionTimeout = new CodexReadinessProbe("codex", async () => {
    throw new Error("codex timed out");
  });
  expect((await versionTimeout.check()).details.failure).toBe("version-timeout");

  const authTimeout = new CodexReadinessProbe("codex", async (_command, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 1.0.0", stderr: "" };
    throw new Error("codex timed out");
  });
  expect((await authTimeout.check()).details.failure).toBe("auth-timeout");
});
