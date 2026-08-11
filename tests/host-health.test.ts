import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { CodexReadinessProbe, checkGithubAuthentication, checkWorker } from "../src/host-health.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";

test("worker readiness distinguishes missing, stale, and current registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worker-health-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const identifiers = runtimeIdentifiers("test-installation");
  try {
    assert.equal((await checkWorker(database, "tasks-test-installation", "test-installation")).status, "unhealthy");

    database.registerWorker({
      workerId: `${identifiers.workerPrefix}-123`,
      taskQueue: identifiers.taskQueue,
      buildId: identifiers.buildId,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal((await checkWorker(database, identifiers.taskQueue, "test-installation")).summary, "Worker heartbeat is stale");

    database.registerWorker({
      workerId: `${identifiers.workerPrefix}-123`,
      taskQueue: identifiers.taskQueue,
      buildId: identifiers.buildId,
    });
    const current = await checkWorker(database, identifiers.taskQueue, "test-installation");
    assert.equal(current.status, "healthy");
    assert.equal(current.details.buildId, identifiers.buildId);
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
    return { stdout: '{"type":"result","ok":true}\n', stderr: "" };
  };
  const probe = new CodexReadinessProbe("codex", runner, 60_000);

  assert.equal((await probe.check()).status, "healthy");
  assert.equal((await probe.check()).status, "healthy");
  assert.equal(calls.filter(([command]) => command === "exec").length, 1);
});

test("GitHub readiness parses bounded JSON without exposing account details", async () => {
  const check = checkGithubAuthentication("gh", async () => ({
    stdout: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "private" }] } }),
    stderr: "",
  }));
  const result = await check();
  assert.deepEqual(result.details, { command: "gh", authentication: "available" });
});
