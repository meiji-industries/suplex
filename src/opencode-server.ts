import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { OpenCodeClient } from "./opencode-client.js";

export const OpenCodeServerReferenceSchema = z.object({
  pid: z.number().int().positive(),
  baseUrl: z.string().url(),
  password: z.string().min(32),
  directory: z.string(),
  executable: z.string(),
  generation: z.string().uuid(),
}).strict();
export type OpenCodeServerReference = z.infer<typeof OpenCodeServerReferenceSchema>;

export interface OpenCodeProfile {
  providerID: string;
  modelID: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier: "default" | "priority";
}

export function openCodeRoleConfig(input: {
  role: "root" | "worker";
  profile: OpenCodeProfile;
  bridge?: { command: string; args: string[] };
}): Record<string, unknown> {
  const { role, profile } = input;
  const model = `${profile.providerID}/${profile.modelID}`;
  const permission = role === "root"
    ? { edit: "deny", bash: "deny", task: "deny", external_directory: "deny" }
    : { task: "deny" };
  return {
    model,
    default_agent: `forge-${role}`,
    agent: {
      [`forge-${role}`]: {
        mode: "primary", model, variant: profile.reasoningEffort, permission,
        tools: role === "root"
          ? { bash: false, edit: false, write: false, apply_patch: false, task: false }
          : { task: false, "forge_root_*": false },
        reasoningEffort: profile.reasoningEffort,
        serviceTier: profile.serviceTier,
      },
    },
    provider: {
      [profile.providerID]: { models: {
        [profile.modelID]: { options: { reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier } },
      } },
    },
    ...(input.bridge ? { mcp: { forge_root: { type: "local", command: [input.bridge.command, ...input.bridge.args], enabled: true } } } : {}),
  };
}

export function openCodeServerClient(reference: OpenCodeServerReference): OpenCodeClient {
  return new OpenCodeClient({ baseUrl: reference.baseUrl, password: reference.password });
}

export async function readOpenCodeServer(runtimeDirectory: string): Promise<OpenCodeServerReference | null> {
  try {
    return OpenCodeServerReferenceSchema.parse(JSON.parse(await readFile(join(runtimeDirectory, "server.json"), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function openCodeProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("OpenCode listener has no port");
  return address.port;
}

// The caller holds the task's durable launch claim. A live but unreachable
// process is never replaced from this helper.
export async function ensureOpenCodeServer(input: {
  runtimeDirectory: string;
  executable: string;
  directory: string;
  config: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenCodeServerReference> {
  if (!isAbsolute(input.executable)) throw new Error("OpenCode executable must be absolute");
  const directory = await realpath(input.directory);
  const previous = await readOpenCodeServer(input.runtimeDirectory);
  if (previous && openCodeProcessAlive(previous.pid)) {
    if (previous.directory !== directory || previous.executable !== input.executable) throw new Error("OpenCode runtime scope changed");
    await openCodeServerClient(previous).health();
    return previous;
  }
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(input.runtimeDirectory, 0o700);
  const port = await unusedPort();
  const password = randomBytes(32).toString("hex");
  const log = await open(join(input.runtimeDirectory, "server.log"), "a", 0o600);
  const child = spawn(input.executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: { ...process.env, ...input.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config) },
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } finally { await log.close(); }
  if (!child.pid) throw new Error("OpenCode did not start");
  child.unref();
  const reference: OpenCodeServerReference = { pid: child.pid, baseUrl: `http://127.0.0.1:${port}`, password, directory, executable: input.executable, generation: randomUUID() };
  const pending = join(input.runtimeDirectory, `server-${reference.generation}.json`);
  await writeFile(pending, JSON.stringify(reference), { mode: 0o600 });
  await rename(pending, join(input.runtimeDirectory, "server.json"));
  const client = openCodeServerClient(reference);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await client.health(); return reference; }
    catch {
      if (!openCodeProcessAlive(reference.pid)) throw new Error(`OpenCode exited during startup; inspect ${join(input.runtimeDirectory, "server.log")}`);
      if (Date.now() >= deadline) throw new Error(`OpenCode is alive but not ready at ${reference.baseUrl}`);
      await delay(100);
    }
  }
}

export async function openCodeAttachCommand(input: { reference: OpenCodeServerReference; runtimeDirectory: string; sessionID: string }): Promise<string> {
  if (!/^ses[a-zA-Z0-9_]+$/.test(input.sessionID)) throw new Error("Invalid OpenCode session identity");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const envFile = join(input.runtimeDirectory, "attach.env");
  await writeFile(envFile, `export OPENCODE_SERVER_PASSWORD=${quote(input.reference.password)}\n`, { mode: 0o600 });
  await chmod(envFile, 0o600);
  return `source ${quote(envFile)}; exec ${quote(input.reference.executable)} attach ${quote(input.reference.baseUrl)} --dir ${quote(input.reference.directory)} --session ${quote(input.sessionID)}`;
}
