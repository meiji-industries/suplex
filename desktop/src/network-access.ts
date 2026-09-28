import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTailscaleAccess, removeTailscaleServeRoute } from "./tailscale";

export type NetworkAccess = "local" | "tailscale" | "all";

export type ResolvedNetworkAccess =
  | { readonly kind: "local" }
  | { readonly kind: "all" }
  | { readonly kind: "tailscale"; readonly hostname: string; readonly command: string };

export type ActiveNetworkAccess = {
  readonly kind: "owned";
  readonly access: ResolvedNetworkAccess;
  readonly port: number;
} | {
  readonly kind: "adopted";
  readonly port: number;
};

export type NetworkAccessState = {
  readonly preference: NetworkAccess;
  readonly active: ActiveNetworkAccess | null;
  readonly busy: boolean;
};

export type NetworkAccessChange =
  | { readonly kind: "active"; readonly active: ActiveNetworkAccess }
  | { readonly kind: "pending"; readonly preference: NetworkAccess; readonly reason: "stopped" | "adopted" };

export type NetworkAccessPorts = {
  readonly resolve: (preference: NetworkAccess) => Promise<ResolvedNetworkAccess>;
  readonly start: (access: ResolvedNetworkAccess) => Promise<{ readonly port: number; readonly adopted: boolean }>;
  readonly stop: () => Promise<void>;
  readonly removeServeRoute: (access: Extract<ResolvedNetworkAccess, { readonly kind: "tailscale" }>, port: number) => Promise<void>;
};

export class NetworkAccessCleanupError extends Error {
  constructor(
    message: string,
    readonly access: Extract<ResolvedNetworkAccess, { readonly kind: "tailscale" }>,
    readonly port: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NetworkAccessCleanupError";
  }
}

export async function readNetworkAccess(file: string): Promise<NetworkAccess> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value === "tailscale" || value === "all" ? value : "local";
  } catch {
    return "local";
  }
}

export async function writeNetworkAccess(file: string, access: NetworkAccess): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const staged = `${file}.staging`;
  await writeFile(staged, JSON.stringify(access), { mode: 0o600 });
  await rename(staged, file);
}

async function readCleanupPort(file: string): Promise<number | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value === "object" && value !== null && "port" in value) {
      const port = (value as { port?: unknown }).port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    }
    throw new Error("The saved network cleanup intent is invalid.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeCleanupPort(file: string, port: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const staged = `${file}.staging`;
  await writeFile(staged, JSON.stringify({ port }), { mode: 0o600 });
  await rename(staged, file);
}

export async function resolveNetworkAccess(preference: NetworkAccess): Promise<ResolvedNetworkAccess> {
  if (preference === "local") return { kind: "local" };
  if (preference === "all") return { kind: "all" };
  const tailscale = await resolveTailscaleAccess();
  return { kind: "tailscale", ...tailscale };
}

const preferenceOf = (access: ResolvedNetworkAccess): NetworkAccess => access.kind;

export function createNetworkAccessController(options: {
  readonly file: string;
  readonly cleanupFile?: string;
  readonly ports: Omit<NetworkAccessPorts, "resolve" | "removeServeRoute"> & Partial<Pick<NetworkAccessPorts, "resolve" | "removeServeRoute">>;
  readonly onStateChange?: (state: NetworkAccessState) => void;
}): {
  state(): NetworkAccessState;
  startPreferred(): Promise<ActiveNetworkAccess>;
  change(preference: NetworkAccess): Promise<NetworkAccessChange>;
  shutdown(): Promise<void>;
} {
  const resolve = options.ports.resolve ?? resolveNetworkAccess;
  const removeServeRoute = options.ports.removeServeRoute ?? removeTailscaleServeRoute;
  const cleanupFile = options.cleanupFile ?? join(dirname(options.file), "network-access-cleanup.json");
  let preference: NetworkAccess = "local";
  let active: ActiveNetworkAccess | null = null;
  let cleanupRequired: number | null = null;
  let busy = false;
  let queue = Promise.resolve();

  const state = (): NetworkAccessState => ({ preference, active, busy });
  const publish = (): void => { options.onStateChange?.(state()); };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      busy = true;
      publish();
      try { return await operation(); } finally { busy = false; publish(); }
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const start = async (access: ResolvedNetworkAccess): Promise<ActiveNetworkAccess> => {
    let started: { readonly port: number; readonly adopted: boolean };
    try {
      started = await options.ports.start(access);
    } catch (error) {
      if (error instanceof NetworkAccessCleanupError) {
        cleanupRequired = error.port;
        try { await writeCleanupPort(cleanupFile, error.port); } catch (writeError) {
          throw new AggregateError([error, writeError], "Suplex could not save its Tailscale cleanup intent.");
        }
      }
      throw error;
    }
    active = started.adopted ? { kind: "adopted", port: started.port } : { kind: "owned", access, port: started.port };
    publish();
    return active;
  };
  const stop = async (running: ActiveNetworkAccess): Promise<void> => {
    if (running.kind === "adopted") return;
    await options.ports.stop();
    active = null;
    publish();
    if (running.access.kind === "tailscale") {
      try {
        await removeServeRoute(running.access, running.port);
      } catch (error) {
        cleanupRequired = running.port;
        try { await writeCleanupPort(cleanupFile, running.port); } catch (writeError) {
          throw new AggregateError([error, writeError], "Suplex could not save its Tailscale cleanup intent.");
        }
        throw error;
      }
    }
  };
  const recoverCleanup = async (): Promise<void> => {
    const pending = cleanupRequired ?? await readCleanupPort(cleanupFile);
    if (pending === null) return;
    const access = await resolve("tailscale");
    if (access.kind !== "tailscale") throw new Error("Tailscale cleanup did not resolve Tailscale access.");
    await removeServeRoute(access, pending);
    await rm(cleanupFile, { force: true });
    cleanupRequired = null;
  };

  return {
    state,
    startPreferred: () => serialize(async () => {
      preference = await readNetworkAccess(options.file);
      await recoverCleanup();
      const resolved = await resolve(preference);
      return start(resolved);
    }),
    change: (requested) => serialize(async () => {
      const previous = active;
      if (previous?.kind === "owned" && previous.access.kind === requested) {
        preference = requested;
        await writeNetworkAccess(options.file, requested);
        return { kind: "active", active: previous };
      }

      const next = await resolve(requested);
      if (previous === null || previous.kind === "adopted") {
        await recoverCleanup();
        preference = requested;
        await writeNetworkAccess(options.file, requested);
        return { kind: "pending", preference: requested, reason: previous === null ? "stopped" : "adopted" };
      }

      const previousPreference = preferenceOf(previous.access);
      await writeNetworkAccess(options.file, requested);
      preference = requested;
      let transitionError: unknown;
      try {
        await stop(previous);
        const running = await start(next);
        return { kind: "active", active: running };
      } catch (error) {
        transitionError = error;
      }

      if (cleanupRequired !== null) {
        try {
          await writeNetworkAccess(options.file, "tailscale");
          preference = "tailscale";
        } catch (preferenceError) {
          throw new AggregateError([transitionError, preferenceError], "Suplex could not preserve the safe Tailscale recovery mode.");
        }
        throw transitionError;
      }

      if (active?.kind === "owned" && active.access.kind === next.kind) {
        try {
          await stop(active);
        } catch (cleanupError) {
          throw new AggregateError([transitionError, cleanupError], "Suplex could not change network access or safely restore the previous mode.");
        }
      }

      if (active === null) {
        try {
          const restored = await resolve(previousPreference);
          await start(restored);
          await writeNetworkAccess(options.file, previousPreference);
          preference = previousPreference;
        } catch (restoreError) {
          throw new AggregateError([transitionError, restoreError], "Suplex could not change network access or restore the previous mode.");
        }
      }
      throw transitionError;
    }),
    shutdown: () => serialize(async () => {
      const running = active;
      if (running === null || running.kind === "adopted") { await recoverCleanup(); return; }
      await stop(running);
    }),
  };
}
