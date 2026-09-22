import { isIP } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { SuplexConfigSchema, SuplexEnvironmentSchema } from "./schemas.js";

export type AccessMode = "tailscale" | "local";
export type TailscaleExposure = "direct" | "serve";

export interface SuplexConfig {
  accessMode: AccessMode;
  tailscaleExposure: TailscaleExposure;
  bindAddress: string;
  reachableAddress: string;
  port: number;
  dataRoot: string;
  databasePath: string;
  artifactRoot: string;
  runtimeRoot: string;
  repositoryRoot: string;
  worktreeRoot: string;
  installationId: string;
  developmentAutoLogin: boolean;
}

export class UnsafeBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBindingError";
  }
}

export class UnsupportedRuntimeError extends Error {
  constructor(supportedVersion: string, foundVersion: string) {
    super(`Suplex requires Node.js ${supportedVersion}; found ${foundVersion}`);
    this.name = "UnsupportedRuntimeError";
  }
}

export const SUPPORTED_NODE_VERSION = "26.7.0";

/** SUPLEX_EDITOR_COMMAND selects the editor command used when Suplex opens a task worktree. */
function assertSupportedNodeRuntime(): void {
  if (process.versions.node !== SUPPORTED_NODE_VERSION) {
    throw new UnsupportedRuntimeError(SUPPORTED_NODE_VERSION, process.versions.node);
  }
}

function isTailscaleIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127;
}

export function isTailscaleAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (!normalized || normalized === "*" || normalized === "localhost") {
    return false;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isTailscaleIpv4(normalized);
  }
  if (ipVersion === 6) {
    return normalized.startsWith("fd7a:115c:a1e0:");
  }

  return normalized.endsWith(".ts.net") && !normalized.includes("/") && !normalized.includes(" ");
}

function parsePort(rawPort: string | undefined): number {
  const port = Number(rawPort ?? "4111");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SUPLEX_PORT must be an integer between 1 and 65535; received ${rawPort ?? ""}`);
  }
  return port;
}

function formatReachableAddress(address: string, port: number): string {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

function readEnvironmentFile(filename: string): Record<string, string> {
  try {
    const contents = readFileSync(filename, "utf8");
    return Object.fromEntries(
      contents.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || !match[1] || match[2] === undefined) {
          return [];
        }
        const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
        return [[match[1], value]];
      }),
    );
  } catch {
    return {};
  }
}

function installationId(dataRoot: string, environment: { SUPLEX_INSTALLATION_ID?: string | undefined }, persist: boolean): string {
  const configured = environment.SUPLEX_INSTALLATION_ID?.trim();
  if (configured) {
    return configured;
  }
  if (!persist) {
    return "test-installation";
  }
  const filename = resolve(dataRoot, "../installation-id");
  try {
    const existing = readFileSync(filename, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // The first real startup creates the stable installation identity below.
  }
  const generated = randomBytes(12).toString("hex");
  mkdirSync(resolve(dataRoot, ".."), { recursive: true });
  writeFileSync(filename, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  return generated;
}

type Binding = { tailscaleExposure: TailscaleExposure; bindAddress: string; reachableHost: string; scheme: "http" | "https" };

type SuplexEnvironment = ReturnType<typeof SuplexEnvironmentSchema.parse>;

/** Loopback is the whole boundary in local mode, so the Tailscale settings are ignored rather than validated. */
function localBinding(environment: SuplexEnvironment): Binding {
  const bindAddress = environment.SUPLEX_BIND_ADDRESS?.trim() || "127.0.0.1";
  if (bindAddress !== "127.0.0.1" && bindAddress !== "::1") {
    throw new UnsafeBindingError(`Local access binds loopback only; received ${bindAddress}`);
  }
  return { tailscaleExposure: "direct", bindAddress, reachableHost: bindAddress, scheme: "http" };
}

function tailscaleBinding(environment: SuplexEnvironment): Binding {
  const tailscaleExposure = environment.SUPLEX_TAILSCALE_EXPOSURE ?? "direct";
  if (tailscaleExposure !== "direct" && tailscaleExposure !== "serve") {
    throw new UnsafeBindingError(`SUPLEX_TAILSCALE_EXPOSURE must be direct or serve; received ${tailscaleExposure}`);
  }
  const configuredAddress = environment.SUPLEX_TAILSCALE_ADDRESS?.trim();
  const bindAddress = environment.SUPLEX_BIND_ADDRESS?.trim() || configuredAddress;
  if (!bindAddress) {
    throw new UnsafeBindingError("SUPLEX_TAILSCALE_ADDRESS is required for Tailscale-only startup");
  }
  const loopbackServeBinding = tailscaleExposure === "serve" && (bindAddress === "127.0.0.1" || bindAddress === "::1");
  if (!loopbackServeBinding && !isTailscaleAddress(bindAddress)) {
    throw new UnsafeBindingError(`Refusing non-Tailscale bind address: ${bindAddress}`);
  }
  if (configuredAddress && !isTailscaleAddress(configuredAddress)) {
    throw new UnsafeBindingError(`Refusing non-Tailscale reachable address: ${configuredAddress}`);
  }
  if (tailscaleExposure === "serve" && !configuredAddress) {
    throw new UnsafeBindingError("SUPLEX_TAILSCALE_ADDRESS is required when Tailscale Serve HTTPS is enabled");
  }
  return { tailscaleExposure, bindAddress, reachableHost: configuredAddress ?? bindAddress, scheme: tailscaleExposure === "serve" ? "https" : "http" };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SuplexConfig {
  assertSupportedNodeRuntime();
  const environmentFile = environment.SUPLEX_ENV_FILE ?? (environment === process.env ? ".suplex/suplex.env" : undefined);
  const fileEnvironment = environmentFile ? readEnvironmentFile(environmentFile) : {};
  const configuredEnvironment: NodeJS.ProcessEnv = { ...fileEnvironment, ...environment };
  const parsedEnvironment = SuplexEnvironmentSchema.safeParse(configuredEnvironment);
  if (!parsedEnvironment.success) {
    throw new UnsafeBindingError(`Suplex environment is invalid: ${parsedEnvironment.error.issues[0]?.message ?? "unknown error"}`);
  }
  const accessMode = parsedEnvironment.data.SUPLEX_ACCESS_MODE ?? "tailscale";
  const { tailscaleExposure, bindAddress, reachableHost, scheme } = accessMode === "local"
    ? localBinding(parsedEnvironment.data)
    : tailscaleBinding(parsedEnvironment.data);
  const port = parsePort(parsedEnvironment.data.SUPLEX_PORT);
  const dataRoot = resolve(parsedEnvironment.data.SUPLEX_DATA_ROOT ?? ".suplex/data");
  const stableInstallationId = installationId(dataRoot, parsedEnvironment.data, environment === process.env);
  return SuplexConfigSchema.parse({
    accessMode,
    tailscaleExposure,
    bindAddress,
    reachableAddress: `${scheme}${formatReachableAddress(reachableHost, port).slice(4)}`,
    port,
    dataRoot,
    databasePath: parsedEnvironment.data.SUPLEX_DATABASE_PATH ? resolve(parsedEnvironment.data.SUPLEX_DATABASE_PATH) : resolve(dataRoot, "suplex.sqlite"),
    artifactRoot: parsedEnvironment.data.SUPLEX_ARTIFACT_ROOT ? resolve(parsedEnvironment.data.SUPLEX_ARTIFACT_ROOT) : resolve(dataRoot, "artifacts"),
    runtimeRoot: parsedEnvironment.data.SUPLEX_RUNTIME_ROOT ? resolve(parsedEnvironment.data.SUPLEX_RUNTIME_ROOT) : resolve(dataRoot, "runtime"),
    repositoryRoot: resolve(parsedEnvironment.data.SUPLEX_REPOSITORY_ROOT ?? resolve(homedir(), "suplex", "repos")),
    worktreeRoot: resolve(parsedEnvironment.data.SUPLEX_WORKTREE_ROOT ?? resolve(homedir(), "suplex", "worktrees")),
    installationId: stableInstallationId,
    developmentAutoLogin: parsedEnvironment.data.SUPLEX_DEVELOPMENT_AUTO_LOGIN === "1",
  });
}

export function createTestConfig(dataRoot: string, overrides: Partial<SuplexConfig> = {}): SuplexConfig {
  const port = overrides.port ?? 4111;
  const bindAddress = overrides.bindAddress ?? "127.0.0.1";
  const tailscaleExposure = overrides.tailscaleExposure ?? "direct";
  return {
    accessMode: "tailscale",
    tailscaleExposure,
    bindAddress,
    reachableAddress: overrides.reachableAddress ?? `http://${bindAddress}:${port}`,
    port,
    dataRoot,
    databasePath: overrides.databasePath ?? resolve(dataRoot, "suplex.sqlite"),
    artifactRoot: overrides.artifactRoot ?? resolve(dataRoot, "artifacts"),
    runtimeRoot: overrides.runtimeRoot ?? resolve(dataRoot, "runtime"),
    repositoryRoot: overrides.repositoryRoot ?? resolve(dataRoot, "repositories"),
    worktreeRoot: overrides.worktreeRoot ?? resolve(dataRoot, "worktrees"),
    installationId: overrides.installationId ?? "test-installation",
    developmentAutoLogin: overrides.developmentAutoLogin ?? false,
  };
}
