import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { ProcessRegistrySchema, TailscaleServeStatusSchema } from "./schemas.js";

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
  ownerUid?: number | undefined;
  ready?: boolean | undefined;
}

export interface TailscaleServe {
  port: number;
  backend: string;
}

export interface ProcessRegistry {
  version: 1;
  processes: OwnedProcess[];
  tailscaleServe?: TailscaleServe | undefined;
}

export interface ProcessInspection {
  pid: number;
  command: string;
  executable: string;
  argv: string[];
  processGroup: number;
  startTime: string;
  ownerUid?: number | undefined;
}

export type ProcessIdentityComparison =
  | { kind: "exact_match"; inspection: ProcessInspection }
  | { kind: "not_running" }
  | { kind: "incomplete_identity"; field: string }
  | { kind: "pid_reused" }
  | { kind: "wrong_process_group" }
  | { kind: "wrong_start_time" }
  | { kind: "wrong_executable" }
  | { kind: "wrong_argv" }
  | { kind: "wrong_owner" }
  | { kind: "ambiguous"; reason: string };

export interface ProcessController {
  inspect(pid: number): Promise<ProcessInspection | undefined>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  signalGroup?: (processGroup: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  isProcessGroupAlive?: (processGroup: number) => Promise<boolean>;
  stopServe?: (serve: TailscaleServe) => Promise<void>;
  isServeConfigured?: (serve: TailscaleServe) => Promise<boolean>;
}

export interface StopReport {
  stopped: number[];
  skipped: Array<{ pid: number; reason: "missing" }>;
}

const shutdownVerificationAttempts = 10;
const shutdownVerificationDelayMs = 100;
const processInspectionAttempts = 60;
const processInspectionRetryDelayMs = 50;

function normalizeArgv(command: string): string[] {
  // Identity argv must always fit the supervisor protocol's processIdentity
  // bounds (max 256 elements of max 4000 chars); ps-derived command lines can
  // exceed either, so collapse oversized ones to a stable digest.
  const argv = command.split(/\s+/).filter(Boolean);
  return argv.length <= 256 && argv.every((argument) => argument.length <= 4_000) ? argv : [`sha256:${createHash("sha256").update(command).digest("hex")}`];
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
  const [ownerUidValue, command, pgidValue, startTime, executable] = await Promise.all([
    processField(pid, "uid="),
    processField(pid, "command="),
    processField(pid, "pgid="),
    processField(pid, "lstart="),
    processField(pid, "comm="),
  ]);
  if (!command || !pgidValue || !startTime || !executable) return undefined;
  const processGroup = Number(pgidValue);
  if (!Number.isSafeInteger(processGroup) || processGroup <= 0) return undefined;
  const ownerUid = ownerUidValue === undefined ? undefined : Number(ownerUidValue);
  return {
    pid,
    command,
    executable,
    argv: normalizeArgv(command),
    processGroup,
    startTime,
    ...(ownerUid !== undefined && Number.isSafeInteger(ownerUid) && ownerUid >= 0 ? { ownerUid } : {}),
  };
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

export function compareProcessIdentity(owned: OwnedProcess, inspection: ProcessInspection | undefined): ProcessIdentityComparison {
  if (!inspection) return { kind: "not_running" };
  if (
    owned.processGroup === undefined
    || owned.startTime === undefined
    || owned.executable === undefined
    || owned.argv === undefined
  ) {
    return { kind: "incomplete_identity", field: owned.processGroup === undefined ? "processGroup" : owned.startTime === undefined ? "startTime" : owned.executable === undefined ? "executable" : "argv" };
  }
  if (inspection.pid !== owned.pid) return { kind: "pid_reused" };
  if (inspection.processGroup !== owned.processGroup) return { kind: "wrong_process_group" };
  if (inspection.startTime !== owned.startTime) return { kind: "wrong_start_time" };
  if (inspection.executable !== owned.executable) return { kind: "wrong_executable" };
  if (inspection.argv.length !== owned.argv.length || !inspection.argv.every((argument, index) => argument === owned.argv![index])) return { kind: "wrong_argv" };
  if (owned.ownerUid !== undefined && inspection.ownerUid === undefined) return { kind: "incomplete_identity", field: "ownerUid" };
  if (owned.ownerUid !== undefined && inspection.ownerUid !== owned.ownerUid) return { kind: "wrong_owner" };
  return { kind: "exact_match", inspection };
}

export function processIdentityMatches(owned: OwnedProcess, inspection: ProcessInspection): boolean {
  return compareProcessIdentity(owned, inspection).kind === "exact_match";
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
  const report: StopReport = { stopped: [], skipped: [] };
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
