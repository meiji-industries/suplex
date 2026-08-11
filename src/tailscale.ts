import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";

const execFileAsync = promisify(execFile);

interface TailscaleStatus {
  Self?: {
    DNSName?: string;
  };
}

interface TailscaleServeStatus {
  Web?: Record<string, {
    Handlers?: Record<string, { Proxy?: string }>;
  }>;
}

export async function discoverTailscaleHostname(command = "tailscale"): Promise<string> {
  const result = await execFileAsync(command, ["status", "--json"], { timeout: 5_000, maxBuffer: 256 * 1024 });
  const status = JSON.parse(result.stdout) as TailscaleStatus;
  const hostname = status.Self?.DNSName?.replace(/\.$/, "");
  if (!hostname || !hostname.endsWith(".ts.net")) {
    throw new Error("Tailscale did not report a MagicDNS hostname");
  }
  return hostname;
}

export async function configureTailscaleServe(config: ForgeConfig, command = "tailscale"): Promise<void> {
  await execFileAsync(command, [
    "serve",
    "--bg",
    `--https=${config.port}`,
    `http://${config.bindAddress}:${config.port}`,
  ], { timeout: 10_000, maxBuffer: 16 * 1024 });
}

export async function verifyTailscaleServe(config: ForgeConfig, command = "tailscale"): Promise<void> {
  const result = await execFileAsync(command, ["serve", "status", "--json"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  let status: TailscaleServeStatus;
  try {
    status = JSON.parse(result.stdout) as TailscaleServeStatus;
  } catch {
    throw new Error("Tailscale Serve returned invalid status JSON");
  }
  const route = `${new URL(config.reachableAddress).hostname}:${config.port}`;
  const proxy = status.Web?.[route]?.Handlers?.["/"]?.Proxy;
  const expectedProxy = `http://${config.bindAddress}:${config.port}`;
  if (proxy !== expectedProxy) {
    throw new Error(`Tailscale Serve is not forwarding ${route} to ${expectedProxy}`);
  }
}

export async function disableTailscaleServe(port: number, command = "tailscale"): Promise<void> {
  await execFileAsync(command, ["serve", `--https=${port}`, "off"], { timeout: 10_000, maxBuffer: 16 * 1024 });
}
