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
    async signal() {},
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
    executable: "node",
    argv: ["/usr/local/bin/node", "worker.js"],
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
  let ownedStopped = false;
  const controller = makeController({
    async inspect(pid) {
      if (pid === owned.pid) return ownedStopped ? undefined : makeInspection(owned);
      if (pid === unrelated.pid) return makeInspection(unrelated);
      return undefined;
    },
    async signal(pid, signal) {
      expect(signal).toBe("SIGTERM");
      signalled.push(pid);
      ownedStopped = true;
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [owned] }, controller);

  expect(signalled).toEqual([owned.pid]);
  expect(signalled.includes(unrelated.pid)).toBe(false);
});

test("shutdown signals the recorded live PID even when it has a detached process group", async () => {
  const owned: OwnedProcess = {
    name: "forge-worker",
    pid: 4101,
    command: "/usr/local/bin/node worker.js",
    startedAt: "2026-08-10T00:00:00.000Z",
    processGroup: 5101,
    startTime: "Tue 10 Aug 00:00:00 2026",
    executable: "node",
    argv: ["/usr/local/bin/node", "worker.js"],
  };
  let leaderRunning = true;
  let groupRunning = true;
  const signalledGroups: number[] = [];
  const controller = makeController({
    async inspect(pid) {
      return pid === owned.pid && leaderRunning ? makeInspection(owned) : undefined;
    },
    async signal(pid) {
      expect(pid).toBe(owned.pid);
      leaderRunning = false;
      groupRunning = false;
    },
    async signalGroup(processGroup) {
      signalledGroups.push(processGroup);
      leaderRunning = false;
      groupRunning = false;
    },
    async isProcessGroupAlive(processGroup) {
      expect(processGroup).toBe(owned.processGroup);
      return groupRunning;
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [owned] }, controller);

  expect(signalledGroups).toEqual([]);
});

test("shutdown reports a live PID that survives termination", async () => {
  const owned: OwnedProcess = {
    name: "forge-worker",
    pid: 4101,
    command: "/usr/local/bin/node worker.js",
    startedAt: "2026-08-10T00:00:00.000Z",
    processGroup: 5101,
    startTime: "Tue 10 Aug 00:00:00 2026",
    executable: "node",
    argv: ["/usr/local/bin/node", "worker.js"],
  };
  let leaderRunning = true;
  const controller = makeController({
    async inspect() {
      return leaderRunning ? makeInspection(owned) : undefined;
    },
    async signalGroup() {
      leaderRunning = false;
    },
    async isProcessGroupAlive() {
      return true;
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [owned] }, controller))
    .rejects.toThrow(/did not exit after SIGKILL/i);
});

test("shutdown stops a reused live PID without an ownership verdict", async () => {
  const signalled: number[] = [];
  const controller = makeController({
    async inspect() {
      return { pid: 4101, command: "/usr/local/bin/node unrelated.js", executable: "node", argv: ["/usr/local/bin/node", "unrelated.js"], processGroup: 4101, startTime: "Tue 11 Aug 00:00:00 2026" };
    },
    async signal(pid) {
      signalled.push(pid);
    },
  });

  await expect(stopOwnedProcesses({
    version: 1,
    processes: [{
      name: "forge-worker",
      pid: 4101,
      command: "/usr/local/bin/node worker.js",
      startedAt: "2026-08-10T00:00:00.000Z",
      processGroup: 4101,
      startTime: "Tue 10 Aug 00:00:00 2026",
    }],
  }, controller)).rejects.toThrow(/did not exit after SIGKILL/i);

  expect(signalled).toEqual([4101, 4101]);
});

test("shutdown stops a live legacy process record", async () => {
  const signalled: number[] = [];
  const controller = makeController({
    async inspect() {
      return {
        pid: 4101,
        command: "/usr/local/bin/node worker.js",
        executable: "/usr/local/bin/node",
        argv: ["/usr/local/bin/node", "worker.js"],
        processGroup: 4101,
        startTime: "Tue 10 Aug 00:00:00 2026",
      };
    },
    async signal(pid) {
      signalled.push(pid);
    },
  });

  await expect(stopOwnedProcesses({
    version: 1,
    processes: [{
      name: "forge-worker",
      pid: 4101,
      command: "/usr/local/bin/node worker.js",
      startedAt: "2026-08-10T00:00:00.000Z",
      processGroup: 4101,
    }],
  }, controller)).rejects.toThrow(/did not exit after SIGKILL/i);

  expect(signalled).toEqual([4101, 4101]);
});

test("shutdown stops a live PID despite changed start metadata", async () => {
  const signalled: number[] = [];
  const controller = makeController({
    async inspect() {
      return { pid: 4101, command: "/usr/local/bin/node worker.js", executable: "node", argv: ["/usr/local/bin/node", "worker.js"], processGroup: 4101, startTime: "Tue 11 Aug 00:00:00 2026" };
    },
    async signal(pid) {
      signalled.push(pid);
    },
  });

  await expect(stopOwnedProcesses({
    version: 1,
    processes: [{
      name: "forge-worker",
      pid: 4101,
      command: "/usr/local/bin/node worker.js",
      startedAt: "2026-08-10T00:00:00.000Z",
      processGroup: 4101,
      startTime: "Tue 10 Aug 00:00:00 2026",
    }],
  }, controller)).rejects.toThrow(/did not exit after SIGKILL/i);

  expect(signalled).toEqual([4101, 4101]);
});

test("shutdown reports a live PID that does not exit", async () => {
  const owned: OwnedProcess = {
    name: "forge-worker",
    pid: 4101,
    command: "/usr/local/bin/node worker.js",
    startedAt: "2026-08-10T00:00:00.000Z",
    processGroup: 4101,
    startTime: "Tue 10 Aug 00:00:00 2026",
    executable: "node",
    argv: ["/usr/local/bin/node", "worker.js"],
  };
  const controller = makeController({
    async inspect() {
      return makeInspection(owned);
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [owned] }, controller)).rejects.toThrow(/did not exit after SIGKILL/i);
});

test("shutdown passes the recorded Serve backend to cleanup", async () => {
  let stoppedBackend = "";
  let configured = true;
  const controller = makeController({
    async stopServe(serve) {
      stoppedBackend = serve.backend;
      configured = false;
    },
    async isServeConfigured() {
      return configured;
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [], tailscaleServe: { port: 4111, backend: "http://127.0.0.1:4111" } }, controller);

  expect(stoppedBackend).toBe("http://127.0.0.1:4111");
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
