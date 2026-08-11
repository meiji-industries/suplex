import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ForgeConfig } from "./config.js";
import { TailscaleServeStatusSchema, TailscaleStatusSchema } from "./schemas.js";

const execFileAsync = promisify(execFile);

export async function discoverTailscaleHostname(command = "tailscale"): Promise<string> {
  const result = await execFileAsync(command, ["status", "--json"], { timeout: 5_000, maxBuffer: 256 * 1024 });
  const hostname = parseTailscaleHostname(result.stdout);
  return hostname;
}

export function parseTailscaleHostname(raw: string): string {
  const status = TailscaleStatusSchema.parse(JSON.parse(raw));
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
  let status: ReturnType<typeof TailscaleServeStatusSchema.parse>;
  try {
    status = parseTailscaleServeStatus(result.stdout);
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

export function parseTailscaleServeStatus(raw: string): ReturnType<typeof TailscaleServeStatusSchema.parse> {
  return TailscaleServeStatusSchema.parse(JSON.parse(raw));
}

export async function disableTailscaleServe(port: number, command = "tailscale"): Promise<void> {
  await execFileAsync(command, ["serve", `--https=${port}`, "off"], { timeout: 10_000, maxBuffer: 16 * 1024 });
}
