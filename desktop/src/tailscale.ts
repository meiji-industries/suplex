import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TailnetMachine = { readonly name: string; readonly host: string; readonly online: boolean };

/** A GUI app does not inherit the shell's PATH, so try the App Store bundle and the Homebrew locations too. */
const COMMANDS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"];

/** Phones and tablets cannot run Suplex, and Mullvad exit nodes (the peers with a Location) are not machines you own. */
const HANDHELD = new Set(["ios", "android"]);

/** Other machines on this Mac's tailnet, online first; null when Tailscale is not installed or not connected. */
export async function tailnetMachines(commands: readonly string[] = COMMANDS): Promise<TailnetMachine[] | null> {
  for (const command of commands) {
    try {
      // The App Store binary can print "The Tailscale GUI failed to start" and exit 0 when an app runs it, so keep trying.
      const { stdout } = await execFileAsync(command, ["status", "--json"], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
      const machines = parseTailnetMachines(stdout);
      if (machines) return machines;
    } catch { /* try the next location */ }
  }
  return null;
}

export function parseTailnetMachines(raw: string): TailnetMachine[] | null {
  let status: { BackendState?: unknown; Peer?: Record<string, { DNSName?: unknown; OS?: unknown; Online?: unknown; Location?: unknown }> };
  try { status = JSON.parse(raw) as typeof status; } catch { return null; }
  if (status.BackendState !== "Running") return null;
  return Object.values(status.Peer ?? {})
    .flatMap((peer) => {
      const host = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
      if (!host || peer.Location !== undefined || (typeof peer.OS === "string" && HANDHELD.has(peer.OS.toLowerCase()))) return [];
      return [{ name: host.split(".")[0] ?? host, host, online: peer.Online === true }];
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
