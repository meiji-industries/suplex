import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { ProcessRegistrySchema, TailscaleServeStatusSchema } from "./schemas.js";

const execFileAsync = promisify(execFile);

export interface OwnedProcess {
  name: string;
  pid: number;
  command: string;
  startedAt: string;
}

export interface TemporalContainer {
  id: string;
  name: string;
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
}

export interface ProcessController {
  inspect(pid: number): Promise<ProcessInspection | undefined>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  stopContainer(id: string): Promise<void>;
  stopServe?: (serve: TailscaleServe) => Promise<void>;
}

export interface StopReport {
  stopped: number[];
  containersStopped: string[];
  skipped: Array<{ pid: number; reason: "missing" | "identity-mismatch" }>;
}

const defaultController: ProcessController = {
  async inspect(pid) {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
      const command = result.stdout.trim();
      return command ? { pid, command } : undefined;
    } catch {
      return undefined;
    }
  },
  async signal(pid, signal) {
    process.kill(pid, signal);
  },
  async stopContainer(id) {
    await execFileAsync("docker", ["stop", "--time", "10", id]).catch(() => undefined);
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

export async function stopOwnedProcesses(registry: ProcessRegistry, controller: ProcessController = defaultController): Promise<StopReport> {
  const report: StopReport = { stopped: [], containersStopped: [], skipped: [] };
  for (const ownedProcess of registry.processes) {
    const inspection = await controller.inspect(ownedProcess.pid);
    if (!inspection) {
      report.skipped.push({ pid: ownedProcess.pid, reason: "missing" });
      continue;
    }
    if (inspection.pid !== ownedProcess.pid || inspection.command !== ownedProcess.command) {
      report.skipped.push({ pid: ownedProcess.pid, reason: "identity-mismatch" });
      continue;
    }
    await controller.signal(ownedProcess.pid, "SIGTERM");
    report.stopped.push(ownedProcess.pid);
  }
  if (registry.temporalContainer) {
    await controller.stopContainer(registry.temporalContainer.id);
    report.containersStopped.push(registry.temporalContainer.id);
  }
  if (registry.tailscaleServe && controller.stopServe) {
    await controller.stopServe(registry.tailscaleServe);
  }
  return report;
}

export async function writeProcessRegistry(filename: string, registry: ProcessRegistry): Promise<void> {
  ProcessRegistrySchema.parse(registry);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readProcessRegistry(filename: string): Promise<ProcessRegistry> {
  const content = await readFile(filename, "utf8");
  const parsed = ProcessRegistrySchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`Forge process registry is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  }
  return parsed.data;
}
