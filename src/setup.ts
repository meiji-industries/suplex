import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadConfig } from "./config.js";
import { configureTailscaleServe, discoverTailscaleHostname, verifyTailscaleServe } from "./tailscale.js";

const managedKeys = new Set([
  "FORGE_ACCESS_MODE",
  "FORGE_TAILSCALE_EXPOSURE",
  "FORGE_TAILSCALE_ADDRESS",
  "FORGE_BIND_ADDRESS",
  "FORGE_PORT",
]);

export async function upsertForgeEnvironment(filename: string, values: Record<string, string>): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(filename, "utf8");
  } catch {
    // A first-run setup has no environment file yet.
  }
  const lines = existing.split(/\r?\n/);
  const written = new Set<string>();
  const updated = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !managedKeys.has(key) || values[key] === undefined) {
      return line;
    }
    written.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key)) {
      updated.push(`${key}=${value}`);
    }
  }
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${updated.filter((line, index, all) => !(index === all.length - 1 && line === "")).join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}

export function isTailscaleDaemonUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tailscaled\.socket|local Tailscale daemon|not running/i.test(message);
}

async function ask(question: string, fallback: string, readline: ReturnType<typeof createInterface>): Promise<string> {
  const answer = (await readline.question(`${question} [${fallback}] `)).trim();
  return answer || fallback;
}

async function askChoice(question: string, choices: ReadonlySet<string>, fallback: string, readline: ReturnType<typeof createInterface>): Promise<string> {
  while (true) {
    const answer = await ask(question, fallback, readline);
    if (choices.has(answer)) {
      return answer;
    }
    output.write(`Choose one of: ${[...choices].join(", ")}\n`);
  }
}

export async function runSetup(): Promise<void> {
  const envFile = resolve(process.env.FORGE_ENV_FILE ?? ".forge/forge.env");
  const readline = createInterface({ input, output });
  try {
    let hostname = "";
    try {
      hostname = await discoverTailscaleHostname(process.env.FORGE_TAILSCALE_COMMAND ?? "tailscale");
    } catch {
      hostname = await ask("MagicDNS hostname", process.env.FORGE_TAILSCALE_ADDRESS ?? "machine.tailnet.ts.net", readline);
    }

    output.write("\nForge exposure mode:\n");
    output.write("  1) Tailscale Serve HTTPS (recommended for an HTTPS-enforcing tailnet)\n");
    output.write("  2) Direct Tailscale HTTP (only when the endpoint does not terminate HTTPS)\n");
    const mode = await askChoice("Choose 1 or 2", new Set(["1", "2"]), "1", readline);
    const exposure = mode === "2" ? "direct" : "serve";
    const port = await ask("Forge port", process.env.FORGE_PORT ?? "4111", readline);
    const values = {
      FORGE_ACCESS_MODE: "tailscale",
      FORGE_TAILSCALE_EXPOSURE: exposure,
      FORGE_TAILSCALE_ADDRESS: hostname,
      FORGE_PORT: port,
      ...(exposure === "serve" ? { FORGE_BIND_ADDRESS: "127.0.0.1" } : { FORGE_BIND_ADDRESS: hostname }),
    };
    const config = loadConfig({ ...process.env, ...values, FORGE_ENV_FILE: envFile });
    await upsertForgeEnvironment(envFile, values);
    output.write(`\nSaved idempotent Forge configuration to ${envFile}\n`);
    if (exposure === "serve") {
      try {
        await configureTailscaleServe(config, process.env.FORGE_TAILSCALE_COMMAND ?? "tailscale");
        await verifyTailscaleServe(config, process.env.FORGE_TAILSCALE_COMMAND ?? "tailscale");
      } catch (error) {
        if (isTailscaleDaemonUnavailable(error)) {
          output.write("Tailscale Serve was not configured because the local Tailscale daemon is not running.\n");
          output.write("Start and sign in to the Tailscale app, verify `tailscale status`, then rerun: pnpm run forge setup\n");
          return;
        }
        throw error;
      }
    }
    output.write(`Start Forge with: pnpm run forge start\nOpen: ${config.reachableAddress}/health\n`);
  } finally {
    readline.close();
  }
}
