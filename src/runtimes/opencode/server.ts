import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { OpenCodeClient } from "./client.js";
import { openCodeModel } from "./session.js";
import { compareProcessIdentity, defaultProcessController, inspectProcessOnce, stopOwnedProcesses, taskProcessEnvironment, sessionProcessEnvironment, executionProcessEnvironment, type ProcessController } from "../../platform/process-manager.js";
import type { TaskBridgeServer } from "../task-harness.js";

export const OpenCodeServerReferenceSchema = z.object({
  pid: z.number().int().positive(),
  baseUrl: z.string().url(),
  password: z.string().min(32),
  directory: z.string(),
  executable: z.string(),
  generation: z.string().uuid(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  processIdentity: z.object({
    command: z.string().min(1),
    executable: z.string().min(1),
    argv: z.array(z.string()),
    processGroup: z.number().int().positive(),
    startTime: z.string().min(1),
    ownerUid: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type OpenCodeServerReference = z.infer<typeof OpenCodeServerReferenceSchema>;

export interface OpenCodeProfile {
  /** Vendor-qualified, such as `openai/gpt-5.6-sol`. */
  modelID: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier: "default" | "priority";
}

export function openCodeRoleConfig(input: {
  role: "root" | "worker" | "advisor";
  profile: OpenCodeProfile;
  bridge?: TaskBridgeServer;
  /** Explicit task-owned evidence/context directories; other external paths remain denied. */
  evidenceDirectory?: string;
  contextDirectory?: string;
  /** The task worktree; listed so an alias of the working directory (macOS /var vs /private/var) is not treated as external. */
  directory?: string;
}): Record<string, unknown> {
  const { role, profile } = input;
  const native = openCodeModel(profile.modelID);
  const model = `${native.providerID}/${native.modelID}`;
  const allowed = [input.evidenceDirectory, input.contextDirectory, ...(input.evidenceDirectory && input.directory ? [input.directory] : [])].filter((path): path is string => Boolean(path));
  const readOnlyExternal = allowed.length ? { "*": "deny", ...Object.fromEntries(allowed.flatMap(path => [[path, "allow"], [`${path}/**`, "allow"]])) } : "deny";
  const permission = role === "root"
    ? { read: "allow", edit: "deny", bash: "deny", task: "deny", question: "deny", external_directory: readOnlyExternal, doom_loop: "allow" }
    : role === "advisor"
      ? { read: "allow", edit: "deny", bash: "deny", task: "deny", question: "deny", external_directory: readOnlyExternal, doom_loop: "allow", "forge_root_*": "deny" }
      : { read: "allow", edit: "allow", bash: "allow", external_directory: "allow", doom_loop: "allow", task: "deny", question: "deny", "forge_root_*": "deny" };
  return {
    model,
    default_agent: `forge-${role}`,
    agent: {
      [`forge-${role}`]: {
        mode: "primary", model, variant: profile.reasoningEffort, permission,
        tools: role === "root"
          ? { bash: false, edit: false, write: false, apply_patch: false, task: false, question: false }
          : role === "advisor"
            ? { bash: false, edit: false, write: false, apply_patch: false, task: false, question: false, "forge_root_*": false, "forge_advisor_*": true }
            : { task: false, question: false, "forge_root_*": false },
        reasoningEffort: profile.reasoningEffort,
        serviceTier: profile.serviceTier,
      },
    },
    provider: {
      [native.providerID]: { models: {
        [native.modelID]: { options: { reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier } },
      } },
    },
    ...(input.bridge && role !== "worker" ? { mcp: { [role === "root" ? "forge_root" : "forge_advisor"]: { type: "local", command: [input.bridge.command, ...input.bridge.args], environment: input.bridge.environment, enabled: true } } } : {}),
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

function ownedProcess(reference: OpenCodeServerReference) {
  return { ...reference.processIdentity, pid: reference.pid, name: `opencode-${reference.generation}`, startedAt: reference.processIdentity.startTime };
}

export async function openCodeServerRunning(reference: OpenCodeServerReference): Promise<boolean> {
  if (!openCodeProcessAlive(reference.pid)) return false;
  return compareProcessIdentity(ownedProcess(reference), await inspectProcessOnce(reference.pid)).kind === "exact_match";
}

export async function stopOpenCodeServer(reference: OpenCodeServerReference, controller: ProcessController = { ...defaultProcessController, inspect: inspectOpenCodeProcess }): Promise<void> {
  const owned = ownedProcess(reference);
  const inspection = await controller.inspect(reference.pid);
  if (inspection && compareProcessIdentity(owned, inspection).kind !== "exact_match") return;
  await stopOwnedProcesses({ version: 1, processes: [owned] }, controller);
}

export async function inspectOpenCodeProcess(pid: number) {
  const inspection = await inspectProcessOnce(pid);
  if (inspection) return inspection;
  if (openCodeProcessAlive(pid)) throw new Error("OpenCode process identity could not be inspected");
  return undefined;
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
  const configHash = createHash("sha256").update(JSON.stringify(input.config)).digest("hex");
  const previous = await readOpenCodeServer(input.runtimeDirectory);
  if (previous && await openCodeServerRunning(previous)) {
    if (previous.directory !== directory || previous.executable !== input.executable) throw new Error("OpenCode runtime scope changed");
    const client = openCodeServerClient(previous);
    await client.health();
    if (previous.configHash === configHash) return previous;
    const statuses = await client.getStatus(directory);
    if (Object.values(statuses).some(status => status.type !== "idle")) return previous;
    await stopOpenCodeServer(previous);
  }
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(input.runtimeDirectory, 0o700);
  const port = await unusedPort();
  const generation = randomUUID();
  const password = randomBytes(32).toString("hex");
  const log = await open(join(input.runtimeDirectory, "server.log"), "a", 0o600);
  const child = spawn(input.executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: { ...(input.env ?? process.env), ...taskProcessEnvironment(input.directory), ...sessionProcessEnvironment(input.runtimeDirectory), ...executionProcessEnvironment(input.runtimeDirectory, generation), OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config) },
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } finally { await log.close(); }
  if (!child.pid) throw new Error("OpenCode did not start");
  child.unref();
  const inspection = await inspectProcessOnce(child.pid);
  if (!inspection || inspection.ownerUid === undefined || inspection.processGroup !== child.pid) throw new Error("OpenCode process identity could not be established");
  const processIdentity = { command: inspection.command, executable: inspection.executable, argv: inspection.argv, processGroup: inspection.processGroup, startTime: inspection.startTime, ownerUid: inspection.ownerUid };
  const reference: OpenCodeServerReference = { pid: child.pid, baseUrl: `http://127.0.0.1:${port}`, password, directory, executable: input.executable, generation, configHash, processIdentity };
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
  return `source ${quote(envFile)}; ${quote(input.reference.executable)} attach ${quote(input.reference.baseUrl)} --dir ${quote(input.reference.directory)} --session ${quote(input.sessionID)} --mini`;
}
