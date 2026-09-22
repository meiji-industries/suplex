import { execFile } from "node:child_process";
import { systemEvent } from "./system-events.js";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { ProcessRegistrySchema, TailscaleServeStatusSchema } from "./schemas.js";
import { jsonRequired } from "../shared/json.js";

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

const shutdownGraceMs = 250;
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
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", field], { env: { ...process.env, LC_ALL: "C" } });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function inspectProcessOnce(pid: number): Promise<ProcessInspection | undefined> {
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
        await delay(processInspectionRetryDelayMs);
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
    const status = TailscaleServeStatusSchema.parse(jsonRequired(result.stdout));
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

function ownershipError(owned: OwnedProcess, comparison: ProcessIdentityComparison): Error {
  const reason = comparison.kind === "incomplete_identity"
    ? `incomplete identity (${comparison.field})`
    : comparison.kind.replaceAll("_", " ");
  return new Error(`Refusing to signal recorded Forge process ${owned.name} (${owned.pid}); ownership is ${reason}`);
}

async function ownedOrphanedGroupIsAlive(owned: OwnedProcess, controller: ProcessController): Promise<boolean> {
  if (
    !hasCompleteProcessIdentity(owned)
    || owned.processGroup !== owned.pid
    || !controller.signalGroup
    || !controller.isProcessGroupAlive
  ) return false;
  // A Forge-created process group has PGID === its recorded leader PID. If the
  // leader is gone while that group remains live, the OS cannot reuse the PGID;
  // this is the only leaderless target whose ownership is independently proven.
  return controller.isProcessGroupAlive(owned.processGroup);
}

export async function signalOwnedProcess(
  owned: OwnedProcess,
  signal: "SIGTERM" | "SIGKILL",
  controller: ProcessController,
  reason = "process cleanup",
): Promise<void> {
  const event = (state: "requested" | "sent" | "skipped" | "error", result?: string): void => {
    systemEvent({ type: "process_signal", state, targetPid: owned.pid, targetName: owned.name, ...(owned.startTime ? { targetStartTime: owned.startTime } : {}), senderPid: process.pid, signal, reason, ...(result ? { result } : {}) });
  };
  event("requested");
  try {
    const comparison = compareProcessIdentity(owned, await controller.inspect(owned.pid));
    if (comparison.kind === "exact_match") {
      if (comparison.inspection.processGroup === owned.pid && controller.signalGroup) {
        await controller.signalGroup(comparison.inspection.processGroup, signal);
      } else {
        await controller.signal(comparison.inspection.pid, signal);
      }
      event("sent", "exact_match");
      return;
    }
    if (comparison.kind === "not_running") {
      if (await ownedOrphanedGroupIsAlive(owned, controller)) {
        await controller.signalGroup!(owned.processGroup!, signal);
        event("sent", "orphaned_group");
      } else {
        event("skipped", "missing");
      }
      return;
    }
    throw ownershipError(owned, comparison);
  } catch (error) {
    event("error", error instanceof Error ? error.name : "unknown");
    throw error;
  }
}

export async function ownedProcessIsRunning(owned: OwnedProcess, controller: ProcessController): Promise<boolean> {
  return Boolean(await controller.inspect(owned.pid));
}

async function ownedTargetIsRunning(owned: OwnedProcess, controller: ProcessController): Promise<boolean> {
  const comparison = compareProcessIdentity(owned, await controller.inspect(owned.pid));
  if (comparison.kind === "exact_match") return true;
  if (comparison.kind === "not_running") return ownedOrphanedGroupIsAlive(owned, controller);
  throw ownershipError(owned, comparison);
}

async function waitForOwnedProcessToStop(owned: OwnedProcess, controller: ProcessController, reason: string): Promise<void> {
  await delay(shutdownGraceMs);
  if (!await ownedTargetIsRunning(owned, controller)) return;
  await signalOwnedProcess(owned, "SIGKILL", controller, `${reason}: grace period expired`);
  await delay(shutdownGraceMs);
  if (!await ownedTargetIsRunning(owned, controller)) return;
  throw new Error(`Recorded Forge process ${owned.name} (${owned.pid}) did not exit after SIGKILL`);
}

async function waitForServeToStop(serve: TailscaleServe, controller: ProcessController): Promise<void> {
  if (!controller.isServeConfigured) {
    throw new Error("Could not prove recorded Tailscale Serve route stopped because its status cannot be inspected");
  }
  for (let attempt = 0; attempt < shutdownVerificationAttempts; attempt += 1) {
    if (!await controller.isServeConfigured(serve)) return;
    await delay(shutdownVerificationDelayMs);
  }
  throw new Error("Could not prove recorded Tailscale Serve route stopped before removing its registry");
}

export async function stopOwnedProcesses(registry: ProcessRegistry, controller: ProcessController = defaultProcessController, reason = "process cleanup"): Promise<StopReport> {
  const report: StopReport = { stopped: [], skipped: [] };
  for (const ownedProcess of registry.processes) {
    const comparison = compareProcessIdentity(ownedProcess, await controller.inspect(ownedProcess.pid));
    if (comparison.kind === "not_running" && !await ownedOrphanedGroupIsAlive(ownedProcess, controller)) {
      report.skipped.push({ pid: ownedProcess.pid, reason: "missing" });
      systemEvent({ type: "process_signal", state: "skipped", targetPid: ownedProcess.pid, targetName: ownedProcess.name, ...(ownedProcess.startTime ? { targetStartTime: ownedProcess.startTime } : {}), senderPid: process.pid, signal: "SIGTERM", reason, result: "missing" });
      continue;
    }
    if (comparison.kind !== "exact_match" && comparison.kind !== "not_running") {
      throw ownershipError(ownedProcess, comparison);
    }
    await signalOwnedProcess(ownedProcess, "SIGTERM", controller, reason);
    await waitForOwnedProcessToStop(ownedProcess, controller, reason);
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
  const parsed = ProcessRegistrySchema.safeParse(jsonRequired(content));
  if (!parsed.success) {
    throw new Error(`Forge process registry is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  }
  return parsed.data;
}

export function taskProcessEnvironment(directory: string): Record<string, string> {
  let canonical = resolve(directory);
  try { canonical = realpathSync(canonical); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { FORGE_TASK_PROCESS_OWNER: createHash("sha256").update(canonical).digest("hex") };
}

export function sessionProcessEnvironment(directory: string): Record<string, string> {
  return { FORGE_SESSION_PROCESS_OWNER: taskProcessEnvironment(directory).FORGE_TASK_PROCESS_OWNER! };
}

export function executionProcessEnvironment(runtimeDirectory: string, generation: string): Record<string, string> {
  return { FORGE_EXECUTION_PROCESS_OWNER: taskProcessEnvironment(join(runtimeDirectory, generation)).FORGE_TASK_PROCESS_OWNER! };
}

export async function taskOwnedProcessIds(directory: string, scope: "task" | "session" | "execution" = "task"): Promise<number[]> {
  const key = `FORGE_${scope.toUpperCase()}_PROCESS_OWNER`;
  const marker = taskProcessEnvironment(directory).FORGE_TASK_PROCESS_OWNER;
  // Process environments may contain credentials. Parse locally without logging the output.
  if (process.platform === "linux") {
    const plain = await execFileAsync("ps", ["-eww", "-o", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 });
    const commands = new Map(plain.stdout.split("\n").map(line => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return [Number(match?.[1]), match?.[2] ?? ""] as const;
    }));
    const pattern = `${key}=${marker}`;
    const owned = await Promise.all([...commands].map(async ([pid, command]) => {
      if (pid === process.pid || !command) return undefined;
      const environment = await readFile(`/proc/${pid}/environ`).catch(() => undefined);
      return environment?.toString("utf8").split("\0").includes(pattern) ? pid : undefined;
    }));
    return owned.filter((pid): pid is number => pid !== undefined);
  }
  const [plain, environments] = await Promise.all([
    execFileAsync("ps", ["ww", "-axo", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync("ps", ["eww", "-axo", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 }),
  ]);
  const commands = new Map(plain.stdout.split("\n").map(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return [Number(match?.[1]), match?.[2] ?? ""] as const;
  }));
  const pattern = new RegExp(`(?:^|\\s)${key}=${marker}(?:\\s|$)`);
  const owned: number[] = [];
  for (const line of environments.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    const pid = Number(match?.[1]);
    const command = commands.get(pid);
    const expanded = match?.[2];
    if (pid !== process.pid && command && expanded?.startsWith(command) && pattern.test(expanded.slice(command.length))) owned.push(pid);
  }
  return owned;
}

export async function stopDiscoveredProcesses(discover: () => Promise<Iterable<number>>, reason = "discovered process cleanup"): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const identities: OwnedProcess[] = [];
    for (const pid of await discover()) {
      const identity = await inspectProcessOnce(pid);
      if (identity && identity.ownerUid === process.getuid!()) identities.push({ ...identity, name: "task command", startedAt: identity.startTime });
    }
    const confirmed = new Set(await discover());
    const owned = identities.filter(identity => confirmed.has(identity.pid));
    if (!owned.length) return;
    if (Date.now() >= deadline) throw new Error("Task commands are still running after cleanup. Cleanup will be retried.");
    await stopOwnedProcesses({ version: 1, processes: owned }, {
      inspect: async pid => {
        const current = await inspectProcessOnce(pid);
        const original = owned.find(identity => identity.pid === pid);
        return original && compareProcessIdentity(original, current).kind === "exact_match" ? current : undefined;
      },
      signal: defaultProcessController.signal,
    }, reason);
  }
}

export async function stopSessionProcesses(runtimeDirectory: string, reason = "session stop"): Promise<void> {
  await stopDiscoveredProcesses(() => taskOwnedProcessIds(runtimeDirectory, "session"), reason);
}

export async function stopExecutionProcesses(runtimeDirectory: string, generation: string, reason = "execution cleanup"): Promise<void> {
  await stopDiscoveredProcesses(() => taskOwnedProcessIds(join(runtimeDirectory, generation), "execution"), reason);
}
