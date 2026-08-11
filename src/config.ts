import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AccessMode = "tailscale";
export type TailscaleExposure = "direct" | "serve";

export interface ForgeConfig {
  accessMode: AccessMode;
  tailscaleExposure: TailscaleExposure;
  bindAddress: string;
  reachableAddress: string;
  port: number;
  dataRoot: string;
  databasePath: string;
  artifactRoot: string;
  runtimeRoot: string;
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
}

export class UnsafeBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBindingError";
  }
}

function isTailscaleIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127;
}

function isTailscaleAddress(address: string): boolean {
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
    throw new Error(`FORGE_PORT must be an integer between 1 and 65535; received ${rawPort ?? ""}`);
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const environmentFile = environment.FORGE_ENV_FILE ?? (environment === process.env ? ".forge/forge.env" : undefined);
  const fileEnvironment = environmentFile ? readEnvironmentFile(environmentFile) : {};
  const configuredEnvironment: NodeJS.ProcessEnv = { ...fileEnvironment, ...environment };
  const accessMode = configuredEnvironment.FORGE_ACCESS_MODE ?? "tailscale";
  if (accessMode !== "tailscale") {
    throw new UnsafeBindingError(`Forge only supports Tailscale-only access; received ${accessMode}`);
  }

  const tailscaleExposure = configuredEnvironment.FORGE_TAILSCALE_EXPOSURE ?? "direct";
  if (tailscaleExposure !== "direct" && tailscaleExposure !== "serve") {
    throw new UnsafeBindingError(`FORGE_TAILSCALE_EXPOSURE must be direct or serve; received ${tailscaleExposure}`);
  }
  const configuredAddress = configuredEnvironment.FORGE_TAILSCALE_ADDRESS?.trim();
  const bindAddress = configuredEnvironment.FORGE_BIND_ADDRESS?.trim() || configuredAddress;
  if (!bindAddress) {
    throw new UnsafeBindingError("FORGE_TAILSCALE_ADDRESS is required for Tailscale-only startup");
  }
  const loopbackServeBinding = tailscaleExposure === "serve" && (bindAddress === "127.0.0.1" || bindAddress === "::1");
  if (!loopbackServeBinding && !isTailscaleAddress(bindAddress)) {
    throw new UnsafeBindingError(`Refusing non-Tailscale bind address: ${bindAddress}`);
  }
  if (configuredAddress && !isTailscaleAddress(configuredAddress)) {
    throw new UnsafeBindingError(`Refusing non-Tailscale reachable address: ${configuredAddress}`);
  }

  if (tailscaleExposure === "serve" && !configuredAddress) {
    throw new UnsafeBindingError("FORGE_TAILSCALE_ADDRESS is required when Tailscale Serve HTTPS is enabled");
  }
  const port = parsePort(configuredEnvironment.FORGE_PORT);
  const dataRoot = resolve(configuredEnvironment.FORGE_DATA_ROOT ?? ".forge/data");
  const reachableHost = configuredAddress ?? bindAddress;
  const scheme = tailscaleExposure === "serve" ? "https" : "http";
  return {
    accessMode,
    tailscaleExposure,
    bindAddress,
    reachableAddress: `${scheme}${formatReachableAddress(reachableHost, port).slice(4)}`,
    port,
    dataRoot,
    databasePath: configuredEnvironment.FORGE_DATABASE_PATH ? resolve(configuredEnvironment.FORGE_DATABASE_PATH) : resolve(dataRoot, "forge.sqlite"),
    artifactRoot: configuredEnvironment.FORGE_ARTIFACT_ROOT ? resolve(configuredEnvironment.FORGE_ARTIFACT_ROOT) : resolve(dataRoot, "artifacts"),
    runtimeRoot: configuredEnvironment.FORGE_RUNTIME_ROOT ? resolve(configuredEnvironment.FORGE_RUNTIME_ROOT) : resolve(dataRoot, "runtime"),
    temporalAddress: configuredEnvironment.FORGE_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    temporalNamespace: configuredEnvironment.FORGE_TEMPORAL_NAMESPACE ?? "forge",
    taskQueue: configuredEnvironment.FORGE_TASK_QUEUE ?? "forge",
  };
}

export function createTestConfig(dataRoot: string, overrides: Partial<ForgeConfig> = {}): ForgeConfig {
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
    databasePath: overrides.databasePath ?? resolve(dataRoot, "forge.sqlite"),
    artifactRoot: overrides.artifactRoot ?? resolve(dataRoot, "artifacts"),
    runtimeRoot: overrides.runtimeRoot ?? resolve(dataRoot, "runtime"),
    temporalAddress: overrides.temporalAddress ?? "127.0.0.1:7233",
    temporalNamespace: overrides.temporalNamespace ?? "forge",
    taskQueue: overrides.taskQueue ?? "forge",
  };
}
