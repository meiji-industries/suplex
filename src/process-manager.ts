import { execFile } from "node:child_process";
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
  ready?: boolean | undefined;
}

export interface TemporalContainer {
  id: string;
  name: string;
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
}

export interface ProcessController {
  inspect(pid: number): Promise<ProcessInspection | undefined>;
  inspectContainer(name: string): Promise<ContainerInspection | undefined>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  stopContainer(id: string): Promise<void>;
  stopServe?: (serve: TailscaleServe) => Promise<void>;
}

export interface StopReport {
  stopped: number[];
  containersStopped: string[];
  skipped: Array<{ pid: number; reason: "missing" | "identity-mismatch" | "ownership-ambiguous" }>;
  ambiguousContainers: Array<{ id: string; reason: "missing" | "identity-mismatch" | "ownership-ambiguous" }>;
}

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

const defaultController: ProcessController = {
  async inspect(pid) {
    const command = await processField(pid, "command=");
    if (!command) return undefined;
    const pgid = Number(await processField(pid, "pgid=") ?? "0");
    const startTime = await processField(pid, "lstart=") ?? "";
    const comm = await processField(pid, "comm=") ?? "";
    const argv = normalizeArgv(command);
    return { pid, command, executable: comm, argv, processGroup: pgid, startTime };
  },
  async inspectContainer(name) {
    try {
      const result = await execFileAsync("docker", ["inspect", "--format", "{{.Id}} {{.Name}} {{.Config.Image}} {{.Config.Labels.com.forge.owner}}", name]);
      const parts = result.stdout.trim().split(/\s+/);
      if (parts.length < 3) return undefined;
      return { id: parts[0]!, name: parts[1]!, image: parts[2]!, owner: parts[3] ?? "" };
    } catch {
      return undefined;
    }
  },
  async signal(pid, signal) {
    process.kill(pid, signal);
  },
  async stopContainer(id) {
    await execFileAsync("docker", ["stop", "--time", "10", id]);
  },
  async stopServe(serve) {
    try {
      const result = await execFileAsync("tailscale", ["serve", "status", "--json"], { maxBuffer: 64 * 1024 });
      const status = TailscaleServeStatusSchema.parse(JSON.parse(result.stdout));
      const route = Object.keys(status.Web ?? {}).find((key) => key.endsWith(`:${serve.port}`));
      const proxy = route ? status.Web?.[route]?.Handlers?.["/"]?.Proxy : undefined;
      if (proxy !== serve.backend) {
        return;
      }
      await execFileAsync("tailscale", ["serve", `--https=${serve.port}`, "off"]);
    } catch {
      // Cleanup is idempotent when Tailscale is unavailable or already stopped.
    }
  },
};

function processIdentityMatches(owned: OwnedProcess, inspection: ProcessInspection): boolean {
  return inspection.pid === owned.pid
    && inspection.processGroup === (owned.processGroup ?? owned.pid)
    && inspection.command === owned.command
    && inspection.startTime === (owned.startTime ?? inspection.startTime);
}

export async function stopOwnedProcesses(registry: ProcessRegistry, controller: ProcessController = defaultController): Promise<StopReport> {
  const report: StopReport = { stopped: [], containersStopped: [], skipped: [], ambiguousContainers: [] };
  for (const ownedProcess of registry.processes) {
    const inspection = await controller.inspect(ownedProcess.pid);
    if (!inspection) {
      report.skipped.push({ pid: ownedProcess.pid, reason: "missing" });
      continue;
    }
    if (!processIdentityMatches(ownedProcess, inspection)) {
      report.skipped.push({ pid: ownedProcess.pid, reason: "ownership-ambiguous" });
      continue;
    }
    await controller.signal(ownedProcess.pid, "SIGTERM");
    report.stopped.push(ownedProcess.pid);
  }
  if (registry.temporalContainer && !registry.temporalContainer.legacy) {
    const live = await controller.inspectContainer(registry.temporalContainer.name);
    if (!live || live.id !== registry.temporalContainer.id || live.image !== (registry.temporalContainer.image ?? "")) {
      report.ambiguousContainers.push({ id: registry.temporalContainer.id, reason: live ? "identity-mismatch" : "missing" });
    } else {
      await controller.stopContainer(registry.temporalContainer.id);
      report.containersStopped.push(registry.temporalContainer.id);
    }
  }
  if (registry.tailscaleServe && controller.stopServe) {
    await controller.stopServe(registry.tailscaleServe);
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
