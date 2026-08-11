import { isIP } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { ForgeConfigSchema, ForgeEnvironmentSchema } from "./schemas.js";
import { isLegacyDurableIdentifier, runtimeIdentifiers } from "./runtime-identifiers.js";

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
  installationId: string;
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

function installationId(dataRoot: string, environment: { FORGE_INSTALLATION_ID?: string | undefined }, persist: boolean): string {
  const configured = environment.FORGE_INSTALLATION_ID?.trim();
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const environmentFile = environment.FORGE_ENV_FILE ?? (environment === process.env ? ".forge/forge.env" : undefined);
  const fileEnvironment = environmentFile ? readEnvironmentFile(environmentFile) : {};
  const configuredEnvironment: NodeJS.ProcessEnv = { ...fileEnvironment, ...environment };
  const parsedEnvironment = ForgeEnvironmentSchema.safeParse(configuredEnvironment);
  if (!parsedEnvironment.success) {
    throw new UnsafeBindingError(`Forge environment is invalid: ${parsedEnvironment.error.issues[0]?.message ?? "unknown error"}`);
  }
  const accessMode = parsedEnvironment.data.FORGE_ACCESS_MODE ?? "tailscale";
  if (accessMode !== "tailscale") {
    throw new UnsafeBindingError(`Forge only supports Tailscale-only access; received ${accessMode}`);
  }

  const tailscaleExposure = parsedEnvironment.data.FORGE_TAILSCALE_EXPOSURE ?? "direct";
  if (tailscaleExposure !== "direct" && tailscaleExposure !== "serve") {
    throw new UnsafeBindingError(`FORGE_TAILSCALE_EXPOSURE must be direct or serve; received ${tailscaleExposure}`);
  }
  const configuredAddress = parsedEnvironment.data.FORGE_TAILSCALE_ADDRESS?.trim();
  const bindAddress = parsedEnvironment.data.FORGE_BIND_ADDRESS?.trim() || configuredAddress;
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
  const port = parsePort(parsedEnvironment.data.FORGE_PORT);
  const dataRoot = resolve(parsedEnvironment.data.FORGE_DATA_ROOT ?? ".forge/data");
  const reachableHost = configuredAddress ?? bindAddress;
  const scheme = tailscaleExposure === "serve" ? "https" : "http";
  const stableInstallationId = installationId(dataRoot, parsedEnvironment.data, environment === process.env);
  const identifiers = runtimeIdentifiers(stableInstallationId);
  const temporalNamespace = parsedEnvironment.data.FORGE_TEMPORAL_NAMESPACE ?? identifiers.namespace;
  const taskQueue = parsedEnvironment.data.FORGE_TASK_QUEUE ?? identifiers.taskQueue;
  if (isLegacyDurableIdentifier(temporalNamespace) || isLegacyDurableIdentifier(taskQueue)) {
    throw new UnsafeBindingError("Refusing legacy Forge namespace or task queue; preserve the legacy runtime and migrate explicitly");
  }
  return ForgeConfigSchema.parse({
    accessMode,
    tailscaleExposure,
    bindAddress,
    reachableAddress: `${scheme}${formatReachableAddress(reachableHost, port).slice(4)}`,
    port,
    dataRoot,
    databasePath: parsedEnvironment.data.FORGE_DATABASE_PATH ? resolve(parsedEnvironment.data.FORGE_DATABASE_PATH) : resolve(dataRoot, "forge.sqlite"),
    artifactRoot: parsedEnvironment.data.FORGE_ARTIFACT_ROOT ? resolve(parsedEnvironment.data.FORGE_ARTIFACT_ROOT) : resolve(dataRoot, "artifacts"),
    runtimeRoot: parsedEnvironment.data.FORGE_RUNTIME_ROOT ? resolve(parsedEnvironment.data.FORGE_RUNTIME_ROOT) : resolve(dataRoot, "runtime"),
    temporalAddress: parsedEnvironment.data.FORGE_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    temporalNamespace,
    taskQueue,
    installationId: stableInstallationId,
  });
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
    temporalNamespace: overrides.temporalNamespace ?? runtimeIdentifiers(overrides.installationId ?? "test-installation").namespace,
    taskQueue: overrides.taskQueue ?? runtimeIdentifiers(overrides.installationId ?? "test-installation").taskQueue,
    installationId: overrides.installationId ?? "test-installation",
  };
}
