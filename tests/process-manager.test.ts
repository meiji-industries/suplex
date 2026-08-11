import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { readProcessRegistry, stopOwnedProcesses, type OwnedProcess, type ProcessController, type ProcessInspection } from "../src/process-manager.js";

function makeInspection(owned: OwnedProcess): ProcessInspection {
  return {
    pid: owned.pid,
    command: owned.command,
    executable: owned.executable ?? "node",
    argv: owned.argv ?? owned.command.split(/\s+/).filter(Boolean),
    processGroup: owned.processGroup ?? owned.pid,
    startTime: owned.startTime ?? "Tue 10 Aug 00:00:00 2026",
  };
}

function makeController(overrides: Partial<ProcessController> = {}): ProcessController {
  return {
    async inspect() {
      return undefined;
    },
    async inspectContainer() {
      return undefined;
    },
    async signal() {},
    async stopContainer() {},
    ...overrides,
  };
}

test("shutdown signals only the recorded owned process identities", async () => {
  const owned: OwnedProcess = {
    name: "forge-worker",
    pid: 4101,
    command: "/usr/local/bin/node worker.js",
    startedAt: "2026-08-10T00:00:00.000Z",
    processGroup: 4101,
    startTime: "Tue 10 Aug 00:00:00 2026",
  };
  const unrelated: OwnedProcess = {
    name: "unrelated-worker-like-process",
    pid: 4102,
    command: "/usr/local/bin/node worker-like.js",
    startedAt: "2026-08-10T00:00:01.000Z",
    processGroup: 4102,
    startTime: "Tue 10 Aug 00:00:01 2026",
  };
  const signalled: number[] = [];
  const controller = makeController({
    async inspect(pid) {
      if (pid === owned.pid) return makeInspection(owned);
      if (pid === unrelated.pid) return makeInspection(unrelated);
      return undefined;
    },
    async signal(pid, signal) {
      expect(signal).toBe("SIGTERM");
      signalled.push(pid);
    },
    async stopContainer() {
      throw new Error("no container should be stopped in this test");
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [owned], temporalContainer: undefined }, controller);

  expect(signalled).toEqual([owned.pid]);
  expect(signalled.includes(unrelated.pid)).toBe(false);
});

test("shutdown refuses a reused PID whose process identity no longer matches", async () => {
  const signalled: number[] = [];
  const controller = makeController({
    async inspect() {
      return { pid: 4101, command: "/usr/local/bin/node unrelated.js", executable: "node", argv: ["/usr/local/bin/node", "unrelated.js"], processGroup: 4101, startTime: "Tue 11 Aug 00:00:00 2026" };
    },
    async signal(pid) {
      signalled.push(pid);
    },
    async stopContainer() {
      throw new Error("no container should be stopped in this test");
    },
  });

  const report = await stopOwnedProcesses({
    version: 1,
    processes: [{
      name: "forge-worker",
      pid: 4101,
      command: "/usr/local/bin/node worker.js",
      startedAt: "2026-08-10T00:00:00.000Z",
      processGroup: 4101,
      startTime: "Tue 10 Aug 00:00:00 2026",
    }],
    temporalContainer: undefined,
  }, controller);

  expect(signalled).toEqual([]);
  expect(report.skipped).toEqual([{ pid: 4101, reason: "ownership-ambiguous" }]);
});

test("shutdown preserves an unrelated process with a matching command but different start identity", async () => {
  const signalled: number[] = [];
  const controller = makeController({
    async inspect() {
      return { pid: 4101, command: "/usr/local/bin/node worker.js", executable: "node", argv: ["/usr/local/bin/node", "worker.js"], processGroup: 4101, startTime: "Tue 11 Aug 00:00:00 2026" };
    },
    async signal(pid) {
      signalled.push(pid);
    },
  });

  const report = await stopOwnedProcesses({
    version: 1,
    processes: [{
      name: "forge-worker",
      pid: 4101,
      command: "/usr/local/bin/node worker.js",
      startedAt: "2026-08-10T00:00:00.000Z",
      processGroup: 4101,
      startTime: "Tue 10 Aug 00:00:00 2026",
    }],
    temporalContainer: undefined,
  }, controller);

  expect(signalled).toEqual([]);
  expect(report.skipped).toEqual([{ pid: 4101, reason: "ownership-ambiguous" }]);
});

test("shutdown passes the recorded Serve backend to cleanup", async () => {
  let stoppedBackend = "";
  const controller = makeController({
    async stopServe(serve) {
      stoppedBackend = serve.backend;
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [], tailscaleServe: { port: 4111, backend: "http://127.0.0.1:4111" } }, controller);

  expect(stoppedBackend).toBe("http://127.0.0.1:4111");
});

test("shutdown preserves an adopted legacy Temporal container", async () => {
  const controller = makeController();

  const report = await stopOwnedProcesses({
    version: 1,
    processes: [],
    temporalContainer: { id: "legacy-id", name: "forge-temporal", legacy: true },
  }, controller);

  expect(report.containersStopped).toEqual([]);
  expect(report.ambiguousContainers).toEqual([]);
});

test("shutdown does not claim a Temporal container stopped when Docker fails", async () => {
  const controller = makeController({
    async inspectContainer() {
      return { id: "neutral-id", name: "forge-temporal-neutral", image: "temporalio/temporal:1.8.2", owner: "runtime-test" };
    },
    async stopContainer() {
      throw new Error("Docker is unavailable");
    },
  });

  await expect(stopOwnedProcesses({
    version: 1,
    processes: [],
    temporalContainer: { id: "neutral-id", name: "forge-temporal-neutral", image: "temporalio/temporal:1.8.2" },
  }, controller)).rejects.toThrow("Docker is unavailable");
});

test("shutdown skips a Temporal container whose live identity does not match", async () => {
  const controller = makeController({
    async inspectContainer() {
      return { id: "other-id", name: "forge-temporal-neutral", image: "temporalio/temporal:1.8.2", owner: "runtime-test" };
    },
    async stopContainer() {
      throw new Error("Docker should not be called");
    },
  });

  const report = await stopOwnedProcesses({
    version: 1,
    processes: [],
    temporalContainer: { id: "neutral-id", name: "forge-temporal-neutral", image: "temporalio/temporal:1.8.2" },
  }, controller);

  expect(report.containersStopped).toEqual([]);
  expect(report.ambiguousContainers).toEqual([{ id: "neutral-id", reason: "identity-mismatch" }]);
});

test("rejects a tampered process registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-registry-schema-test-"));
  const filename = join(root, "owned-processes.json");
  try {
    await writeFile(filename, JSON.stringify({ version: 2, processes: [] }));
    await expect(readProcessRegistry(filename)).rejects.toThrow(/process registry is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
