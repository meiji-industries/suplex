import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, delimiter, relative, resolve, sep, join } from "node:path";
import { z } from "zod";

import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DurableIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const AgentWrapperManifestSchema = z.object({
  runtimeRoot: z.string().min(1),
  executionId: DurableIdSchema,
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  pathOverride: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type AgentWrapperManifest = z.infer<typeof AgentWrapperManifestSchema>;

export const AgentWrapperStateSchema = z.object({
  wrapperPid: z.number().int().positive(),
  wrapperProcessGroupId: z.number().int().positive(),
  wrapperStartIdentity: z.string().min(1).max(256),
  childPid: z.number().int().positive().nullable(),
  childProcessGroupId: z.number().int().positive().nullable(),
  childStartIdentity: z.string().max(256).nullable(),
  heartbeatAt: z.string().datetime(),
  status: z.enum(["starting", "running", "completed", "failed"]),
});
export type AgentWrapperState = z.infer<typeof AgentWrapperStateSchema>;

export const AgentWrapperResultSchema = z.object({
  exitCode: z.number().int(),
  terminalAt: z.string().datetime(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
});
export type AgentWrapperResult = z.infer<typeof AgentWrapperResultSchema>;

export interface AgentWrapperDirectory {
  directory: string;
  manifestPath: string;
  stdoutPath: string;
  stderrPath: string;
  statePath: string;
  resultPath: string;
}

export interface WrapperProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStart: (pid: number, startedAt: string) => Promise<void>;
  onLine: (line: string) => Promise<void>;
}

export interface WrapperInspection {
  directory: AgentWrapperDirectory;
  manifest: AgentWrapperManifest;
  state?: AgentWrapperState;
  result?: AgentWrapperResult;
  live: boolean;
}

function pathsForManifest(manifest: AgentWrapperManifest): AgentWrapperDirectory {
  const directory = join(resolve(manifest.runtimeRoot), "agent-executions", manifest.executionId);
  return { directory, manifestPath: join(directory, "manifest.json"), stdoutPath: join(directory, "stdout.jsonl"), stderrPath: join(directory, "stderr.log"), statePath: join(directory, "state.json"), resultPath: join(directory, "result.json") };
}

function assertUnder(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep) || resolve(candidate) === resolve(root)) throw new Error("Agent wrapper path is outside the private runtime root");
}

async function privateWrite(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeState(path: string, state: AgentWrapperState): Promise<void> {
  await privateWrite(path, `${JSON.stringify(state)}\n`);
}

async function writeDurableResult(path: string, result: AgentWrapperResult): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  const handle = await open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(result)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

export async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { maxBuffer: 4 * 1024 });
    const value = result.stdout.trim();
    return value ? `${pid}:${value}` : undefined;
  } catch {
    return undefined;
  }
}

async function readProcessGroupId(pid: number): Promise<number | undefined> {
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { maxBuffer: 4 * 1024 });
    const value = Number(result.stdout.trim());
    return Number.isInteger(value) && value > 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function createAgentWrapperManifest(input: Omit<AgentWrapperManifest, "createdAt"> & { createdAt?: string }): Promise<AgentWrapperDirectory> {
  const manifest = AgentWrapperManifestSchema.parse({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  const paths = pathsForManifest(manifest);
  assertUnder(join(resolve(manifest.runtimeRoot), "agent-executions"), paths.directory);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await privateWrite(paths.manifestPath, `${JSON.stringify(manifest)}\n`);
  await privateWrite(paths.stdoutPath, "");
  await privateWrite(paths.stderrPath, "");
  return paths;
}

export async function readAgentWrapperManifest(manifestPath: string): Promise<{ manifest: AgentWrapperManifest; paths: AgentWrapperDirectory }> {
  const absoluteManifestPath = resolve(manifestPath);
  if (basename(absoluteManifestPath) !== "manifest.json" || basename(resolve(absoluteManifestPath, "..", "..")) !== "agent-executions") throw new Error("Agent wrapper manifest path is outside the private runtime root");
  const raw = AgentWrapperManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const paths = pathsForManifest(raw);
  assertUnder(join(resolve(raw.runtimeRoot), "agent-executions"), absoluteManifestPath);
  if (absoluteManifestPath !== resolve(paths.manifestPath)) throw new Error("Agent wrapper manifest path does not match its execution directory");
  return { manifest: raw, paths };
}

export async function inspectAgentWrapper(manifestPath: string): Promise<WrapperInspection> {
  const { manifest, paths } = await readAgentWrapperManifest(manifestPath);
  let state: AgentWrapperState | undefined;
  let result: AgentWrapperResult | undefined;
  try { state = AgentWrapperStateSchema.parse(JSON.parse(await readFile(paths.statePath, "utf8"))); } catch { /* wrapper may not have started */ }
  try { result = AgentWrapperResultSchema.parse(JSON.parse(await readFile(paths.resultPath, "utf8"))); } catch { /* terminal result is written last */ }
  return { directory: paths, manifest, ...(state ? { state } : {}), ...(result ? { result } : {}), live: Boolean(state && ["starting", "running"].includes(state.status) && !result) };
}

async function appendChunk(path: string, chunk: Buffer, limit: number): Promise<number> {
  const current = await stat(path).then((value) => value.size).catch(() => 0);
  if (current >= limit) return current;
  const remaining = Math.max(0, limit - current);
  await appendFile(path, chunk.subarray(0, remaining));
  return current + Math.min(chunk.byteLength, remaining);
}

export async function runAgentWrapper(manifestPath: string): Promise<void> {
  const { manifest, paths } = await readAgentWrapperManifest(manifestPath);
  const startedAt = new Date().toISOString();
  const wrapperPid = process.pid;
  const [wrapperStartIdentity, wrapperProcessGroupId] = await Promise.all([readProcessStartIdentity(wrapperPid), readProcessGroupId(wrapperPid)]);
  if (!wrapperStartIdentity || !wrapperProcessGroupId) throw new Error("Agent wrapper process identity is unavailable");
  const wrapperState: AgentWrapperState = { wrapperPid, wrapperProcessGroupId, wrapperStartIdentity, childPid: null, childProcessGroupId: null, childStartIdentity: null, heartbeatAt: startedAt, status: "starting" };
  await writeState(paths.statePath, wrapperState);
  await unlink(`${manifestPath}.launching`).catch(() => undefined);
  let child: ChildProcess;
  try {
    child = spawn(manifest.command, manifest.args, {
      cwd: manifest.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(manifest.pathOverride ? { PATH: manifest.pathOverride } : {}) },
    });
  } catch {
    const terminalAt = new Date().toISOString();
    await writeState(paths.statePath, { ...wrapperState, heartbeatAt: terminalAt, status: "failed" });
    await writeDurableResult(paths.resultPath, { exitCode: -1, terminalAt, stdoutBytes: 0, stderrBytes: 0 });
    return;
  }
  if (!child.pid) throw new Error("Agent wrapper child did not expose a PID");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let writeChain = Promise.resolve();
  child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; writeChain = writeChain.then(() => appendChunk(paths.stdoutPath, chunk, 16 * 1024 * 1024).then(() => undefined)); });
  child.stderr?.on("data", (chunk: Buffer) => { writeChain = writeChain.then(() => appendChunk(paths.stderrPath, chunk, 64 * 1024).then((size) => { stderrBytes = size; })); });
  const exitCodePromise = new Promise<number>((resolveExit) => {
    child.once("error", () => resolveExit(-1));
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  const childStartedAt = new Date().toISOString();
  const childStartIdentity = await readProcessStartIdentity(child.pid);
  if (!childStartIdentity) {
    if (child.exitCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch { /* the child may already be gone */ }
    const exitCode = await exitCodePromise;
    await writeChain;
    const terminalAt = new Date().toISOString();
    await writeState(paths.statePath, { ...wrapperState, childPid: child.pid, childProcessGroupId: child.pid, heartbeatAt: terminalAt, status: exitCode === 0 ? "completed" : "failed" });
    await writeDurableResult(paths.resultPath, { exitCode, terminalAt, stdoutBytes, stderrBytes });
    return;
  }
  const runningState: AgentWrapperState = { ...wrapperState, childPid: child.pid, childProcessGroupId: child.pid, childStartIdentity, heartbeatAt: childStartedAt, status: "running" };
  await writeState(paths.statePath, runningState);
  const heartbeat = setInterval(() => void writeState(paths.statePath, { ...runningState, heartbeatAt: new Date().toISOString() }), 5_000);
  heartbeat.unref();
  const exitCode = await exitCodePromise;
  clearInterval(heartbeat);
  await writeChain;
  const terminalAt = new Date().toISOString();
  await writeState(paths.statePath, { ...runningState, heartbeatAt: terminalAt, status: exitCode === 0 ? "completed" : "failed" });
  await writeDurableResult(paths.resultPath, { exitCode, terminalAt, stdoutBytes, stderrBytes });
}

export async function launchAgentWrapper(manifestPath: string, launcher: { command: string; args: string[] }): Promise<number> {
  const claimPath = `${manifestPath}.launching`;
  try {
    await writeFile(claimPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST") return 0;
    throw error;
  }
  const child = spawn(launcher.command, [...launcher.args, "agent-wrapper", manifestPath], { detached: true, stdio: "ignore" });
  child.unref();
  if (!child.pid) throw new Error("Agent wrapper could not be launched");
  return child.pid;
}

export function wrapperDirectoryFromRuntime(runtimeRoot: string, executionId: string): AgentWrapperDirectory {
  const manifest = AgentWrapperManifestSchema.parse({ runtimeRoot, executionId, command: "agent", args: [], cwd: "/", createdAt: new Date().toISOString() });
  return pathsForManifest(manifest);
}

/** Remove one terminal wrapper directory after its result is committed to the ledger. */
export async function cleanupAgentWrapper(runtimeRoot: string, executionId: string): Promise<void> {
  const parsedExecutionId = DurableIdSchema.parse(executionId);
  const directory = join(resolve(runtimeRoot), "agent-executions", parsedExecutionId);
  assertUnder(join(resolve(runtimeRoot), "agent-executions"), directory);
  const inspection = await inspectAgentWrapper(join(directory, "manifest.json")).catch(() => undefined);
  if (!inspection) return;
  if (resolve(inspection.manifest.runtimeRoot) !== resolve(runtimeRoot) || inspection.manifest.executionId !== parsedExecutionId || !inspection.result) {
    throw new Error("Refusing to clean a non-terminal or mismatched Agent wrapper");
  }
  const guardDirectory = inspection.manifest.pathOverride?.split(delimiter)[0];
  await rm(directory, { recursive: true, force: true });
  if (guardDirectory && basename(guardDirectory).startsWith("developer-guard-")) {
    assertUnder(resolve(runtimeRoot), guardDirectory);
    await rm(guardDirectory, { recursive: true, force: true });
  }
}
