import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";
import { TemporalInfrastructureError } from "./config.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { DockerContainerInspectionSchema } from "./schemas.js";
import { assertLegacyNamespaceProbeOnly, connectTemporal, ensureTemporalFoundation } from "./temporal/service.js";
import { defaultProcessController, processIdentityMatches, readProcessRegistry, type OwnedProcess, type ProcessController, type ProcessInspection, type ProcessRegistry, type TemporalContainer, stopOwnedProcesses, writeProcessRegistry } from "./process-manager.js";
import { configureTailscaleServe, disableTailscaleServe, isTailscaleServeConfigured, verifyTailscaleServe } from "./tailscale.js";

const execFileAsync = promisify(execFile);

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

export interface TemporalContainerMetadata {
  id: string;
  owner: string;
  status: string;
  namespace: string | undefined;
  volumeNames: string[];
  image: string | undefined;
}

const legacyTemporalContainerName = "forge-temporal";
const legacyTemporalVolumeName = "forge-temporal-data";

async function inspectTemporalContainer(name: string): Promise<TemporalContainerMetadata | undefined> {
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
    image: inspection.Config?.Image,
  };
}

export function temporalContainerCompatibilityError(existing: TemporalContainerMetadata, config: ForgeConfig): string | undefined {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (existing.owner !== identifiers.ownerLabel) {
    return "owner label does not match this Forge installation";
  }
  if (existing.image !== config.temporalImage) {
    return "image does not match the configured digest-pinned Temporal image";
  }
  if (existing.namespace !== config.temporalNamespace) {
    return "namespace does not match the configured Temporal namespace";
  }
  if (!existing.volumeNames.includes(identifiers.temporalVolumeName)) {
    return "volume does not match this Forge installation's Temporal data volume";
  }
  if (existing.status !== "running" && existing.status !== "exited") {
    return `runtime status ${existing.status} is not reusable`;
  }
  return undefined;
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

async function ensureTemporalImageAvailable(image: string): Promise<void> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
    return;
  } catch {
    // The image may not be loaded locally; try to pull the pinned release.
  }
  try {
    await execFileAsync("docker", ["pull", image]);
    await execFileAsync("docker", ["image", "inspect", image]);
  } catch {
    throw new TemporalInfrastructureError(`Temporal image is not available and cannot be pulled: ${image}`);
  }
}

async function createTemporalContainer(config: ForgeConfig, temporalAddress: string | undefined): Promise<TemporalContainer> {
  await ensureTemporalImageAvailable(config.temporalImage);
  const identifiers = runtimeIdentifiers(config.installationId);
  const temporalPort = temporalAddress?.split(":").at(-1);
  const restoredTemporalPath = process.env.FORGE_TEMPORAL_RESTORE_PATH?.trim();
  if (restoredTemporalPath && !(await stat(resolve(restoredTemporalPath))).isDirectory()) {
    throw new Error("FORGE_TEMPORAL_RESTORE_PATH must point to a restored Temporal persistence directory");
  }
  const temporalVolume = restoredTemporalPath ? `${resolve(restoredTemporalPath)}:/data` : `${identifiers.temporalVolumeName}:/data`;
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
      temporalVolume,
      config.temporalImage,
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
    return { id, name: identifiers.temporalContainerName, owner: identifiers.ownerLabel, address, image: config.temporalImage };
  } catch (error) {
    await execFileAsync("docker", ["rm", "--force", identifiers.temporalContainerName]).catch(() => undefined);
    throw error;
  }
}

async function startTemporalContainer(config: ForgeConfig): Promise<TemporalContainer> {
  const identifiers = runtimeIdentifiers(config.installationId);
  const existing = await inspectTemporalContainer(identifiers.temporalContainerName);
  if (existing) {
    const compatibilityError = temporalContainerCompatibilityError(existing, config);
    if (compatibilityError) {
      throw new Error(`Refusing to reuse incompatible Docker container ${identifiers.temporalContainerName}: ${compatibilityError}`);
    }
    if (existing.status !== "running") {
      await execFileAsync("docker", ["start", identifiers.temporalContainerName]);
      const restarted = await inspectTemporalContainer(identifiers.temporalContainerName);
      if (!restarted || temporalContainerCompatibilityError(restarted, config) || restarted.status !== "running") {
        throw new Error(`Temporal container ${identifiers.temporalContainerName} did not restart with the expected Forge runtime identity`);
      }
    }
    return { id: existing.id, name: identifiers.temporalContainerName, owner: existing.owner, address: await publishedTemporalAddress(identifiers.temporalContainerName), image: config.temporalImage };
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
    return { id: legacy.id, name: legacyTemporalContainerName, owner: legacy.owner, legacy: true, address: config.temporalAddress, image: legacy.image };
  }

  if (await temporalVolumeExists(legacyTemporalVolumeName)) {
    throw new Error(`Refusing to ignore preserved legacy Temporal volume ${legacyTemporalVolumeName}; inspect or migrate it explicitly`);
  }

  return createTemporalContainer(config, config.temporalAddress);
}

async function migrateLegacyTemporalContainer(config: ForgeConfig, legacy: TemporalContainer): Promise<TemporalContainer> {
  await ensureTemporalImageAvailable(config.temporalImage);
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
      config.temporalImage,
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

async function waitForRecordedContainerToStop(container: TemporalContainer, controller: RuntimeReconciliationController): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const live = await controller.process.inspectContainer(container.name);
    if (!live || live.id !== container.id || live.status !== "running") {
      return;
    }
    await controller.wait(100);
  }
  throw new Error(`Could not prove recorded Temporal container ${container.name} stopped before replacement startup`);
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

  let containerAlive = false;
  if (registry.temporalContainer && !registry.temporalContainer.legacy) {
    const live = await controller.process.inspectContainer(registry.temporalContainer.name);
    if (live) {
      const expectedOwner = runtimeIdentifiers(config.installationId).ownerLabel;
      if (
        registry.temporalContainer.owner === undefined
        || registry.temporalContainer.image === undefined
        || live.id !== registry.temporalContainer.id
        || live.image !== registry.temporalContainer.image
        || live.owner !== registry.temporalContainer.owner
        || live.owner !== expectedOwner
      ) {
        throw new Error(`Could not reconcile recorded Temporal container ${registry.temporalContainer.name}; ownership is ambiguous`);
      }
      containerAlive = live.status === "running";
    }
  }

  let serveAlive = false;
  if (registry.tailscaleServe) {
    serveAlive = await controller.serveIsConfigured(config);
  }
  const allAlive = hasCompleteRunningProcessSet(registry) && liveProcesses.every((entry) => entry.match);
  const currentTemporalIsVerified = registry.temporalContainer !== undefined
    && !registry.temporalContainer.legacy
    && containerAlive;
  if (allAlive && currentTemporalIsVerified && (!registry.tailscaleServe || serveAlive)) {
    return true;
  }
  for (const entry of liveProcesses) {
    if (entry.match) {
      await controller.process.signal(entry.recorded.pid, "SIGTERM");
      await waitForRecordedProcessToStop(entry.recorded, controller);
    }
  }
  if (containerAlive) {
    await controller.process.stopContainer(registry.temporalContainer!.id);
    await waitForRecordedContainerToStop(registry.temporalContainer!, controller);
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
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    const worker = await spawnForgeProcess("worker", "src/worker.ts", runtimeConfig, config.runtimeRoot);
    registry.processes.push(worker.owned);
    await writeProcessRegistry(`${config.runtimeRoot}/owned-processes.json`, registry);
    const server = await spawnForgeProcess("server", "src/server.ts", runtimeConfig, config.runtimeRoot);
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
