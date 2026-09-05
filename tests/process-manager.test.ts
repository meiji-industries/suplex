import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { compareProcessIdentity, inspectProcessOnce, readProcessRegistry, stopOwnedProcesses, type OwnedProcess, type ProcessController, type ProcessInspection } from "../src/process-manager.js";

test("process identity survives a change in the observing process locale", async () => {
  try {
    vi.stubEnv("LC_ALL", "C");
    const original = await inspectProcessOnce(process.pid);
    if (!original) throw new Error("Could not inspect the test process");
    const owned = { ...original, name: "test", startedAt: original.startTime };
    vi.stubEnv("LC_ALL", "en_CA.UTF-8");
    const observed = await inspectProcessOnce(process.pid);
    expect(observed?.startTime).toBe(original.startTime);
    expect(compareProcessIdentity(owned, observed).kind).toBe("exact_match");
  } finally {
    vi.unstubAllEnvs();
  }
});

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

function makeOwned(overrides: Partial<OwnedProcess> = {}): OwnedProcess {
  return {
    name: "forge-worker",
    pid: 4101,
    command: "/usr/local/bin/node worker.js",
    startedAt: "2026-08-10T00:00:00.000Z",
    processGroup: 4101,
    startTime: "Tue 10 Aug 00:00:00 2026",
    executable: "node",
    argv: ["/usr/local/bin/node", "worker.js"],
    ...overrides,
  };
}

test("shutdown signals a matching recorded identity", async () => {
  const owned = makeOwned();
  const signalled: Array<"SIGTERM" | "SIGKILL"> = [];
  let running = true;
  const controller = makeController({
    async inspect() {
      return running ? makeInspection(owned) : undefined;
    },
    async signal(_pid, signal) {
      signalled.push(signal);
      running = false;
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [owned] }, controller)).resolves.toEqual({
    stopped: [owned.pid],
    skipped: [],
  });
  expect(signalled).toEqual(["SIGTERM"]);
});

test("shutdown targets only the recorded PID when it did not lead its process group", async () => {
  const owned = makeOwned({ processGroup: 5101 });
  let running = true;
  const signalled: number[] = [];
  const controller = makeController({
    async inspect() {
      return running ? makeInspection(owned) : undefined;
    },
    async signal(pid) {
      signalled.push(pid);
      running = false;
    },
    async signalGroup() {
      throw new Error("a process group not created by Forge must not be signalled");
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [owned] }, controller);
  expect(signalled).toEqual([owned.pid]);
});

test("shutdown refuses PID reuse immediately before SIGTERM", async () => {
  const owned = makeOwned();
  let inspections = 0;
  const signalled: string[] = [];
  const controller = makeController({
    async inspect() {
      inspections += 1;
      return inspections === 1
        ? makeInspection(owned)
        : { ...makeInspection(owned), startTime: "Tue 11 Aug 00:00:00 2026" };
    },
    async signal(_pid, signal) {
      signalled.push(signal);
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [owned] }, controller))
    .rejects.toThrow(/ownership is wrong start time/i);
  expect(signalled).toEqual([]);
});

test("shutdown refuses PID reuse between SIGTERM and SIGKILL", async () => {
  const owned = makeOwned();
  let inspections = 0;
  const signalled: string[] = [];
  const controller = makeController({
    async inspect() {
      inspections += 1;
      return inspections < 4
        ? makeInspection(owned)
        : { ...makeInspection(owned), startTime: "Tue 11 Aug 00:00:00 2026" };
    },
    async signal(_pid, signal) {
      signalled.push(signal);
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [owned] }, controller))
    .rejects.toThrow(/ownership is wrong start time/i);
  expect(signalled).toEqual(["SIGTERM"]);
});

test("shutdown escalates a matching identity from SIGTERM to SIGKILL", async () => {
  const owned = makeOwned();
  let running = true;
  const signalled: string[] = [];
  const controller = makeController({
    async inspect() {
      return running ? makeInspection(owned) : undefined;
    },
    async signal(_pid, signal) {
      signalled.push(signal);
      if (signal === "SIGKILL") running = false;
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [owned] }, controller);
  expect(signalled).toEqual(["SIGTERM", "SIGKILL"]);
});

test("shutdown refuses a live legacy record without exact ownership identity", async () => {
  const inspected = makeOwned();
  const legacy = makeOwned({ startTime: undefined, executable: undefined, argv: undefined });
  const signalled: string[] = [];
  const controller = makeController({
    async inspect() {
      return makeInspection(inspected);
    },
    async signal(_pid, signal) {
      signalled.push(signal);
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [legacy] }, controller))
    .rejects.toThrow(/ownership is incomplete identity/i);
  expect(signalled).toEqual([]);
});

test("shutdown can stop an independently proven orphaned Forge process group", async () => {
  const owned = makeOwned();
  let groupRunning = true;
  const signalled: string[] = [];
  const controller = makeController({
    async inspect() {
      return undefined;
    },
    async signal() {
      throw new Error("an orphaned group has no leader PID to signal");
    },
    async signalGroup(processGroup, signal) {
      expect(processGroup).toBe(owned.processGroup);
      signalled.push(signal);
      groupRunning = false;
    },
    async isProcessGroupAlive() {
      return groupRunning;
    },
  });

  await stopOwnedProcesses({ version: 1, processes: [owned] }, controller);
  expect(signalled).toEqual(["SIGTERM"]);
});

test("shutdown reports a matching identity that survives SIGKILL", async () => {
  const owned = makeOwned();
  const controller = makeController({
    async inspect() {
      return makeInspection(owned);
    },
  });

  await expect(stopOwnedProcesses({ version: 1, processes: [owned] }, controller))
    .rejects.toThrow(/did not exit after SIGKILL/i);
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
