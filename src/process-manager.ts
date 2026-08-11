import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { DockerContainerInspectionSchema, ProcessRegistrySchema, TailscaleServeStatusSchema } from "./schemas.js";

const execFileAsync = promisify(execFile);

export interface OwnedProcess {
  name: string;
  pid: number;
  command: string;
  startedAt: string;
  processGroup?: number | undefined;
  startTime?: string | undefined;
  startId?: string | undefined;
  executable?: string | undefined;
  argv?: string[] | undefined;
  ready?: boolean | undefined;
}

export interface TemporalContainer {
  id: string;
  name: string;
  owner?: string | undefined;
  legacy?: boolean | undefined;
  address?: string | undefined;
  image?: string | undefined;
}

export interface TailscaleServe {
  port: number;
  backend: string;
}

export interface ProcessRegistry {
  version: 1;
  processes: OwnedProcess[];
  temporalContainer?: TemporalContainer | undefined;
  tailscaleServe?: TailscaleServe | undefined;
}

export interface ProcessInspection {
  pid: number;
  command: string;
  executable: string;
  argv: string[];
  processGroup: number;
  startTime: string;
}

export interface ContainerInspection {
  id: string;
  name: string;
  image: string;
  owner: string;
  status: string;
}

export interface ProcessController {
  inspect(pid: number): Promise<ProcessInspection | undefined>;
  inspectContainer(name: string): Promise<ContainerInspection | undefined>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  signalGroup?: (processGroup: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  isProcessGroupAlive?: (processGroup: number) => Promise<boolean>;
  stopContainer(id: string): Promise<void>;
  stopServe?: (serve: TailscaleServe) => Promise<void>;
  isServeConfigured?: (serve: TailscaleServe) => Promise<boolean>;
}

export interface StopReport {
  stopped: number[];
  containersStopped: string[];
  skipped: Array<{ pid: number; reason: "missing" | "identity-mismatch" | "ownership-ambiguous" }>;
  ambiguousContainers: Array<{ id: string; reason: "missing" | "identity-mismatch" | "ownership-ambiguous" }>;
}

const shutdownVerificationAttempts = 10;
const shutdownVerificationDelayMs = 100;
const processInspectionAttempts = 3;
const processInspectionRetryDelayMs = 10;

function normalizeArgv(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

async function processField(pid: number, field: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", field]);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function inspectProcessOnce(pid: number): Promise<ProcessInspection | undefined> {
  const [command, pgidValue, startTime, executable] = await Promise.all([
    processField(pid, "command="),
    processField(pid, "pgid="),
    processField(pid, "lstart="),
    processField(pid, "comm="),
  ]);
  if (!command || !pgidValue || !startTime || !executable) return undefined;
  const processGroup = Number(pgidValue);
  if (!Number.isSafeInteger(processGroup) || processGroup <= 0) return undefined;
  return { pid, command, executable, argv: normalizeArgv(command), processGroup, startTime };
}

export const defaultProcessController: ProcessController = {
  async inspect(pid) {
    for (let attempt = 0; attempt < processInspectionAttempts; attempt += 1) {
      const inspection = await inspectProcessOnce(pid);
      if (inspection) return inspection;
      if (attempt + 1 < processInspectionAttempts) {
        await new Promise((resolve) => setTimeout(resolve, processInspectionRetryDelayMs));
      }
    }
    return undefined;
  },
  async inspectContainer(name) {
    try {
      const result = await execFileAsync("docker", ["inspect", "--format", "{{json .}}", name]);
      const inspection = DockerContainerInspectionSchema.parse(JSON.parse(result.stdout));
      return {
        id: inspection.Id,
        name,
        image: inspection.Config?.Image ?? "",
        owner: inspection.Config?.Labels?.["com.forge.owner"] ?? "",
        status: inspection.State.Status,
      };
    } catch {
      return undefined;
    }
  },
  async signal(pid, signal) {
    process.kill(pid, signal);
  },
  async signalGroup(processGroup, signal) {
    process.kill(-processGroup, signal);
  },
  async isProcessGroupAlive(processGroup) {
    try {
      process.kill(-processGroup, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  },
  async stopContainer(id) {
    await execFileAsync("docker", ["stop", "--time", "10", id]);
  },
  async stopServe(serve) {
    await execFileAsync("tailscale", ["serve", `--https=${serve.port}`, "off"]);
  },
  async isServeConfigured(serve) {
    const result = await execFileAsync("tailscale", ["serve", "status", "--json"], { maxBuffer: 64 * 1024 });
    const status = TailscaleServeStatusSchema.parse(JSON.parse(result.stdout));
    const route = Object.keys(status.Web ?? {}).find((key) => key.endsWith(`:${serve.port}`));
    const proxy = route ? status.Web?.[route]?.Handlers?.["/"]?.Proxy : undefined;
    return proxy === serve.backend;
  },
};

export function processIdentityMatches(owned: OwnedProcess, inspection: ProcessInspection): boolean {
  if (
    owned.processGroup === undefined
    || owned.startTime === undefined
    || owned.executable === undefined
    || owned.argv === undefined
  ) {
    return false;
  }
  return inspection.pid === owned.pid
    && inspection.processGroup === owned.processGroup
    && inspection.command === owned.command
    && inspection.startTime === owned.startTime
    && inspection.executable === owned.executable
    && inspection.argv.length === owned.argv.length
    && inspection.argv.every((argument, index) => argument === owned.argv![index]);
}

export function hasCompleteProcessIdentity(owned: OwnedProcess): boolean {
  return owned.processGroup !== undefined
    && owned.startTime !== undefined
    && owned.executable !== undefined
    && owned.argv !== undefined;
}

export async function signalOwnedProcess(
  owned: OwnedProcess,
  signal: "SIGTERM" | "SIGKILL",
  controller: ProcessController,
): Promise<void> {
  if (owned.processGroup !== undefined && controller.signalGroup) {
    await controller.signalGroup(owned.processGroup, signal);
    return;
  }
  await controller.signal(owned.pid, signal);
}

export async function ownedProcessIsRunning(owned: OwnedProcess, controller: ProcessController): Promise<boolean> {
  const inspection = await controller.inspect(owned.pid);
  if (inspection && processIdentityMatches(owned, inspection)) return true;
  if (owned.processGroup !== undefined && controller.isProcessGroupAlive) {
    return controller.isProcessGroupAlive(owned.processGroup);
  }
  return false;
}

async function waitForOwnedProcessToStop(owned: OwnedProcess, controller: ProcessController): Promise<void> {
  for (let attempt = 0; attempt < shutdownVerificationAttempts; attempt += 1) {
    if (!await ownedProcessIsRunning(owned, controller)) return;
    await new Promise((resolve) => setTimeout(resolve, shutdownVerificationDelayMs));
  }
  throw new Error(`Could not prove recorded Forge process ${owned.name} (${owned.pid}) stopped before removing its registry`);
}

async function waitForOwnedContainerToStop(container: TemporalContainer, controller: ProcessController): Promise<void> {
  for (let attempt = 0; attempt < shutdownVerificationAttempts; attempt += 1) {
    const inspection = await controller.inspectContainer(container.name);
    if (!inspection || inspection.id !== container.id || inspection.status === "exited") return;
    await new Promise((resolve) => setTimeout(resolve, shutdownVerificationDelayMs));
  }
  throw new Error(`Could not prove recorded Temporal container ${container.name} stopped before removing its registry`);
}

async function waitForServeToStop(serve: TailscaleServe, controller: ProcessController): Promise<void> {
  if (!controller.isServeConfigured) {
    throw new Error("Could not prove recorded Tailscale Serve route stopped because its status cannot be inspected");
  }
  for (let attempt = 0; attempt < shutdownVerificationAttempts; attempt += 1) {
    if (!await controller.isServeConfigured(serve)) return;
    await new Promise((resolve) => setTimeout(resolve, shutdownVerificationDelayMs));
  }
  throw new Error("Could not prove recorded Tailscale Serve route stopped before removing its registry");
}

export async function stopOwnedProcesses(registry: ProcessRegistry, controller: ProcessController = defaultProcessController): Promise<StopReport> {
  const report: StopReport = { stopped: [], containersStopped: [], skipped: [], ambiguousContainers: [] };
  for (const ownedProcess of registry.processes) {
    const inspection = await controller.inspect(ownedProcess.pid);
    if (!inspection) {
      report.skipped.push({ pid: ownedProcess.pid, reason: "missing" });
      continue;
    }
    if (!processIdentityMatches(ownedProcess, inspection)) {
      throw new Error(`Could not stop recorded Forge process ${ownedProcess.name}; ownership is ambiguous`);
    }
    await signalOwnedProcess(ownedProcess, "SIGTERM", controller);
    await waitForOwnedProcessToStop(ownedProcess, controller);
    report.stopped.push(ownedProcess.pid);
  }
  if (registry.temporalContainer && !registry.temporalContainer.legacy) {
    const live = await controller.inspectContainer(registry.temporalContainer.name);
    if (!live) {
      report.ambiguousContainers.push({ id: registry.temporalContainer.id, reason: live ? "identity-mismatch" : "missing" });
    } else if (
      registry.temporalContainer.owner === undefined
      || registry.temporalContainer.image === undefined
      || live.id !== registry.temporalContainer.id
      || live.owner !== registry.temporalContainer.owner
      || live.image !== registry.temporalContainer.image
    ) {
      throw new Error(`Could not stop recorded Temporal container ${registry.temporalContainer.name}; ownership is ambiguous`);
    } else {
      await controller.stopContainer(registry.temporalContainer.id);
      await waitForOwnedContainerToStop(registry.temporalContainer, controller);
      report.containersStopped.push(registry.temporalContainer.id);
    }
  }
  if (registry.tailscaleServe) {
    if (!controller.stopServe || !controller.isServeConfigured) {
      throw new Error("Could not stop recorded Tailscale Serve route because its status cannot be inspected");
    }
    if (await controller.isServeConfigured(registry.tailscaleServe)) {
      await controller.stopServe(registry.tailscaleServe);
      await waitForServeToStop(registry.tailscaleServe, controller);
    }
  }
  return report;
}

export async function writeProcessRegistry(filename: string, registry: ProcessRegistry): Promise<void> {
  ProcessRegistrySchema.parse(registry);
  await mkdir(dirname(filename), { recursive: true });
  const staging = `${filename}.staging`;
  await writeFile(staging, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(staging, filename);
}

export async function readProcessRegistry(filename: string): Promise<ProcessRegistry> {
  const content = await readFile(filename, "utf8");
  const parsed = ProcessRegistrySchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`Forge process registry is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  }
  return parsed.data;
}
