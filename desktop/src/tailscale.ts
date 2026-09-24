import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TailnetMachine = { readonly name: string; readonly host: string; readonly online: boolean };

/** What the Tailscale service on this Mac reports. `tailnet` and `machines` are known only after a sign-in. */
export type TailscaleStatus = {
  readonly state: "missing" | "not-running" | "signed-out" | "approval" | "off" | "starting" | "on";
  readonly tailnet: string | null;
  readonly machines: readonly TailnetMachine[];
};

/** A GUI app does not inherit the shell's PATH, so try the App Store bundle and the Homebrew locations too. */
const COMMANDS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"];

/** Without this, the App Store binary starts as the GUI when an app runs it, prints "The Tailscale GUI failed to start", and exits 0. */
const run = async (command: string, args: readonly string[], timeout: number): Promise<string> =>
  (await execFileAsync(command, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TAILSCALE_BE_CLI: "1" } })).stdout;

/** Phones and tablets cannot run Suplex, and Mullvad exit nodes (the peers with a Location) are not machines you own. */
const HANDHELD = new Set(["ios", "android"]);

const STATES: Record<string, TailscaleStatus["state"]> = { Running: "on", Stopped: "off", Starting: "starting", NoState: "starting", NeedsLogin: "signed-out", NeedsMachineAuth: "approval" };

/** Tailscale on this Mac: installed or not, signed in or not, on or off, and the other machines on its tailnet, online first. */
export async function tailscaleStatus(commands: readonly string[] = COMMANDS): Promise<TailscaleStatus> {
  let installed = false;
  for (const command of commands) {
    try {
      const status = parseTailscaleStatus(await run(command, ["status", "--json"], 5_000));
      installed = true;
      if (status) return status;
    } catch (error) {
      // A CLI that is present but cannot reach the Tailscale service means Tailscale is installed and not running.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") installed = true;
    }
  }
  return { state: installed ? "not-running" : "missing", tailnet: null, machines: [] };
}

export function parseTailscaleStatus(raw: string): TailscaleStatus | null {
  let status: {
    BackendState?: unknown;
    CurrentTailnet?: { Name?: unknown } | null;
    Peer?: Record<string, { DNSName?: unknown; OS?: unknown; Online?: unknown; Location?: unknown }> | null;
  };
  try { status = JSON.parse(raw) as typeof status; } catch { return null; }
  const state = typeof status.BackendState === "string" ? STATES[status.BackendState] : undefined;
  if (state === undefined) return null;
  const machines = Object.values(status.Peer ?? {})
    .flatMap((peer) => {
      const host = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
      if (!host || peer.Location !== undefined || (typeof peer.OS === "string" && HANDHELD.has(peer.OS.toLowerCase()))) return [];
      return [{ name: host.split(".")[0] ?? host, host, online: peer.Online === true }];
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const tailnet = status.CurrentTailnet?.Name;
  return {
    state,
    tailnet: state !== "signed-out" && typeof tailnet === "string" && tailnet ? tailnet : null,
    machines: state === "on" ? machines : [],
  };
}

/**
 * `tailscale up` with no flags brings the network online without changing any settings. Any flag, even `--timeout`, makes it a
 * settings change that fails when the Mac has non-default settings, so the process timeout stands in for one. Returns why it failed, or null.
 */
export async function turnOnTailscale(commands: readonly string[] = COMMANDS): Promise<string | null> {
  let reason = "Tailscale is not installed on this Mac.";
  for (const command of commands) {
    try {
      await run(command, ["up"], 25_000);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      reason = ((error as { stderr?: string }).stderr ?? "").trim().replace(/\s+/g, " ") || "Tailscale did not start.";
    }
  }
  return reason;
}

/** Opens the Tailscale app wherever it is installed, where the user can sign in or start it. */
export async function openTailscale(): Promise<void> {
  await execFileAsync("open", ["-b", "io.tailscale.ipn.macos"]).catch(() => undefined);
}
