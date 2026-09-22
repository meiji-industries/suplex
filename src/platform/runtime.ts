import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { SuplexConfig } from "./config.js";
import { defaultProcessController, hasCompleteProcessIdentity, ownedProcessIsRunning, processIdentityMatches, readProcessRegistry, type OwnedProcess, type ProcessController, type ProcessInspection, type ProcessRegistry, signalOwnedProcess, stopOwnedProcesses, writeProcessRegistry } from "./process-manager.js";
import { configureTailscaleServe, disableTailscaleServe, isTailscaleServeConfigured, verifyTailscaleServe } from "./tailscale.js";

export interface RuntimeReconciliationController {
  process: ProcessController;
  serveIsConfigured(config: SuplexConfig): Promise<boolean>;
  disableServe(port: number): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

const runtimeReconciliationController: RuntimeReconciliationController = {
  process: defaultProcessController,
  serveIsConfigured: isTailscaleServeConfigured,
  disableServe: disableTailscaleServe,
  wait: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export function healthProbeAddress(config: SuplexConfig): string {
  if (config.tailscaleExposure !== "serve") {
    return config.reachableAddress;
  }
  const host = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
  return `http://${host}:${config.port}`;
}

export function readinessProbePath(): string {
  return "/health";
}

async function waitForHealthPage(config: SuplexConfig, timeoutMs = 30_000): Promise<void> {
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
  throw new Error(`Suplex API did not become reachable at ${probeAddress}; configured external address is ${config.reachableAddress}`);
}

async function waitForProcessIdentity(pid: number, attempts = 10, delayMs = 50): Promise<ProcessInspection | undefined> {
  for (let i = 0; i < attempts; i += 1) {
    const inspection = await defaultProcessController.inspect(pid);
    if (inspection) return inspection;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}

/** The desktop app runs the CLI with cwd set to the packaged app directory, so the entry follows this module rather than the working directory. */
export function supervisorEntryPath(): string {
  const self = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(`updates/supervisor${extname(self)}`, import.meta.url));
}

export function suplexProcessArguments(script: string): string[] {
  return [script];
}

async function spawnSuplexProcess(name: string, script: string, config: SuplexConfig, runtimeRoot: string, foreground: boolean): Promise<{ child: ChildProcess; owned: OwnedProcess }> {
  const command = process.execPath;
  const args = suplexProcessArguments(script);
  const logHandle = foreground ? undefined : await open(`${runtimeRoot}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      SUPLEX_DATA_ROOT: config.dataRoot,
      SUPLEX_INSTALLATION_ID: config.installationId,
    },
    stdio: foreground ? "inherit" : ["ignore", logHandle!.fd, logHandle!.fd],
  });
  child.unref();
  if (!child.pid) {
    await logHandle?.close();
    throw new Error(`Could not start Suplex ${name}`);
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
      command: identity?.command ?? fullCommand,
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

const expectedSuplexProcessNames = new Set(["server"]);

function hasCompleteRunningProcessSet(registry: ProcessRegistry): boolean {
  return registry.processes.length === expectedSuplexProcessNames.size
    && registry.processes.every((process) => process.ready === true && expectedSuplexProcessNames.has(process.name))
    && new Set(registry.processes.map((process) => process.name)).size === expectedSuplexProcessNames.size;
}

async function waitForRecordedProcessToStop(recorded: OwnedProcess, controller: RuntimeReconciliationController): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!await ownedProcessIsRunning(recorded, controller.process)) {
      return;
    }
    await controller.wait(100);
  }
  throw new Error(`Could not prove recorded Suplex process ${recorded.name} (${recorded.pid}) stopped before replacement startup`);
}

async function waitForRecordedServeToStop(config: SuplexConfig, controller: RuntimeReconciliationController): Promise<void> {
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
  config: SuplexConfig,
  controller: RuntimeReconciliationController = runtimeReconciliationController,
): Promise<boolean> {
  const liveProcesses = await Promise.all(
    registry.processes.map(async (recorded) => {
      const live = await controller.process.inspect(recorded.pid);
      return { recorded, live, match: live !== undefined && processIdentityMatches(recorded, live) };
    }),
  );
  const ambiguousProcess = liveProcesses.find((entry) => (
    entry.live !== undefined
    && !entry.match
    && !hasCompleteProcessIdentity(entry.recorded)
  ));
  if (ambiguousProcess) {
    throw new Error(`Could not reconcile recorded Suplex process ${ambiguousProcess.recorded.name}; ownership is ambiguous`);
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
      await signalOwnedProcess(entry.recorded, "SIGTERM", controller.process);
      await waitForRecordedProcessToStop(entry.recorded, controller);
    }
  }
  if (serveAlive) {
    await controller.disableServe(registry.tailscaleServe!.port);
    await waitForRecordedServeToStop(config, controller);
  }
  return false;
}

export async function startSuplex(config: SuplexConfig, foreground: boolean): Promise<ProcessRegistry> {
  await mkdir(config.runtimeRoot, { recursive: true });
  let existingRegistry: ProcessRegistry | undefined;
  try {
    existingRegistry = await readProcessRegistry(`${config.runtimeRoot}/owned-processes.json`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Suplex owned-process registry could not be read safely; inspect it before starting another runtime", { cause: error });
    }
  }
  if (existingRegistry && await reconcileExistingRegistry(existingRegistry, config)) {
    if (foreground) {
      const removeShutdownListeners = await waitForForegroundShutdown();
      try {
        await stopOwnedProcesses(existingRegistry);
        await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
      } finally {
        removeShutdownListeners();
      }
    }
    return existingRegistry;
  }
  let registry: ProcessRegistry | undefined;
  try {
    registry = {
      version: 1,
      processes: [],
      ...(config.tailscaleExposure === "serve" ? {
        tailscaleServe: { port: config.port, backend: `http://${config.bindAddress}:${config.port}` },
      } : {}),
    };
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    const server = await spawnSuplexProcess("server", supervisorEntryPath(), config, config.runtimeRoot, foreground);
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
      const removeShutdownListeners = await waitForForegroundShutdown();
      try {
        await stopOwnedProcesses(registry);
        await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
      } finally {
        removeShutdownListeners();
      }
    }
    return registry;
  } catch (error) {
    const cleanupRegistry = registry ?? { version: 1 as const, processes: [] };
    try {
      await reconcileExistingRegistry(cleanupRegistry, config);
      await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
    } catch (cleanupError) {
      const startupMessage = error instanceof Error ? error.message : "unknown startup error";
      throw new Error(`Suplex startup failed (${startupMessage}) and cleanup could not be proven; the owned-process registry was preserved`, { cause: cleanupError });
    }
    throw error;
  }
}

async function waitForForegroundShutdown(): Promise<() => void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(keepAlive);
      resolve(() => {
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
      });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
