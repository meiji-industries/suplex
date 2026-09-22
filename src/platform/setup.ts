import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadConfig } from "./config.js";
import { AuthService } from "../identity/auth.js";
import { SuplexDatabase } from "./database.js";
import { configureTailscaleServe, discoverTailscaleHostname, verifyTailscaleServe } from "./tailscale.js";

const managedKeys = new Set([
  "SUPLEX_ACCESS_MODE",
  "SUPLEX_TAILSCALE_EXPOSURE",
  "SUPLEX_TAILSCALE_ADDRESS",
  "SUPLEX_BIND_ADDRESS",
  "SUPLEX_PORT",
]);

export async function upsertSuplexEnvironment(filename: string, values: Record<string, string>): Promise<void> {
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
  await chmod(filename, 0o600);
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

export async function runLocalSetup(envFile: string): Promise<void> {
  const values = {
    SUPLEX_ACCESS_MODE: "local",
    SUPLEX_BIND_ADDRESS: "127.0.0.1",
    SUPLEX_PORT: process.env.SUPLEX_PORT ?? "4111",
  };
  const config = loadConfig({ ...process.env, ...values, SUPLEX_ENV_FILE: envFile });
  await upsertSuplexEnvironment(envFile, values);
  output.write(`Saved local Suplex configuration to ${envFile}\n`);
  output.write(`Start Suplex with: pnpm run suplex start\nOpen: ${config.reachableAddress}/health\n`);
}

export async function runSetup(options: { local?: boolean } = {}): Promise<void> {
  const envFile = resolve(process.env.SUPLEX_ENV_FILE ?? ".suplex/suplex.env");
  if (options.local) return runLocalSetup(envFile);
  const readline = createInterface({ input, output });
  try {
    let hostname = "";
    try {
      hostname = await discoverTailscaleHostname(process.env.SUPLEX_TAILSCALE_COMMAND ?? "tailscale");
    } catch {
      hostname = await ask("MagicDNS hostname", process.env.SUPLEX_TAILSCALE_ADDRESS ?? "machine.tailnet.ts.net", readline);
    }

    output.write("\nSuplex exposure mode:\n");
    output.write("  1) Tailscale Serve HTTPS (recommended for an HTTPS-enforcing tailnet)\n");
    output.write("  2) Direct Tailscale HTTP (only when the endpoint does not terminate HTTPS)\n");
    const mode = await askChoice("Choose 1 or 2", new Set(["1", "2"]), "1", readline);
    const exposure = mode === "2" ? "direct" : "serve";
    const port = await ask("Suplex port", process.env.SUPLEX_PORT ?? "4111", readline);
    const values = {
      SUPLEX_ACCESS_MODE: "tailscale",
      SUPLEX_TAILSCALE_EXPOSURE: exposure,
      SUPLEX_TAILSCALE_ADDRESS: hostname,
      SUPLEX_PORT: port,
      ...(exposure === "serve" ? { SUPLEX_BIND_ADDRESS: "127.0.0.1" } : { SUPLEX_BIND_ADDRESS: hostname }),
    };
    const config = loadConfig({ ...process.env, ...values, SUPLEX_ENV_FILE: envFile });
    await upsertSuplexEnvironment(envFile, values);
    output.write(`\nSaved idempotent Suplex configuration to ${envFile}\n`);
    const database = new SuplexDatabase(config.databasePath);
    let bootstrapInvitation: ReturnType<AuthService["ensureBootstrapInvitation"]>;
    try {
      bootstrapInvitation = new AuthService(database, config).ensureBootstrapInvitation();
    } finally {
      database.close();
    }
    if (bootstrapInvitation) {
      output.write(`Bootstrap enrollment (showing once): ${config.reachableAddress}/auth?invite=${bootstrapInvitation.token}\n`);
    } else {
      output.write("Bootstrap administrator is already enrolled. Use `pnpm run suplex recover` for explicit recovery.\n");
    }
    if (exposure === "serve") {
      try {
        await configureTailscaleServe(config, process.env.SUPLEX_TAILSCALE_COMMAND ?? "tailscale");
        await verifyTailscaleServe(config, process.env.SUPLEX_TAILSCALE_COMMAND ?? "tailscale");
      } catch (error) {
        if (isTailscaleDaemonUnavailable(error)) {
          output.write("Tailscale Serve was not configured because the local Tailscale daemon is not running.\n");
          output.write("Start and sign in to the Tailscale app, verify `tailscale status`, then rerun: pnpm run suplex setup\n");
          return;
        }
        throw error;
      }
    }
    output.write(`Start Suplex with: pnpm run suplex start\nOpen: ${config.reachableAddress}/health\n`);
  } finally {
    readline.close();
  }
}
