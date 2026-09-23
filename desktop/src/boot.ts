import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

/** The install record wins over a remembered remote target; a runtime that no longer matches sends the user back to the choice screen. */
export function resolveBoot(input: { readonly record: InstallRecord | null; readonly stamp: string | null; readonly remote: string | null }): BootState {
  if (input.record !== null && input.stamp !== null && input.record.runtimeStamp === input.stamp) return { name: "starting" };
  if (input.remote !== null) return { name: "connecting-remote", url: input.remote };
  return { name: "bootstrap-needed" };
}

export type RuntimePaths = { readonly node: string; readonly app: string; readonly cli: string; readonly supervisor: string };

/** Packaged builds carry the runtime in Resources/runtime. The overrides point dev at the pinned node and the checkout, with no symlinked layout in between. */
export function runtimePaths(environment: NodeJS.ProcessEnv, resourcesPath: string): RuntimePaths {
  const app = environment.SUPLEX_DESKTOP_APP ?? join(resourcesPath, "runtime", "app");
  return {
    node: environment.SUPLEX_DESKTOP_NODE ?? join(resourcesPath, "runtime", "node", "bin", "node"),
    app,
    cli: join(app, "dist", "src", "cli.js"),
    supervisor: join(app, "dist", "src", "platform", "updates", "supervisor.js"),
  };
}

/** Identifies the runtime shipped in this bundle, so a desktop update reruns the install stages. */
export async function runtimeStamp(app: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as { version?: unknown };
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
export function runtimeEnvironment(input: { readonly userData: string; readonly port: number; readonly base: NodeJS.ProcessEnv }): Record<string, string> {
  const home = input.base.HOME ?? homedir();
  return {
    SUPLEX_PACKAGED: "1",
    SUPLEX_ACCESS_MODE: "local",
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
}
