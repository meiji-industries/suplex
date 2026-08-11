import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { DockerContainerInspectionSchema } from "./schemas.js";
import { assertLegacyNamespaceProbeOnly, connectTemporal, ensureTemporalFoundation } from "./temporal/service.js";
import { readProcessRegistry, type OwnedProcess, type ProcessRegistry, type TemporalContainer, stopOwnedProcesses, writeProcessRegistry } from "./process-manager.js";
import { configureTailscaleServe, verifyTailscaleServe } from "./tailscale.js";

const execFileAsync = promisify(execFile);

interface DockerMetadata {
  id: string;
  owner: string;
  status: string;
  namespace: string | undefined;
  volumeNames: string[];
}

const legacyTemporalContainerName = "forge-temporal";
const legacyTemporalVolumeName = "forge-temporal-data";

async function inspectTemporalContainer(name: string): Promise<DockerMetadata | undefined> {
  let result: { stdout: string };
  try {
    result = await execFileAsync("docker", ["inspect", "--format", "{{json .}}", name]);
  } catch {
    return undefined;
  }
  const inspection = DockerContainerInspectionSchema.parse(JSON.parse(result.stdout));
  const command = inspection.Config?.Cmd ?? [];
  const namespaceIndex = command.indexOf("--namespace");
  return {
    id: inspection.Id,
    owner: inspection.Config?.Labels?.["com.forge.owner"] ?? "",
    status: inspection.State.Status,
    namespace: namespaceIndex >= 0 ? command[namespaceIndex + 1] : undefined,
    volumeNames: (inspection.Mounts ?? []).flatMap((mount) => mount.Name ? [mount.Name] : []),
  };
}

async function temporalVolumeExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["volume", "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

async function publishedTemporalAddress(name: string): Promise<string> {
  const result = await execFileAsync("docker", ["port", name, "7233/tcp"]);
  const match = /:(\d+)\s*$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`Docker did not publish a host port for ${name}`);
  }
  return `127.0.0.1:${match[1]}`;
}

async function createTemporalContainer(config: ForgeConfig, temporalAddress: string | undefined): Promise<TemporalContainer> {
  const identifiers = runtimeIdentifiers(config.installationId);
  const temporalPort = temporalAddress?.split(":").at(-1);
  let result: { stdout: string };
  try {
    result = await execFileAsync("docker", [
      "run",
      "--detach",
      "--name",
      identifiers.temporalContainerName,
      "--label",
      `com.forge.owner=${identifiers.ownerLabel}`,
      "--label",
      "com.forge.service=temporal",
      "--user",
      "0:0",
      "--publish",
      temporalPort ? `127.0.0.1:${temporalPort}:7233` : "127.0.0.1::7233",
      "--publish",
      temporalPort ? "127.0.0.1:8233:8233" : "127.0.0.1::8233",
      "--volume",
      `${identifiers.temporalVolumeName}:/data`,
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
  } catch (error) {
    await execFileAsync("docker", ["rm", "--force", identifiers.temporalContainerName]).catch(() => undefined);
    throw error;
  }
  const id = result.stdout.trim();
  if (!id) {
    throw new Error("Temporal container did not return an identity");
  }
  try {
    const address = temporalAddress ?? await publishedTemporalAddress(identifiers.temporalContainerName);
    return { id, name: identifiers.temporalContainerName, address };
  } catch (error) {
    await execFileAsync("docker", ["rm", "--force", identifiers.temporalContainerName]).catch(() => undefined);
    throw error;
  }
}

async function startTemporalContainer(config: ForgeConfig): Promise<TemporalContainer> {
  const identifiers = runtimeIdentifiers(config.installationId);
  const existing = await inspectTemporalContainer(identifiers.temporalContainerName);
  if (existing) {
    if (existing.owner !== identifiers.ownerLabel) {
      throw new Error(`Refusing to operate on unowned Docker container ${identifiers.temporalContainerName}`);
    }
    if (existing.status !== "running") {
      await execFileAsync("docker", ["start", identifiers.temporalContainerName]);
    }
    return { id: existing.id, name: identifiers.temporalContainerName, address: await publishedTemporalAddress(identifiers.temporalContainerName) };
  }

  const legacy = await inspectTemporalContainer(legacyTemporalContainerName);
  if (legacy) {
    if (legacy.owner !== "forge") {
      throw new Error(`Refusing to operate on unowned legacy Docker container ${legacyTemporalContainerName}`);
    }
    if (legacy.namespace !== "forge" || !legacy.volumeNames.includes(legacyTemporalVolumeName)) {
      throw new Error(`Refusing legacy Temporal migration without the expected forge namespace and ${legacyTemporalVolumeName} volume`);
    }
    if (legacy.status !== "running") {
      await execFileAsync("docker", ["start", legacyTemporalContainerName]);
    }
    return { id: legacy.id, name: legacyTemporalContainerName, legacy: true, address: config.temporalAddress };
  }

  if (await temporalVolumeExists(legacyTemporalVolumeName)) {
    throw new Error(`Refusing to ignore preserved legacy Temporal volume ${legacyTemporalVolumeName}; inspect or migrate it explicitly`);
  }

  return createTemporalContainer(config, config.temporalAddress);
}

async function migrateLegacyTemporalContainer(config: ForgeConfig, legacy: TemporalContainer): Promise<TemporalContainer> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (await temporalVolumeExists(identifiers.temporalVolumeName)) {
    throw new Error(`Refusing to overwrite existing neutral Temporal volume ${identifiers.temporalVolumeName}; inspect or migrate it explicitly`);
  }
  await execFileAsync("docker", ["volume", "create", identifiers.temporalVolumeName]);
  const destinationCreated = true;
  try {
    await execFileAsync("docker", ["stop", "--time", "10", legacy.id]);
    await execFileAsync("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "--user",
      "0:0",
      "--volume",
      `${legacyTemporalVolumeName}:/from:ro`,
      "--volume",
      `${identifiers.temporalVolumeName}:/to`,
      "temporalio/temporal:latest",
      "-c",
      "cp -a /from/. /to/",
    ]);
    await execFileAsync("docker", ["start", legacy.name]);
    return createTemporalContainer(config, undefined);
  } catch (error) {
    await execFileAsync("docker", ["start", legacy.name]).catch(() => undefined);
    if (destinationCreated) {
      await execFileAsync("docker", ["volume", "rm", identifiers.temporalVolumeName]).catch(() => undefined);
    }
    throw error;
  }
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
    env: {
      ...process.env,
      FORGE_DATA_ROOT: config.dataRoot,
      FORGE_INSTALLATION_ID: config.installationId,
      FORGE_TEMPORAL_ADDRESS: config.temporalAddress,
      FORGE_TEMPORAL_NAMESPACE: config.temporalNamespace,
      FORGE_TASK_QUEUE: config.taskQueue,
      ...(config.temporalNamespace === "forge" ? { FORGE_LEGACY_RUNTIME: "1" } : {}),
    },
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
  const existingRegistry = await readProcessRegistry(`${config.runtimeRoot}/owned-processes.json`).catch(() => undefined);
  if (existingRegistry?.processes.length) {
    throw new Error("Forge already has recorded owned processes; use restart or stop before starting another runtime");
  }
  let temporalContainer: TemporalContainer | undefined;
  let registry: ProcessRegistry | undefined;
  try {
    temporalContainer = await startTemporalContainer(config);
    if (temporalContainer.legacy) {
      const legacyConfig = {
        ...config,
        temporalAddress: temporalContainer.address ?? config.temporalAddress,
        temporalNamespace: "forge",
        taskQueue: "forge",
      };
      await waitForTemporal(legacyConfig);
      const legacyTemporal = await connectTemporal(legacyConfig);
      try {
        await assertLegacyNamespaceProbeOnly(legacyTemporal.client);
      } finally {
        legacyTemporal.connection.close();
      }
      temporalContainer = await migrateLegacyTemporalContainer(config, temporalContainer);
    }
    const runtimeConfig = { ...config, temporalAddress: temporalContainer.address ?? config.temporalAddress };
    await waitForTemporal(runtimeConfig);
    const temporal = await connectTemporal(runtimeConfig);
    try {
      await ensureTemporalFoundation(temporal.connection, runtimeConfig);
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
    const worker = await spawnForgeProcess("worker", "src/worker.ts", runtimeConfig, config.runtimeRoot);
    registry.processes.push(worker.owned);
    const server = await spawnForgeProcess("server", "src/server.ts", runtimeConfig, config.runtimeRoot);
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
    const cleanupRegistry = registry
      ? {
          ...registry,
          ...(registry.temporalContainer?.legacy ? { temporalContainer: undefined } : {}),
        }
      : {
          version: 1 as const,
          processes: [],
          ...(temporalContainer?.legacy ? {} : { temporalContainer }),
        };
    await stopOwnedProcesses(cleanupRegistry).catch(() => undefined);
    await rm(`${config.runtimeRoot}/owned-processes.json`, { force: true });
    throw error;
  }
}
