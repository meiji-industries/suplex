import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";

import type { ForgeConfig } from "./config.js";
import { connectTemporal, ensureTemporalFoundation } from "./temporal/service.js";
import { defaultProcessController, processIdentityMatches, readProcessRegistry, type OwnedProcess, type ProcessController, type ProcessInspection, type ProcessRegistry, stopOwnedProcesses, writeProcessRegistry } from "./process-manager.js";
import { configureTailscaleServe, disableTailscaleServe, isTailscaleServeConfigured, verifyTailscaleServe } from "./tailscale.js";

export interface RuntimeReconciliationController {
  process: ProcessController;
  serveIsConfigured(config: ForgeConfig): Promise<boolean>;
  disableServe(port: number): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

const runtimeReconciliationController: RuntimeReconciliationController = {
  process: defaultProcessController,
  serveIsConfigured: isTailscaleServeConfigured,
  disableServe: disableTailscaleServe,
  wait: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function waitForTemporal(config: ForgeConfig, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const temporal = await connectTemporal(config);
      temporal.connection.close();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Temporal did not become reachable: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

export function healthProbeAddress(config: ForgeConfig): string {
  if (config.tailscaleExposure !== "serve") {
    return config.reachableAddress;
  }
  const host = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
  return `http://${host}:${config.port}`;
}

export function readinessProbePath(): string {
  return "/health";
}

async function waitForHealthPage(config: ForgeConfig, timeoutMs = 30_000): Promise<void> {
  const probeAddress = healthProbeAddress(config);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${probeAddress}${readinessProbePath()}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      const redirectedToAuthentication = response.status >= 300
        && response.status < 400
        && (response.headers.get("location") ?? "").startsWith("/auth");
      if (response.ok || redirectedToAuthentication) {
        return;
      }
    } catch {
      // The API may still be binding to the configured Tailscale address.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Forge API did not become reachable at ${probeAddress}; configured external address is ${config.reachableAddress}`);
}

async function waitForProcessIdentity(pid: number, attempts = 10, delayMs = 50): Promise<ProcessInspection | undefined> {
  for (let i = 0; i < attempts; i += 1) {
    const inspection = await defaultProcessController.inspect(pid);
    if (inspection) return inspection;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}

async function spawnForgeProcess(name: string, script: string, config: ForgeConfig, runtimeRoot: string, foreground: boolean): Promise<{ child: ChildProcess; owned: OwnedProcess }> {
  const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url);
  const command = process.execPath;
  const args = [tsxCli.pathname, script];
  const logHandle = foreground ? undefined : await open(`${runtimeRoot}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      FORGE_DATA_ROOT: config.dataRoot,
      FORGE_INSTALLATION_ID: config.installationId,
      FORGE_TEMPORAL_TARGET: config.temporalTarget,
      FORGE_TEMPORAL_ADDRESS: config.temporalAddress,
      FORGE_TEMPORAL_NAMESPACE: config.temporalNamespace,
      FORGE_TEMPORAL_API_KEY: config.temporalApiKey,
      FORGE_TASK_QUEUE: config.taskQueue,
    },
    stdio: foreground ? "inherit" : ["ignore", logHandle!.fd, logHandle!.fd],
  });
  child.unref();
  if (!child.pid) {
    await logHandle?.close();
    throw new Error(`Could not start Forge ${name}`);
  }
  await logHandle?.close();
  const identity = await waitForProcessIdentity(child.pid);
  const startedAt = new Date().toISOString();
  const startId = randomUUID();
  const fullCommand = [command, ...args].join(" ");
  return {
    child,
    owned: {
      name,
      pid: child.pid,
      command: fullCommand,
      startedAt,
      startId,
      processGroup: identity?.processGroup ?? child.pid,
      startTime: identity?.startTime ?? startedAt,
      executable: identity?.executable ?? command,
      argv: identity?.argv ?? [command, ...args],
      ready: false,
    },
  };
}

const expectedForgeProcessNames = new Set(["worker", "server"]);

function hasCompleteRunningProcessSet(registry: ProcessRegistry): boolean {
  return registry.processes.length === expectedForgeProcessNames.size
    && registry.processes.every((process) => process.ready === true && expectedForgeProcessNames.has(process.name))
    && new Set(registry.processes.map((process) => process.name)).size === expectedForgeProcessNames.size;
}

async function waitForRecordedProcessToStop(recorded: OwnedProcess, controller: RuntimeReconciliationController): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const live = await controller.process.inspect(recorded.pid);
    if (!live || !processIdentityMatches(recorded, live)) {
      return;
    }
    await controller.wait(100);
  }
  throw new Error(`Could not prove recorded Forge process ${recorded.name} (${recorded.pid}) stopped before replacement startup`);
}

async function waitForRecordedServeToStop(config: ForgeConfig, controller: RuntimeReconciliationController): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!await controller.serveIsConfigured(config)) {
      return;
    }
    await controller.wait(100);
  }
  throw new Error("Could not prove recorded Tailscale Serve route stopped before replacement startup");
}

export async function reconcileExistingRegistry(
  registry: ProcessRegistry,
  config: ForgeConfig,
  controller: RuntimeReconciliationController = runtimeReconciliationController,
): Promise<boolean> {
  const liveProcesses = await Promise.all(
    registry.processes.map(async (recorded) => {
      const live = await controller.process.inspect(recorded.pid);
      return { recorded, live, match: live !== undefined && processIdentityMatches(recorded, live) };
    }),
  );
  const ambiguousProcess = liveProcesses.find((entry) => entry.live !== undefined && !entry.match);
  if (ambiguousProcess) {
    throw new Error(`Could not reconcile recorded Forge process ${ambiguousProcess.recorded.name}; ownership is ambiguous`);
  }

  let serveAlive = false;
  if (registry.tailscaleServe) {
    serveAlive = await controller.serveIsConfigured(config);
  }
  const allAlive = hasCompleteRunningProcessSet(registry) && liveProcesses.every((entry) => entry.match);
  if (allAlive && (!registry.tailscaleServe || serveAlive)) {
    return true;
  }
  for (const entry of liveProcesses) {
    if (entry.match) {
      await controller.process.signal(entry.recorded.pid, "SIGTERM");
      await waitForRecordedProcessToStop(entry.recorded, controller);
    }
  }
  if (serveAlive) {
    await controller.disableServe(registry.tailscaleServe!.port);
    await waitForRecordedServeToStop(config, controller);
  }
  return false;
}

export async function startForge(config: ForgeConfig, foreground: boolean): Promise<ProcessRegistry> {
  await mkdir(config.runtimeRoot, { recursive: true });
  let existingRegistry: ProcessRegistry | undefined;
  try {
    existingRegistry = await readProcessRegistry(`${config.runtimeRoot}/owned-processes.json`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Forge owned-process registry could not be read safely; inspect it before starting another runtime", { cause: error });
    }
  }
  if (existingRegistry && await reconcileExistingRegistry(existingRegistry, config)) {
    throw new Error("Forge already has recorded owned processes running; use restart or stop before starting another runtime");
  }
  let registry: ProcessRegistry | undefined;
  try {
    await waitForTemporal(config);
    const temporal = await connectTemporal(config);
    try {
      await ensureTemporalFoundation(temporal.connection, config);
    } finally {
      temporal.connection.close();
    }

    registry = {
      version: 1,
      processes: [],
      ...(config.tailscaleExposure === "serve" ? {
        tailscaleServe: { port: config.port, backend: `http://${config.bindAddress}:${config.port}` },
      } : {}),
    };
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    const worker = await spawnForgeProcess("worker", "src/worker.ts", config, config.runtimeRoot, foreground);
    registry.processes.push(worker.owned);
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    const server = await spawnForgeProcess("server", "src/server.ts", config, config.runtimeRoot, foreground);
    registry.processes.push(server.owned);
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    if (config.tailscaleExposure === "serve") {
      await configureTailscaleServe(config);
      await verifyTailscaleServe(config);
      await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    }
    await waitForHealthPage(config);
    for (const process of registry.processes) {
      process.ready = true;
    }
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    if (foreground) {
      await new Promise<void>((resolve) => {
        const shutdown = (): void => resolve();
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
      });
      await stopOwnedProcesses(registry);
      await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
    }
    return registry;
  } catch (error) {
    const cleanupRegistry = registry ?? { version: 1 as const, processes: [] };
    try {
      await reconcileExistingRegistry(cleanupRegistry, config);
      await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
    } catch (cleanupError) {
      const startupMessage = error instanceof Error ? error.message : "unknown startup error";
      throw new Error(`Forge startup failed (${startupMessage}) and cleanup could not be proven; the owned-process registry was preserved`, { cause: cleanupError });
    }
    throw error;
  }
}
