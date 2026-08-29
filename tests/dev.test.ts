import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { acquireDevLock, forgeEnvironment, inspectDevStatus, readDevControlRequest, requestDevControl, resolveDevPorts, superviseDevStack } from "../scripts/dev.js";
import { isForgeDevelopmentCommand, parseProcessList } from "../scripts/down.js";
import type { OwnedProcess, ProcessController, ProcessInspection } from "../src/process-manager.js";
import { jsonRequired } from "../src/task-utils.js";

test("development uses the configured repository root instead of the checkout", () => {
  expect(forgeEnvironment({ engine: 7233, engineUi: 8233 })).not.toHaveProperty("FORGE_REPOSITORY_ROOT");
});

function makeOwner(pid = 4101): OwnedProcess {
  return {
    name: "dev-supervisor",
    pid,
    command: "/usr/local/bin/node --import tsx scripts/dev.ts",
    startedAt: "2026-08-12T00:00:00.000Z",
    processGroup: pid,
    startTime: "Wed Aug 12 00:00:00 2026",
    executable: "/usr/local/bin/node",
    argv: ["/usr/local/bin/node", "--import", "tsx", "scripts/dev.ts"],
    ready: true,
  };
}

function makeInspection(owner: OwnedProcess): ProcessInspection {
  return {
    pid: owner.pid,
    command: owner.command,
    processGroup: owner.processGroup!,
    startTime: owner.startTime!,
    executable: owner.executable!,
    argv: owner.argv!,
  };
}

function controller(overrides: Partial<ProcessController> = {}): ProcessController {
  return {
    async inspect() {
      return undefined;
    },
    async signal() {},
    ...overrides,
  };
}

async function withRuntime(run: (runtimeRoot: string) => Promise<void>): Promise<void> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "forge-dev-supervisor-test-"));
  try {
    await run(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function writeOwner(runtimeRoot: string, owner: OwnedProcess): Promise<string> {
  const lockPath = join(runtimeRoot, "dev.lock");
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner));
  await writeFile(join(lockPath, "control.version"), "1\n");
  return lockPath;
}

async function waitForValue<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test process state");
}

test("reserves a Conductor port block without changing standalone defaults", () => {
  expect(resolveDevPorts(undefined)).toEqual({ engine: 7233, engineUi: 8233 });
  expect(resolveDevPorts("55000")).toEqual({ forge: 55000, engine: 55001, engineUi: 55002 });
  expect(() => resolveDevPorts("65534")).toThrow(/three valid ports/);
});

test("recognizes only Forge development process commands", () => {
  expect(isForgeDevelopmentCommand("engine server start-dev --port 7233 --db-filename .forge/dev/engine.db --namespace forge-dev")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node --import tsx scripts/dev.ts")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node --import tsx src/cli.ts start --foreground")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node /repo/node_modules/tsx/dist/cli.mjs watch --clear-screen=false src/server.ts")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node --import tsx scripts/dev.ts restart")).toBe(false);
  expect(isForgeDevelopmentCommand("engine server start-dev --db-filename /tmp/other.db")).toBe(false);
  expect(isForgeDevelopmentCommand("/opt/node /other/server.ts")).toBe(false);
});

test("parses pid, process group, and complete command from ps output", () => {
  expect(parseProcessList("  41   39 engine server start-dev --port 7233\n  52   52 node --import tsx scripts/dev.ts\n")).toEqual([
    { pid: 41, processGroup: 39, command: "engine server start-dev --port 7233" },
    { pid: 52, processGroup: 52, command: "node --import tsx scripts/dev.ts" },
  ]);
});

test("malformed supervisor ownership is orphaned instead of reclaimed", async () => {
  await withRuntime(async (runtimeRoot) => {
    const lockPath = join(runtimeRoot, "dev.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), "null\n");
    await expect(inspectDevStatus(runtimeRoot, controller())).resolves.toEqual({ state: "orphaned" });
  });
});

test("only a positively dead supervisor lock is reclaimed", async () => {
  await withRuntime(async (runtimeRoot) => {
    const oldOwner = makeOwner();
    await writeOwner(runtimeRoot, oldOwner);
    const processController = controller({
      async inspect(pid) {
        return pid === process.pid ? makeInspection(makeOwner(process.pid)) : undefined;
      },
      async isProcessGroupAlive(processGroup) {
        return processGroup !== oldOwner.processGroup;
      },
    });

    const lock = await acquireDevLock(runtimeRoot, processController);
    expect(lock).toBeDefined();
    expect(jsonRequired(await readFile(join(runtimeRoot, "dev.lock", "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
    await lock!.release();
  });
});

test("cooperative control gives stop precedence and never kills on timeout", async () => {
  await withRuntime(async (runtimeRoot) => {
    const owner = makeOwner();
    const lockPath = await writeOwner(runtimeRoot, owner);
    await writeFile(join(lockPath, "restart.request"), "restart");
    await writeFile(join(lockPath, "stop.request"), "stop");
    await expect(readDevControlRequest(lockPath)).resolves.toBe("stop");

    await rm(join(lockPath, "stop.request"));
    let signals = 0;
    const processController = controller({
      async inspect(pid) { return pid === owner.pid ? makeInspection(owner) : undefined; },
      async isProcessGroupAlive() { return true; },
      async signal() { signals += 1; },
    });
    await expect(requestDevControl("restart", runtimeRoot, { controller: processController, pollMs: 1, timeoutMs: 5 }))
      .rejects.toThrow(/timed out/i);
    expect(await readDevControlRequest(lockPath)).toBe("restart");
    expect(signals).toBe(0);

    await rm(join(lockPath, "restart.request"));
    await rm(join(lockPath, "control.version"));
    await expect(requestDevControl("restart", runtimeRoot, { controller: processController }))
      .rejects.toThrow(/predates shared control/i);
    await expect(readDevControlRequest(lockPath)).resolves.toBeUndefined();
  });
});

test("concurrent restarts coalesce, preserve Engine, and fail closed", async () => {
  await withRuntime(async (runtimeRoot) => {
    const processController = controller({
      async inspect(pid) {
        return pid === process.pid ? makeInspection(makeOwner(process.pid)) : undefined;
      },
      async isProcessGroupAlive() { return true; },
    });
    const lock = await acquireDevLock(runtimeRoot, processController);
    if (!lock) throw new Error("test supervisor lock was not acquired");
    const lockPath = lock.path;
    const serviceScript = join(runtimeRoot, "fake-service.mjs");
    await writeFile(serviceScript, `
      import { access, appendFile, rm, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const [kind, runtimeRoot] = process.argv.slice(2);
      const registryPath = join(runtimeRoot, "owned-processes.json");
      if (kind === "engine") await writeFile(join(runtimeRoot, "engine.pid"), String(process.pid));
      if (kind === "forge") {
        await appendFile(join(runtimeRoot, "forge.starts"), String(process.pid) + "\\n");
        try {
          await access(join(runtimeRoot, "fail-next-forge"));
          process.exit(7);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 75));
        await writeFile(registryPath, JSON.stringify({ version: 1, processes: [
          { name: "worker", pid: process.pid, command: "fake worker", startedAt: new Date().toISOString(), ready: true },
          { name: "server", pid: process.pid + 1, command: "fake server", startedAt: new Date().toISOString(), ready: true }
        ] }));
      }
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        if (kind === "forge") await rm(registryPath, { force: true });
        process.exit(0);
      };
      process.on("SIGINT", () => void stop());
      process.on("SIGTERM", () => void stop());
      setInterval(() => undefined, 1000);
    `);

    let supervisor: Promise<number> | undefined;
    try {
      supervisor = superviseDevStack({ engine: 1, engineUi: 2 }, runtimeRoot, {
        engine: { command: process.execPath, args: [serviceScript, "engine", runtimeRoot] },
        forge: { command: process.execPath, args: [serviceScript, "forge", runtimeRoot] },
        logPath: join(runtimeRoot, "dev.log"),
        pollMs: 10,
        restartTimeoutMs: 3_000,
      });
      const readPids = async (): Promise<number[] | undefined> => {
        try {
          const registry = jsonRequired(await readFile(join(runtimeRoot, "owned-processes.json"), "utf8")) as { processes: Array<{ pid: number }> };
          return registry.processes.map((process) => process.pid).sort((left, right) => left - right);
        } catch {
          return undefined;
        }
      };
      const firstPids = await waitForValue(readPids);
      const enginePid = await waitForValue(async () => {
        try {
          return Number(await readFile(join(runtimeRoot, "engine.pid"), "utf8"));
        } catch {
          return undefined;
        }
      });

      const firstRestart = requestDevControl("restart", runtimeRoot, { controller: processController, pollMs: 10, timeoutMs: 3_000 });
      await waitForValue(async () => await readPids() === undefined ? true : undefined);
      const joinedRestart = requestDevControl("restart", runtimeRoot, { controller: processController, pollMs: 10, timeoutMs: 3_000 });
      await expect(Promise.all([firstRestart, joinedRestart])).resolves.toEqual([
        expect.objectContaining({ state: "ready" }),
        expect.objectContaining({ state: "ready" }),
      ]);
      const secondPids = await waitForValue(readPids);
      expect(secondPids).not.toEqual(firstPids);
      expect(Number(await readFile(join(runtimeRoot, "engine.pid"), "utf8"))).toBe(enginePid);
      expect((await readFile(join(runtimeRoot, "forge.starts"), "utf8")).trim().split("\n")).toHaveLength(2);

      await writeFile(join(runtimeRoot, "fail-next-forge"), "fail\n");
      await writeFile(join(lockPath, "restart.request"), "restart\n");
      await expect(supervisor).resolves.toBe(1);
      expect((await readFile(join(runtimeRoot, "forge.starts"), "utf8")).trim().split("\n")).toHaveLength(3);
    } finally {
      await writeFile(join(lockPath, "stop.request"), "stop\n").catch(() => undefined);
      await supervisor;
      await lock.release();
    }
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inspectDevStatus(runtimeRoot, processController)).resolves.toEqual({ state: "stopped" });
  });
});

test("a cooperative stop waits for children and releases ownership", async () => {
  await withRuntime(async (runtimeRoot) => {
    const processController = controller({
      async inspect(pid) {
        return pid === process.pid ? makeInspection(makeOwner(process.pid)) : undefined;
      },
      async isProcessGroupAlive() { return true; },
    });
    const lock = await acquireDevLock(runtimeRoot, processController);
    if (!lock) throw new Error("test supervisor lock was not acquired");
    const forgeScript = `
      import { rm, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const root = process.argv[1];
      const registry = join(root, "owned-processes.json");
      await writeFile(registry, JSON.stringify({ version: 1, processes: [
        { name: "worker", pid: process.pid, command: "fake worker", startedAt: new Date().toISOString(), ready: true },
        { name: "server", pid: process.pid + 1, command: "fake server", startedAt: new Date().toISOString(), ready: true }
      ] }));
      process.on("SIGTERM", () => void rm(registry, { force: true }).then(() => process.exit(0)));
      setInterval(() => undefined, 1000);
    `;
    const supervisor = (async () => {
      try {
        return await superviseDevStack({ engine: 1, engineUi: 2 }, runtimeRoot, {
          engine: { command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] },
          forge: { command: process.execPath, args: ["--input-type=module", "-e", forgeScript, runtimeRoot] },
          logPath: join(runtimeRoot, "dev.log"),
          pollMs: 10,
        });
      } finally {
        await lock.release();
      }
    })();

    try {
      await waitForValue(async () => (await inspectDevStatus(runtimeRoot, processController)).state === "ready" ? true : undefined);
      const [status, exitCode] = await Promise.all([
        requestDevControl("stop", runtimeRoot, { controller: processController, pollMs: 10, timeoutMs: 3_000 }),
        supervisor,
      ]);
      expect(status).toEqual({ state: "stopped" });
      expect(exitCode).toBe(0);
    } finally {
      await writeFile(join(lock.path, "stop.request"), "stop\n").catch(() => undefined);
      await supervisor;
    }
  });
});
