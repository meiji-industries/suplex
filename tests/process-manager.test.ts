import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { readProcessRegistry, stopOwnedProcesses, type OwnedProcess, type ProcessController } from "../src/process-manager.js";

test("shutdown signals only the recorded owned process identities", async () => {
  const owned: OwnedProcess = {
    name: "forge-worker",
    pid: 4101,
    command: "/usr/local/bin/node worker.js",
    startedAt: "2026-08-10T00:00:00.000Z",
  };
  const unrelated: OwnedProcess = {
    name: "unrelated-worker-like-process",
    pid: 4102,
    command: "/usr/local/bin/node worker-like.js",
    startedAt: "2026-08-10T00:00:01.000Z",
  };
  const signalled: number[] = [];
  const controller: ProcessController = {
    async inspect(pid) {
      if (pid === owned.pid) {
        return { pid, command: owned.command };
      }
      if (pid === unrelated.pid) {
        return { pid, command: unrelated.command };
      }
      return undefined;
    },
    async signal(pid, signal) {
      expect(signal).toBe("SIGTERM");
      signalled.push(pid);
    },
    async stopContainer() {
      throw new Error("no container should be stopped in this test");
    },
  };

  await stopOwnedProcesses(
    {
      version: 1,
      processes: [owned],
      temporalContainer: undefined,
    },
    controller,
  );

  expect(signalled).toEqual([owned.pid]);
  expect(signalled.includes(unrelated.pid)).toBe(false);
});

test("shutdown refuses a reused PID whose command identity no longer matches", async () => {
  const signalled: number[] = [];
  const controller: ProcessController = {
    async inspect() {
      return { pid: 4101, command: "/usr/local/bin/node unrelated.js" };
    },
    async signal(pid) {
      signalled.push(pid);
    },
    async stopContainer() {
      throw new Error("no container should be stopped in this test");
    },
  };

  const report = await stopOwnedProcesses(
    {
      version: 1,
      processes: [
        {
          name: "forge-worker",
          pid: 4101,
          command: "/usr/local/bin/node worker.js",
          startedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
      temporalContainer: undefined,
    },
    controller,
  );

  expect(signalled).toEqual([]);
  expect(report.skipped).toEqual([{ pid: 4101, reason: "identity-mismatch" }]);
});

test("shutdown passes the recorded Serve backend to cleanup", async () => {
  let stoppedBackend = "";
  const controller: ProcessController = {
    async inspect() {
      return undefined;
    },
    async signal() {},
    async stopContainer() {},
    async stopServe(serve) {
      stoppedBackend = serve.backend;
    },
  };

  await stopOwnedProcesses({
    version: 1,
    processes: [],
    tailscaleServe: { port: 4111, backend: "http://127.0.0.1:4111" },
  }, controller);

  expect(stoppedBackend).toBe("http://127.0.0.1:4111");
});

test("shutdown preserves an adopted legacy Temporal container", async () => {
  let stopped = false;
  const controller: ProcessController = {
    async inspect() {
      return undefined;
    },
    async signal() {},
    async stopContainer() {
      stopped = true;
    },
  };

  const report = await stopOwnedProcesses({
    version: 1,
    processes: [],
    temporalContainer: { id: "legacy-id", name: "forge-temporal", legacy: true },
  }, controller);

  expect(stopped).toBe(false);
  expect(report.containersStopped).toEqual([]);
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
