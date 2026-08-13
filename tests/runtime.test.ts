import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import type { OwnedProcess, ProcessController, ProcessInspection } from "../src/process-manager.js";
import { forgeProcessArguments, healthProbeAddress, readinessProbePath, reconcileExistingRegistry, type RuntimeReconciliationController } from "../src/runtime.js";

function ownedProcess(name: "worker" | "server", pid: number): OwnedProcess {
  return {
    name,
    pid,
    command: `/usr/local/bin/node ${name}.js`,
    startedAt: "2026-08-11T00:00:00.000Z",
    processGroup: pid,
    startTime: "Tue 11 Aug 00:00:00 2026",
    executable: "/usr/local/bin/node",
    argv: ["/usr/local/bin/node", `${name}.js`],
    ready: true,
  };
}

function inspection(owned: OwnedProcess): ProcessInspection {
  return {
    pid: owned.pid,
    command: owned.command,
    processGroup: owned.processGroup!,
    startTime: owned.startTime!,
    executable: owned.executable!,
    argv: owned.argv!,
  };
}

function reconciliationController(process: ProcessController, overrides: Partial<RuntimeReconciliationController> = {}): RuntimeReconciliationController {
  return {
    process,
    async serveIsConfigured() {
      return false;
    },
    async disableServe() {},
    async wait() {},
    ...overrides,
  };
}

test("probes the actual health page for startup readiness", () => {
  expect(readinessProbePath()).toBe("/health");
});

test("development children use tsx only as a TypeScript loader", () => {
  expect(forgeProcessArguments("src/server.ts")).toEqual(["--import", "tsx", "src/server.ts"]);
  expect(forgeProcessArguments("src/worker.ts")).toEqual(["--import", "tsx", "src/worker.ts"]);
});

test("probes the local backend when Tailscale Serve owns HTTPS", () => {
  const config = createTestConfig("/tmp/forge-runtime-test", {
    tailscaleExposure: "serve",
    bindAddress: "127.0.0.1",
    reachableAddress: "https://pro2.tail1234.ts.net:4111",
  });

  expect(healthProbeAddress(config)).toBe("http://127.0.0.1:4111");
});

test("probes the configured address for direct Tailscale HTTP", () => {
  const config = createTestConfig("/tmp/forge-runtime-test", {
    reachableAddress: "http://100.87.170.105:4111",
  });

  expect(healthProbeAddress(config)).toBe("http://100.87.170.105:4111");
});

test("a registry is current when both ready Forge children are live", async () => {
  const worker = ownedProcess("worker", 4101);
  const server = ownedProcess("server", 4102);
  const livePids = new Set([worker.pid, server.pid]);
  const signalled: number[] = [];
  const controller = reconciliationController({
    async inspect(pid) {
      if (!livePids.has(pid)) return undefined;
      return inspection(pid === worker.pid ? worker : server);
    },
    async signal(pid) {
      signalled.push(pid);
      livePids.delete(pid);
    },
  });

  await expect(reconcileExistingRegistry({ version: 1, processes: [worker, server] }, createTestConfig("/tmp/forge-runtime-test"), controller)).resolves.toBe(true);
  expect(signalled).toEqual([]);
});

test("reconciliation ignores a reused PID when the recorded identity is complete", async () => {
  const worker = ownedProcess("worker", 4101);
  const controller = reconciliationController({
    async inspect(pid) {
      if (pid !== worker.pid) return undefined;
      return { ...inspection(worker), command: "/usr/local/bin/node unrelated.js", argv: ["/usr/local/bin/node", "unrelated.js"] };
    },
    async signal() {
      throw new Error("a reused PID must not be signalled");
    },
  });

  await expect(reconcileExistingRegistry(
    { version: 1, processes: [worker] },
    createTestConfig("/tmp/forge-runtime-test", { tailscaleExposure: "direct" }),
    controller,
  )).resolves.toBe(false);
});

test("reconciliation blocks replacement startup when a matching recorded process remains live after SIGTERM", async () => {
  const worker = ownedProcess("worker", 4101);
  const controller = reconciliationController({
    async inspect(pid) {
      return pid === worker.pid ? inspection(worker) : undefined;
    },
    async signal() {},
  });

  await expect(reconcileExistingRegistry({ version: 1, processes: [worker] }, createTestConfig("/tmp/forge-runtime-test"), controller))
    .rejects.toThrow(/could not prove.*stopped/i);
});

test("reconciliation refuses a live legacy process record without exact ownership identity", async () => {
  const worker = ownedProcess("worker", 4101);
  const { executable: _executable, argv: _argv, startTime: _startTime, ...legacyWorker } = worker;
  const controller = reconciliationController({
    async inspect(pid) {
      return pid === worker.pid ? inspection(worker) : undefined;
    },
    async signal() {
      throw new Error("an ownership-ambiguous process must not be signalled");
    },
  });

  await expect(reconcileExistingRegistry({ version: 1, processes: [legacyWorker] }, createTestConfig("/tmp/forge-runtime-test"), controller))
    .rejects.toThrow(/ownership is ambiguous/i);
});

test("reconciliation blocks replacement startup when Tailscale Serve remains configured after cleanup", async () => {
  let disableCalls = 0;
  const controller = reconciliationController({
    async inspect() {
      return undefined;
    },
    async signal() {},
  }, {
    async serveIsConfigured() {
      return true;
    },
    async disableServe() {
      disableCalls += 1;
    },
  });
  const config = createTestConfig("/tmp/forge-runtime-test", { tailscaleExposure: "serve", bindAddress: "127.0.0.1", reachableAddress: "https://pro2.tail1234.ts.net:4111" });

  await expect(reconcileExistingRegistry({
    version: 1,
    processes: [],
    tailscaleServe: { port: config.port, backend: "http://127.0.0.1:4111" },
  }, config, controller)).rejects.toThrow(/could not prove.*serve route stopped/i);

  expect(disableCalls).toBe(1);
});
