import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import {
  defaultProcessController,
  ownedProcessIsRunning,
  readProcessRegistry,
  type OwnedProcess,
  type ProcessController,
  type ProcessRegistry,
} from "../src/process-manager.js";

interface DevService {
  name: string;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface DevPorts {
  forge?: number;
  temporal: number;
  temporalUi: number;
}

export type DevState = "ready" | "starting" | "restarting" | "stopping" | "stopped" | "orphaned";

export interface DevRuntimeStatus {
  state: DevState;
  owner?: OwnedProcess;
  registry?: ProcessRegistry;
}

export type DevLockInspection =
  | { kind: "missing" }
  | { kind: "live"; owner: OwnedProcess }
  | { kind: "dead"; owner: OwnedProcess }
  | { kind: "ambiguous" };

export interface DevLock {
  path: string;
  release(): Promise<void>;
}

export interface DevControlOptions {
  controller?: ProcessController;
  pollMs?: number;
  timeoutMs?: number;
}

export interface DevServiceCommand {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
}

export interface DevStackOptions {
  forge?: DevServiceCommand;
  logPath?: string;
  pollMs?: number;
  restartTimeoutMs?: number;
  temporal?: DevServiceCommand;
}

const tscCli = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const controlPollMs = 100;
const controlTimeoutMs = 30_000;
const shutdownTimeoutMs = 15_000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isOwnedProcess(value: unknown): value is OwnedProcess {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<OwnedProcess>;
  return typeof owner.name === "string" && owner.name.length > 0
    && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.command === "string" && owner.command.length > 0
    && typeof owner.startedAt === "string" && owner.startedAt.length > 0
    && typeof owner.processGroup === "number" && Number.isSafeInteger(owner.processGroup) && owner.processGroup > 0
    && typeof owner.startTime === "string" && owner.startTime.length > 0
    && typeof owner.executable === "string" && owner.executable.length > 0
    && Array.isArray(owner.argv) && owner.argv.every((argument) => typeof argument === "string")
    && (owner.ownerUid === undefined || (Number.isSafeInteger(owner.ownerUid) && owner.ownerUid >= 0));
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function devRuntimeRoot(): string {
  if (process.env.FORGE_RUNTIME_ROOT) return resolve(process.env.FORGE_RUNTIME_ROOT);
  return resolve(process.env.FORGE_DATA_ROOT ?? ".forge/data", "runtime");
}

function devLockPath(runtimeRoot: string): string {
  return join(runtimeRoot, "dev.lock");
}

function controlPath(lockPath: string, action: "restart" | "stop"): string {
  return join(lockPath, `${action}.request`);
}

function controlVersionPath(lockPath: string): string {
  return join(lockPath, "control.version");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readRegistry(runtimeRoot: string): Promise<{ kind: "missing" } | { kind: "valid"; registry: ProcessRegistry } | { kind: "invalid" }> {
  try {
    return { kind: "valid", registry: await readProcessRegistry(join(runtimeRoot, "owned-processes.json")) };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
}

function readyForgePidsFromRegistry(registry: ProcessRegistry | undefined): number[] | undefined {
  if (!registry || registry.processes.length !== 2) return undefined;
  const processes = registry.processes.filter((candidate) => candidate.ready && (candidate.name === "server" || candidate.name === "worker"));
  if (processes.length !== 2 || new Set(processes.map((candidate) => candidate.name)).size !== 2) return undefined;
  return processes.map((candidate) => candidate.pid).sort((left, right) => left - right);
}

async function readyForgePids(runtimeRoot: string): Promise<number[] | undefined> {
  const result = await readRegistry(runtimeRoot);
  return result.kind === "valid" ? readyForgePidsFromRegistry(result.registry) : undefined;
}

function samePids(left: number[] | undefined, right: number[] | undefined): boolean {
  return left !== undefined && right !== undefined && left.length === right.length && left.every((pid, index) => pid === right[index]);
}

export function resolveDevPorts(conductorPort: string | undefined): DevPorts {
  if (conductorPort === undefined) return { temporal: 7233, temporalUi: 8233 };
  const forge = Number(conductorPort);
  if (!Number.isInteger(forge) || forge < 1 || forge > 65533) {
    throw new Error(`CONDUCTOR_PORT must reserve three valid ports; received ${conductorPort}`);
  }
  return { forge, temporal: forge + 1, temporalUi: forge + 2 };
}

export async function inspectDevLock(runtimeRoot: string, controller: ProcessController = defaultProcessController): Promise<DevLockInspection> {
  const lockPath = devLockPath(runtimeRoot);
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { kind: "ambiguous" };
    return await pathExists(lockPath) ? { kind: "ambiguous" } : { kind: "missing" };
  }
  if (!isOwnedProcess(owner) || !controller.isProcessGroupAlive) {
    return { kind: "ambiguous" };
  }
  try {
    return await ownedProcessIsRunning(owner, controller) ? { kind: "live", owner } : { kind: "dead", owner };
  } catch {
    return { kind: "live", owner };
  }
}

async function registryHasLiveProcesses(registry: ProcessRegistry, controller: ProcessController): Promise<boolean> {
  for (const owned of registry.processes) {
    try {
      if (await ownedProcessIsRunning(owned, controller)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export async function readDevControlRequest(lockPath: string): Promise<"stop" | "restart" | undefined> {
  if (await pathExists(controlPath(lockPath, "stop"))) return "stop";
  if (await pathExists(controlPath(lockPath, "restart"))) return "restart";
  return undefined;
}

export async function inspectDevStatus(runtimeRoot: string, controller: ProcessController = defaultProcessController): Promise<DevRuntimeStatus> {
  const [lock, registryResult] = await Promise.all([inspectDevLock(runtimeRoot, controller), readRegistry(runtimeRoot)]);
  const registry = registryResult.kind === "valid" ? registryResult.registry : undefined;
  if (lock.kind === "live") {
    const lockPath = devLockPath(runtimeRoot);
    const control = await readDevControlRequest(lockPath);
    const state: DevState = control === "stop"
      ? "stopping"
      : control === "restart"
        ? "restarting"
        : readyForgePidsFromRegistry(registry)
          ? "ready"
          : "starting";
    return { state, owner: lock.owner, ...(registry ? { registry } : {}) };
  }
  if (lock.kind !== "missing" || registryResult.kind === "invalid") {
    return { state: "orphaned", ...(registry ? { registry } : {}) };
  }
  if (registry && await registryHasLiveProcesses(registry, controller)) return { state: "orphaned", registry };
  return { state: "stopped", ...(registry ? { registry } : {}) };
}

async function releaseOwnedDevLock(lockPath: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown;
    if (owner && typeof owner === "object" && (owner as { pid?: unknown }).pid === process.pid) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function acquireDevLock(runtimeRoot: string, controller: ProcessController = defaultProcessController): Promise<DevLock | undefined> {
  const lockPath = devLockPath(runtimeRoot);
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(runtimeRoot, { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const inspection = await controller.inspect(process.pid);
      if (!inspection) {
        await rm(lockPath, { recursive: true, force: true });
        throw new Error("Could not record the development supervisor identity");
      }
      const owner: OwnedProcess = {
        name: "dev-supervisor",
        pid: process.pid,
        command: inspection.command,
        startedAt: new Date().toISOString(),
        processGroup: inspection.processGroup,
        startTime: inspection.startTime,
        executable: inspection.executable,
        argv: inspection.argv,
        ...(inspection.ownerUid === undefined ? {} : { ownerUid: inspection.ownerUid }),
        ready: true,
      };
      try {
        await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await writeFile(controlVersionPath(lockPath), "1\n", { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { path: lockPath, release: () => releaseOwnedDevLock(lockPath) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    let inspection: DevLockInspection = { kind: "ambiguous" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      inspection = await inspectDevLock(runtimeRoot, controller);
      if (inspection.kind === "live") {
        process.stdout.write(`[dev] development stack is already supervised by PID ${inspection.owner.pid}\n`);
        return undefined;
      }
      if (inspection.kind === "dead" || inspection.kind === "missing") break;
      await wait(50);
    }
    if (inspection.kind === "missing") continue;
    if (inspection.kind !== "dead") {
      throw new Error("Development supervisor ownership is ambiguous; run `mise run dev:status` before recovery");
    }

    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

function writeDevLog(log: WriteStream, message: string, error = false): void {
  (error ? process.stderr : process.stdout).write(message);
  log.write(message);
}

function startService(name: string, command: string, args: string[], log: WriteStream, environment: NodeJS.ProcessEnv = {}): DevService {
  writeDevLog(log, `[dev] starting ${name}\n`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["inherit", "pipe", "pipe"],
    // Keep terminal interrupts on the supervisor. It forwards one signal to
    // each service instead of every process in the tree receiving Ctrl+C and
    // forwarding it again to its own children.
    detached: true,
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  child.stderr?.pipe(log, { end: false });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { name, child, exited };
}

async function runPreparation(name: string, args: string[]): Promise<void> {
  process.stdout.write(`[dev] ${name}\n`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (result.code !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 1}`;
    throw new Error(`${name} failed (${detail})`);
  }
}

function serviceStopped(service: DevService): boolean {
  return service.child.exitCode !== null || service.child.signalCode !== null;
}

async function stopService(service: DevService, signal: NodeJS.Signals): Promise<void> {
  if (!serviceStopped(service)) service.child.kill(signal);
  const stopped = await Promise.race([
    service.exited.then(() => true),
    wait(shutdownTimeoutMs).then(() => false),
  ]);
  if (stopped || !service.child.pid) return;
  try {
    process.kill(-service.child.pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
  await service.exited;
}

function forgeEnvironment(ports: DevPorts): NodeJS.ProcessEnv {
  return {
    ...(ports.forge === undefined ? {} : { FORGE_PORT: String(ports.forge) }),
    FORGE_TEMPORAL_TARGET: "local",
    FORGE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
    FORGE_TEMPORAL_NAMESPACE: "forge-dev",
    FORGE_DEVELOPMENT_WATCH: "1",
    FORGE_FRONTEND_DEV_SERVER: "1",
    FORGE_DEVELOPMENT_AUTO_LOGIN: "1",
    FORGE_REPOSITORY_ROOT: process.cwd(),
  };
}

async function waitForForgeRestart(runtimeRoot: string, priorPids: number[] | undefined, forge: DevService, temporal: DevService, shuttingDown: () => boolean, pollMs: number, timeoutMs: number): Promise<"ready" | "stop" | "shutdown"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown()) return "shutdown";
    if (await pathExists(controlPath(devLockPath(runtimeRoot), "stop"))) return "stop";
    if (serviceStopped(temporal)) throw new Error("Temporal stopped while Forge was restarting");
    if (serviceStopped(forge)) {
      const result = await forge.exited;
      const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 1}`;
      throw new Error(`Forge stopped during restart (${detail})`);
    }
    const currentPids = await readyForgePids(runtimeRoot);
    if (currentPids && (!priorPids || !samePids(priorPids, currentPids))) return "ready";
    await wait(pollMs);
  }
  throw new Error(`Forge did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds of restart`);
}

export async function superviseDevStack(ports: DevPorts, runtimeRoot: string, options: DevStackOptions = {}): Promise<number> {
  const pollMs = options.pollMs ?? controlPollMs;
  const restartTimeoutMs = options.restartTimeoutMs ?? controlTimeoutMs;
  const logPath = options.logPath ?? join("logs", "dev.log");
  if (!options.temporal) await mkdir(join(".forge", "dev"), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  log.write(`\n[dev] ${new Date().toISOString()}\n`);
  const temporalCommand = options.temporal ?? { command: "temporal", args: ["server", "start-dev", "--port", String(ports.temporal), "--ui-port", String(ports.temporalUi), "--db-filename", ".forge/dev/temporal.db", "--namespace", "forge-dev", "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"] };
  const forgeCommand = options.forge ?? { command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "start", "--foreground"], environment: forgeEnvironment(ports) };
  const startForge = (): DevService => startService("Forge", forgeCommand.command, forgeCommand.args, log, forgeCommand.environment);
  const temporal = startService("Temporal", temporalCommand.command, temporalCommand.args, log, temporalCommand.environment);
  let forge = startForge();
  let requestedExitCode = 0;
  let shuttingDown = false;
  let shutdown: Promise<void> | undefined;

  const stopServices = (signal: NodeJS.Signals, exitCode: number): Promise<void> => {
    if (shutdown) return shutdown;
    shuttingDown = true;
    requestedExitCode = exitCode;
    shutdown = Promise.allSettled([stopService(temporal, signal), stopService(forge, signal)]).then(() => undefined);
    return shutdown;
  };

  const interrupt = (): void => void stopServices("SIGINT", 0);
  const terminate = (): void => void stopServices("SIGTERM", 0);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    while (!shuttingDown) {
      await wait(pollMs);
      if (shuttingDown) break;
      const stoppedService = serviceStopped(temporal) ? temporal : serviceStopped(forge) ? forge : undefined;
      if (stoppedService) {
        const result = await stoppedService.exited;
        // mise and terminals can signal the whole process group, so allow the
        // supervisor's signal handler to win before classifying the child exit.
        await wait(100);
        if (!shuttingDown) {
          const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 1}`;
          const cleanExit = result.code === 0 || result.signal === "SIGINT" || result.signal === "SIGTERM";
          writeDevLog(log, `[dev] ${stoppedService.name} stopped (${detail}); stopping the development stack\n`, !cleanExit);
          await stopServices("SIGTERM", cleanExit ? 0 : (result.code && result.code > 0 ? result.code : 1));
        }
        break;
      }

      const lockPath = devLockPath(runtimeRoot);
      const control = await readDevControlRequest(lockPath);
      if (control === "stop") {
        writeDevLog(log, "[dev] cooperative stop requested\n");
        await stopServices("SIGTERM", 0);
        break;
      }
      if (control !== "restart") continue;

      writeDevLog(log, "[dev] restarting Forge; Temporal remains running\n");
      const priorPids = await readyForgePids(runtimeRoot);
      await stopService(forge, "SIGTERM");
      if (shuttingDown) break;
      if (await pathExists(controlPath(lockPath, "stop"))) {
        await stopServices("SIGTERM", 0);
        break;
      }
      forge = startForge();
      const outcome = await waitForForgeRestart(runtimeRoot, priorPids, forge, temporal, () => shuttingDown, pollMs, restartTimeoutMs);
      if (outcome === "stop") {
        await stopServices("SIGTERM", 0);
        break;
      }
      if (outcome === "shutdown") break;
      await rm(controlPath(lockPath, "restart"), { force: true });
      writeDevLog(log, "[dev] Forge restart complete\n");
    }
    await shutdown;
  } catch (error) {
    writeDevLog(log, `[dev] could not supervise the development stack: ${error instanceof Error ? error.message : "unknown error"}\n`, true);
    await stopServices("SIGTERM", 1);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    await new Promise<void>((resolveEnd) => log.end(resolveEnd));
  }

  return requestedExitCode;
}

function describeStatus(status: DevRuntimeStatus): string {
  const owner = status.owner ? `; supervisor PID ${status.owner.pid}` : "";
  return `[dev] ${status.state}${owner}\n`;
}

export async function requestDevControl(action: "restart" | "stop", runtimeRoot: string, options: DevControlOptions = {}): Promise<DevRuntimeStatus> {
  const controller = options.controller ?? defaultProcessController;
  const pollMs = options.pollMs ?? controlPollMs;
  const timeoutMs = options.timeoutMs ?? controlTimeoutMs;
  const before = await inspectDevStatus(runtimeRoot, controller);
  if (before.state === "orphaned") throw new Error("Development processes are orphaned; run `mise run dev:recover`");
  if (before.state === "stopped") {
    if (action === "stop") return before;
    throw new Error("Development stack is stopped; run `mise run dev`");
  }

  const priorPids = readyForgePidsFromRegistry(before.registry);
  const joinedRestart = action === "restart" && before.state === "restarting";
  const lockPath = devLockPath(runtimeRoot);
  if (!await pathExists(controlVersionPath(lockPath))) {
    throw new Error("Development supervisor predates shared control; stop it once with Ctrl+C and run `mise run dev`");
  }
  await writeFile(controlPath(lockPath, action), `${new Date().toISOString()} ${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspectDevStatus(runtimeRoot, controller);
    if (action === "stop") {
      if (status.state === "stopped") return status;
      if (status.state === "orphaned") throw new Error("Development stack became orphaned while stopping");
    } else {
      if (status.state === "stopped") throw new Error("Development stack stopped before restart completed");
      if (status.state === "orphaned") throw new Error("Development stack became orphaned while restarting");
      const currentPids = readyForgePidsFromRegistry(status.registry);
      if (
        status.state === "ready"
        && currentPids
        && (joinedRestart || !priorPids || !samePids(priorPids, currentPids))
        && !await pathExists(controlPath(lockPath, "restart"))
      ) return status;
    }
    await wait(pollMs);
  }
  throw new Error(`Development ${action} request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? "start";
  const runtimeRoot = devRuntimeRoot();
  if (action === "status") {
    const status = await inspectDevStatus(runtimeRoot);
    process.stdout.write(describeStatus(status));
    process.exitCode = status.state === "orphaned" ? 2 : status.state === "stopped" ? 1 : 0;
    return;
  }
  if (action === "restart" || action === "stop") {
    const status = await requestDevControl(action, runtimeRoot);
    process.stdout.write(describeStatus(status));
    return;
  }
  if (action !== "start") throw new Error(`Unknown development command: ${action}`);

  const current = await inspectDevStatus(runtimeRoot);
  if (current.state === "orphaned") throw new Error("Development processes are orphaned; run `mise run dev:recover` before starting another stack");
  const lock = await acquireDevLock(runtimeRoot);
  if (!lock) return;
  try {
    loadConfig();
    await runPreparation("type-checking", [tscCli, "--noEmit"]);
    process.exitCode = await superviseDevStack(resolveDevPorts(process.env.CONDUCTOR_PORT), runtimeRoot);
  } finally {
    await lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`[dev] ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
