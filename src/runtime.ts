import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";
import { connectTemporal, ensureTemporalFoundation } from "./temporal/service.js";
import { type OwnedProcess, type ProcessRegistry, type TemporalContainer, stopOwnedProcesses, writeProcessRegistry } from "./process-manager.js";
import { configureTailscaleServe, verifyTailscaleServe } from "./tailscale.js";

const execFileAsync = promisify(execFile);

interface DockerMetadata {
  id: string;
  owner: string;
  status: string;
}

const temporalContainerName = "forge-temporal";

async function inspectTemporalContainer(): Promise<DockerMetadata | undefined> {
  try {
    const result = await execFileAsync("docker", ["inspect", "--format", "{{.Id}} {{index .Config.Labels \"com.forge.owner\"}} {{.State.Status}}", temporalContainerName]);
    const [id, owner, status] = result.stdout.trim().split(/\s+/, 3);
    if (!id) {
      return undefined;
    }
    return { id, owner: owner ?? "", status: status ?? "" };
  } catch {
    return undefined;
  }
}

async function startTemporalContainer(config: ForgeConfig): Promise<TemporalContainer> {
  const existing = await inspectTemporalContainer();
  if (existing) {
    if (existing.owner !== "forge") {
      throw new Error(`Refusing to operate on unowned Docker container ${temporalContainerName}`);
    }
    if (existing.status === "running") {
      return { id: existing.id, name: temporalContainerName };
    }
    await execFileAsync("docker", ["rm", "--force", temporalContainerName]);
  }

  const result = await execFileAsync("docker", [
    "run",
    "--detach",
    "--name",
    temporalContainerName,
    "--label",
    "com.forge.owner=forge",
    "--label",
    "com.forge.service=temporal",
    "--user",
    "0:0",
    "--publish",
    "127.0.0.1:7233:7233",
    "--publish",
    "127.0.0.1:8233:8233",
    "--volume",
    "forge-temporal-data:/data",
    "temporalio/temporal:latest",
    "server",
    "start-dev",
    "--ip",
    "0.0.0.0",
    "--namespace",
    config.temporalNamespace,
    "--db-filename",
    "/data/temporal.db",
  ]);
  const id = result.stdout.trim();
  if (!id) {
    throw new Error("Temporal container did not return an identity");
  }
  return { id, name: temporalContainerName };
}

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

async function waitForHealthPage(config: ForgeConfig, timeoutMs = 30_000): Promise<void> {
  const probeAddress = healthProbeAddress(config);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${probeAddress}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The API may still be binding to the configured Tailscale address.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Forge API did not become reachable at ${probeAddress}; configured external address is ${config.reachableAddress}`);
}

async function spawnForgeProcess(name: string, script: string, config: ForgeConfig, runtimeRoot: string): Promise<{ child: ChildProcess; owned: OwnedProcess }> {
  const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url);
  const command = process.execPath;
  const args = [tsxCli.pathname, script];
  const logHandle = await open(`${runtimeRoot}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, FORGE_DATA_ROOT: config.dataRoot },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  if (!child.pid) {
    await logHandle.close();
    throw new Error(`Could not start Forge ${name}`);
  }
  await logHandle.close();
  return {
    child,
    owned: {
      name,
      pid: child.pid,
      command: [command, ...args].join(" "),
      startedAt: new Date().toISOString(),
    },
  };
}

export async function startForge(config: ForgeConfig, foreground: boolean): Promise<ProcessRegistry> {
  await mkdir(config.runtimeRoot, { recursive: true });
  let temporalContainer: TemporalContainer | undefined;
  let registry: ProcessRegistry | undefined;
  try {
    temporalContainer = await startTemporalContainer(config);
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
      temporalContainer,
      ...(config.tailscaleExposure === "serve" ? {
        tailscaleServe: { port: config.port, backend: `http://${config.bindAddress}:${config.port}` },
      } : {}),
    };
    const worker = await spawnForgeProcess("worker", "src/worker.ts", config, config.runtimeRoot);
    registry.processes.push(worker.owned);
    const server = await spawnForgeProcess("server", "src/server.ts", config, config.runtimeRoot);
    registry.processes.push(server.owned);
    if (config.tailscaleExposure === "serve") {
      await configureTailscaleServe(config);
      await verifyTailscaleServe(config);
    }
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    await waitForHealthPage(config);
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
    const cleanupRegistry = registry ?? {
      version: 1 as const,
      processes: [],
      temporalContainer,
    };
    await stopOwnedProcesses(cleanupRegistry).catch(() => undefined);
    await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
    throw error;
  }
}
