import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { runtimeEnvironment, type RuntimePaths } from "./boot";

const POLL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

export type LocalServer = { readonly port: number; readonly adopted: boolean };

export type LocalRuntimePorts = {
  readonly spawn: (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
  readonly healthy: (origin: string) => Promise<boolean>;
  readonly servedInstallation: (origin: string) => Promise<string | null>;
  readonly freePort: (preferred: number) => Promise<number>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: (ms: number) => Promise<void>;
};

export type LocalRuntime = {
  start(): Promise<LocalServer>;
  stop(): Promise<void>;
};

/** `GET <origin>/health` answering 200. Also the remote target's Test connection. */
export async function healthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(2_000), redirect: "manual" });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** The installation id a healthy server at `origin` reports, or null. */
export async function servedInstallation(origin: string): Promise<string | null> {
  try {
    const response = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(2_000), redirect: "manual" });
    return response.status === 200 ? response.headers.get("x-suplex-installation-id") : null;
  } catch {
    return null;
  }
}

function listenable(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => { resolve(null); });
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const address = probe.address();
      probe.close(() => { resolve(typeof address === "object" && address !== null ? address.port : null); });
    });
  });
}

/** The preferred port when it can still be bound, otherwise whatever the kernel hands out. */
export async function freePort(preferred: number): Promise<number> {
  const port = (await listenable(preferred)) ?? (await listenable(0));
  if (port === null) throw new Error("No local port is available for Suplex.");
  return port;
}

/**
 * Starts, adopts, and stops the packaged server. Detached so the whole process group can be
 * signalled; an adopted server of this installation that we did not start is never signalled at all.
 */
export function createLocalRuntime(options: {
  readonly runtime: RuntimePaths;
  readonly userData: string;
  readonly port: number;
  readonly base: NodeJS.ProcessEnv;
  readonly ports?: Partial<LocalRuntimePorts>;
}): LocalRuntime {
  const spawn = options.ports?.spawn ?? spawnChild;
  const probe = options.ports?.healthy ?? healthy;
  const served = options.ports?.servedInstallation ?? servedInstallation;
  const choosePort = options.ports?.freePort ?? freePort;
  const kill = options.ports?.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
  const wait = options.ports?.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const origin = (port: number): string => `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let exited: number | null = null;

  const groupSignal = (signal: NodeJS.Signals): void => {
    if (child?.pid === undefined || exited !== null) return;
    try {
      kill(-child.pid, signal);
    } catch {
      /* the group is already gone */
    }
  };

  return {
    async start(): Promise<LocalServer> {
      // A server left over from a deleted data folder, or a dev checkout, can hold the port; adopt only ours.
      const own = (await readFile(join(options.userData, "installation-id"), "utf8").catch(() => "")).trim();
      if (own !== "" && (await served(origin(options.port))) === own) return { port: options.port, adopted: true };
      const port = await choosePort(options.port);
      const paths = options.runtime;
      await mkdir(join(options.userData, "logs"), { recursive: true });
      const log = createWriteStream(join(options.userData, "logs", "server.log"), { flags: "a" });
      exited = null;
      child = spawn(paths.binary, ["start", "--foreground"], {
        cwd: paths.directory,
        env: runtimeEnvironment({ userData: options.userData, port, base: options.base }),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.once("exit", (code) => { exited = code ?? 0; });
      child.once("error", () => { exited = -1; });
      for (let waited = 0; waited < READY_TIMEOUT_MS; waited += POLL_MS) {
        await wait(POLL_MS);
        if (await probe(origin(port))) return { port, adopted: false };
        if (exited !== null) throw new Error(`The Suplex server stopped while starting (exit ${exited}). The log is in logs/server.log.`);
      }
      groupSignal("SIGKILL");
      throw new Error(`The Suplex server did not answer ${origin(port)}/health within 60 seconds. The log is in logs/server.log.`);
    },
    async stop(): Promise<void> {
      if (child === undefined) return;
      const running = child;
      groupSignal("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => { if (exited !== null) resolve(); else running.once("exit", () => { resolve(); }); }),
        wait(STOP_TIMEOUT_MS),
      ]);
      groupSignal("SIGKILL");
      child = undefined;
    },
  };
}
