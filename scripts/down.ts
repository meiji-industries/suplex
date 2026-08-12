import { execFile } from "node:child_process";
import { readlink, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { readProcessRegistry, stopOwnedProcesses } from "../src/process-manager.js";

const execFileAsync = promisify(execFile);
const shutdownTimeoutMs = 15_000;

export interface ProcessSummary {
  pid: number;
  processGroup: number;
  command: string;
}

export function parseProcessList(output: string): ProcessSummary[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) return [];
    return [{ pid: Number(match[1]), processGroup: Number(match[2]), command: match[3] }];
  });
}

export function isForgeDevelopmentCommand(command: string): boolean {
  return /(?:^|\s)(?:\S*\/)?temporal server start-dev\b.*(?:^|\s)--db-filename(?:=|\s+)\.forge\/dev\/temporal\.db(?:\s|$)/.test(command)
    || /(?:^|\s)(?:\S*\/)?node --import tsx scripts\/dev\.ts(?:\s|$)/.test(command)
    || /(?:^|\s)(?:\S*\/)?node --import tsx src\/cli\.ts start --foreground(?:\s|$)/.test(command)
    || /(?:^|\s)\S*tsx\/dist\/cli\.mjs watch\b.*\ssrc\/(?:server|worker)\.ts(?:\s|$)/.test(command);
}

async function processWorkingDirectory(pid: number): Promise<string | undefined> {
  try {
    return await realpath(await readlink(`/proc/${pid}/cwd`));
  } catch {
    // macOS exposes process working directories through lsof rather than /proc.
  }
  try {
    const result = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      maxBuffer: 4 * 1024,
      timeout: 2_000,
    });
    const cwd = result.stdout.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1);
    return cwd ? await realpath(cwd) : undefined;
  } catch {
    return undefined;
  }
}

async function developmentProcessGroups(projectRoot: string): Promise<number[]> {
  const result = await execFileAsync("ps", ["-axo", "pid=,pgid=,command="], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5_000,
  });
  const matchingGroups = new Set<number>();
  for (const process of parseProcessList(result.stdout).filter(({ command }) => isForgeDevelopmentCommand(command))) {
    if (await processWorkingDirectory(process.pid) === projectRoot) {
      matchingGroups.add(process.processGroup);
    }
  }
  return [...matchingGroups];
}

function signalGroup(processGroup: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupIsAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroups(processGroups: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let live = processGroups.filter(groupIsAlive);
  while (live.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    live = live.filter(groupIsAlive);
  }
  return live;
}

function runtimeRoot(): string {
  if (process.env.FORGE_RUNTIME_ROOT) return resolve(process.env.FORGE_RUNTIME_ROOT);
  return resolve(process.env.FORGE_DATA_ROOT ?? ".forge/data", "runtime");
}

async function stopRecordedProcesses(registryPath: string): Promise<Error | undefined> {
  try {
    const registry = await readProcessRegistry(registryPath);
    await stopOwnedProcesses(registry);
    await rm(registryPath, { force: true });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return error instanceof Error ? error : new Error("unknown recorded-process cleanup error");
  }
}

export async function down(): Promise<void> {
  const projectRoot = await realpath(process.cwd());
  const root = runtimeRoot();
  const registryPath = join(root, "owned-processes.json");
  await stopRecordedProcesses(registryPath);

  const processGroups = await developmentProcessGroups(projectRoot);
  if (processGroups.length > 0) {
    for (const processGroup of processGroups) signalGroup(processGroup, "SIGTERM");
    const survivors = await waitForGroups(processGroups, shutdownTimeoutMs);
    for (const processGroup of survivors) signalGroup(processGroup, "SIGKILL");
    const unkillable = await waitForGroups(survivors, 1_000);
    if (unkillable.length > 0) {
      throw new Error(`Could not stop Forge development process groups: ${unkillable.join(", ")}`);
    }
  }

  const registryError = await stopRecordedProcesses(registryPath);
  if (registryError) {
    throw new Error(`Could not finish recorded Forge process cleanup: ${registryError.message}`, { cause: registryError });
  }
  await rm(join(root, "dev.lock"), { recursive: true, force: true });
  process.stdout.write(`[down] stopped ${processGroups.length} Forge development process group${processGroups.length === 1 ? "" : "s"}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await down();
