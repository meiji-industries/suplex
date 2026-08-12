import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { defaultProcessController, processIdentityMatches, type OwnedProcess } from "../src/process-manager.js";

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

const tscCli = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

export function resolveDevPorts(conductorPort: string | undefined): DevPorts {
  if (conductorPort === undefined) return { temporal: 7233, temporalUi: 8233 };
  const forge = Number(conductorPort);
  if (!Number.isInteger(forge) || forge < 1 || forge > 65533) {
    throw new Error(`CONDUCTOR_PORT must reserve three valid ports; received ${conductorPort}`);
  }
  return { forge, temporal: forge + 1, temporalUi: forge + 2 };
}

function startService(name: string, command: string, args: string[], environment: NodeJS.ProcessEnv = {}): DevService {
  process.stdout.write(`[dev] starting ${name}\n`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: "inherit",
    // Keep terminal interrupts on the supervisor. It forwards one signal to
    // each service instead of every process in the tree receiving Ctrl+C and
    // forwarding it again to its own children.
    detached: true,
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
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
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 1}`;
    throw new Error(`${name} failed (${detail})`);
  }
}

async function readLiveLockOwner(ownerPath: string): Promise<OwnedProcess | undefined> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as OwnedProcess;
    const inspection = await defaultProcessController.inspect(owner.pid);
    return inspection && processIdentityMatches(owner, inspection) ? owner : undefined;
  } catch {
    return undefined;
  }
}

async function acquireDevLock(runtimeRoot: string): Promise<(() => Promise<void>) | undefined> {
  const lockPath = join(runtimeRoot, "dev.lock");
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(runtimeRoot, { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);
      const inspection = await defaultProcessController.inspect(process.pid);
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
        ready: true,
      };
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const owner = await readLiveLockOwner(ownerPath);
      if (owner) {
        process.stdout.write(`[dev] development stack is already supervised by PID ${owner.pid}\n`);
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function superviseDevStack(ports: DevPorts): Promise<number> {
  await mkdir(join(".forge", "dev"), { recursive: true });
  const services = [
    startService("Temporal", "temporal", ["server", "start-dev", "--port", String(ports.temporal), "--ui-port", String(ports.temporalUi), "--db-filename", ".forge/dev/temporal.db", "--namespace", "forge-dev", "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"]),
    startService("Forge", process.execPath, ["--import", "tsx", "src/cli.ts", "start", "--foreground"], {
      ...(ports.forge === undefined ? {} : { FORGE_PORT: String(ports.forge) }),
      FORGE_TEMPORAL_TARGET: "local",
      FORGE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
      FORGE_TEMPORAL_NAMESPACE: "forge-dev",
      FORGE_DEVELOPMENT_WATCH: "1",
      FORGE_FRONTEND_DEV_SERVER: "1",
    }),
  ];
  let shuttingDown = false;
  let requestedExitCode = 0;

  const stopServices = async (signal: NodeJS.Signals, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    requestedExitCode = exitCode;
    for (const service of services) {
      if (service.child.exitCode === null && service.child.signalCode === null) {
        service.child.kill(signal);
      }
    }

    const forceTimer = setTimeout(() => {
      for (const service of services) {
        if (service.child.exitCode === null && service.child.signalCode === null) {
          if (service.child.pid) {
            try {
              process.kill(-service.child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        }
      }
    }, 15_000);
    forceTimer.unref();
    await Promise.allSettled(services.map((service) => service.exited));
    clearTimeout(forceTimer);
  };

  const interrupt = (): void => void stopServices("SIGINT", 0);
  const terminate = (): void => void stopServices("SIGTERM", 0);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    const first = await Promise.race(services.map(async (service) => ({ service, result: await service.exited })));
    // mise and terminals signal the whole process group, so a child can report
    // its clean exit a moment before this supervisor receives the same signal.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!shuttingDown) {
      const detail = first.result.signal ? `signal ${first.result.signal}` : `exit code ${first.result.code ?? 1}`;
      const cleanExit = first.result.code === 0 || first.result.signal === "SIGINT" || first.result.signal === "SIGTERM";
      const message = `[dev] ${first.service.name} stopped (${detail}); stopping the development stack\n`;
      (cleanExit ? process.stdout : process.stderr).write(message);
      await stopServices("SIGTERM", cleanExit ? 0 : (first.result.code && first.result.code > 0 ? first.result.code : 1));
    } else {
      await Promise.allSettled(services.map((service) => service.exited));
    }
  } catch (error) {
    process.stderr.write(`[dev] could not supervise the development stack: ${error instanceof Error ? error.message : "unknown error"}\n`);
    await stopServices("SIGTERM", 1);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }

  return requestedExitCode;
}

async function main(): Promise<void> {
  const ports = resolveDevPorts(process.env.CONDUCTOR_PORT);
  const releaseLock = await acquireDevLock(loadConfig().runtimeRoot);
  if (!releaseLock) return;
  try {
    await runPreparation("type-checking", [tscCli, "--noEmit"]);
    process.exitCode = await superviseDevStack(ports);
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
