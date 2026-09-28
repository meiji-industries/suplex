import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedNetworkAccess } from "./network-access";

export const DEFAULT_PORT = 4111;

/** Where the boot sequence is. `failed` is latched: only a retry leaves it. */
export type BootState =
  | { readonly name: "resolve" }
  | { readonly name: "bootstrap-needed" }
  | { readonly name: "choosing" }
  | { readonly name: "installing"; readonly from: string | null }
  | { readonly name: "ready" }
  | { readonly name: "starting" }
  | { readonly name: "connecting-remote"; readonly url: string | null }
  | { readonly name: "connected"; readonly url: string }
  | { readonly name: "failed"; readonly failure: BootFailure };

export type BootFailure = {
  readonly from: "installing" | "starting";
  readonly title: string;
  readonly reason: string;
  readonly remedy: string | null;
  readonly stage: string | null;
  readonly log: readonly string[];
};

export type BootEvent =
  | { readonly name: "shown" }
  | { readonly name: "choose"; readonly mode: "local" | "remote" }
  | { readonly name: "installed" }
  | { readonly name: "launch" }
  | { readonly name: "connected"; readonly url: string }
  | { readonly name: "failed"; readonly failure: BootFailure }
  | { readonly name: "retry" }
  | { readonly name: "back" };

/** Written once the install finishes; read on every launch to decide whether to start the local server. */
export type InstallRecord = {
  readonly completedAt: string;
  readonly runtimeStamp: string;
  readonly port: number;
};

export function next(state: BootState, event: BootEvent): BootState {
  if (state.name === "failed") {
    if (event.name !== "retry") return state;
    return state.failure.from === "installing" ? { name: "installing", from: state.failure.stage } : { name: "starting" };
  }
  switch (event.name) {
    case "shown":
      return state.name === "bootstrap-needed" ? { name: "choosing" } : state;
    case "choose":
      if (state.name !== "choosing") return state;
      return event.mode === "local" ? { name: "installing", from: null } : { name: "connecting-remote", url: null };
    case "installed":
      return state.name === "installing" ? { name: "ready" } : state;
    case "launch":
      return state.name === "ready" ? { name: "starting" } : state;
    case "connected":
      return { name: "connected", url: event.url };
    case "failed":
      return { name: "failed", failure: event.failure };
    case "retry":
      return state;
    case "back":
      return state.name === "connecting-remote" ? { name: "choosing" } : state;
    default:
      return state;
  }
}

/** A local install resumes locally. A new bundle runs its idempotent install stages before starting. */
export function resolveBoot(input: { readonly record: InstallRecord | null; readonly stamp: string | null; readonly remote: string | null }): BootState {
  if (input.record !== null) return input.stamp !== null && input.record.runtimeStamp !== input.stamp ? { name: "installing", from: null } : { name: "starting" };
  if (input.remote !== null) return { name: "connecting-remote", url: input.remote };
  return { name: "bootstrap-needed" };
}

export type RuntimePaths = { readonly binary: string; readonly directory: string };

/** Packaged builds carry the native runtime in Resources/runtime. Dev points at its Rust build. */
export function runtimePaths(environment: NodeJS.ProcessEnv, resourcesPath: string): RuntimePaths {
  const directory = environment.SUPLEX_DESKTOP_RUNTIME ?? join(resourcesPath, "runtime");
  return {
    binary: environment.SUPLEX_DESKTOP_BINARY ?? join(directory, "bin", "suplex"),
    directory,
  };
}

/** Identifies the runtime shipped in this bundle, so a desktop update reruns the install stages. */
export async function runtimeStamp(directory: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function readInstallRecord(file: string): Promise<InstallRecord | null> {
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as Partial<InstallRecord>;
    if (typeof record.completedAt !== "string" || typeof record.runtimeStamp !== "string" || typeof record.port !== "number") return null;
    return { completedAt: record.completedAt, runtimeStamp: record.runtimeStamp, port: record.port };
  } catch {
    return null;
  }
}

export async function writeInstallRecord(file: string, record: InstallRecord): Promise<void> {
  await writeFile(file, JSON.stringify(record));
}

/** C2's environment for both the supervisor and the install CLI. */
export function runtimeEnvironment(input: { readonly userData: string; readonly port: number; readonly base: NodeJS.ProcessEnv; readonly access: ResolvedNetworkAccess }): Record<string, string> {
  const home = input.base.HOME ?? homedir();
  const common = {
    SUPLEX_PACKAGED: "1",
    SUPLEX_BIND_ADDRESS: "127.0.0.1",
    SUPLEX_PORT: String(input.port),
    SUPLEX_DATA_ROOT: join(input.userData, "data"),
    SUPLEX_ENV_FILE: join(input.userData, "suplex.env"),
    SUPLEX_REPOSITORY_ROOT: join(home, "suplex", "repos"),
    SUPLEX_WORKTREE_ROOT: join(home, "suplex", "worktrees"),
    HOME: home,
    USER: input.base.USER ?? "",
    TMPDIR: input.base.TMPDIR ?? tmpdir(),
    PATH: `${home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  if (input.access.kind === "local") return { ...common, SUPLEX_ACCESS_MODE: "local" };
  if (input.access.kind === "all") return { ...common, SUPLEX_ACCESS_MODE: "all", SUPLEX_BIND_ADDRESS: "0.0.0.0" };
  return {
    ...common,
    SUPLEX_ACCESS_MODE: "tailscale",
    SUPLEX_TAILSCALE_EXPOSURE: "serve",
    SUPLEX_TAILSCALE_ADDRESS: input.access.hostname,
    SUPLEX_TAILSCALE_COMMAND: input.access.command,
  };
}
