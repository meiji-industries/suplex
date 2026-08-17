import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { FileSessionStore } from "../session-store.js";
import { buildCodexTurnArgs, type CodexTurnSettings } from "./codex-turn.js";
import { sanitizeCodexLine } from "./codex-turn-supervisor.js";

const execFileAsync = promisify(execFile);

export interface CodexTurnWrapperRequest extends CodexTurnSettings {
  command: string;
  cwd: string;
  outputSchemaPath: string;
  promptPath: string;
  repositoryPath: string;
  imagePaths?: string[];
  resumeSessionRef?: string;
  sessionRef?: string;
  sessionStoreRoot: string;
  spoolPath: string;
  statusPath: string;
}

export interface PreparedCodexTurnWrapper {
  command: string;
  args: string[];
  cwd: string;
  wrapperRequestPath: string;
  spoolPath: string;
  statusPath: string;
}

interface WrapperStatus {
  state: "starting" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  eventOffset: number;
  childPid?: number;
  childProcessGroup?: number;
  childStartIdentity?: string;
  exitCode?: number;
  code?: string;
  error?: string;
}

async function writeAtomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filename);
}

async function childIdentity(pid: number): Promise<{ processGroup: number; startIdentity: string }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid=", "-o", "lstart="], { maxBuffer: 4 * 1024 });
      const fields = result.stdout.trim().split(/\s+/);
      const processGroup = Number(fields.shift());
      const start = fields.join(" ");
      if (Number.isSafeInteger(processGroup) && processGroup > 0 && start) return { processGroup, startIdentity: `${pid}:${start}` };
    } catch {
      // A freshly spawned child can be briefly absent from ps while the kernel
      // publishes its process-group metadata. Retry within the same wrapper
      // lifetime so the parent never has to guess ownership.
    }
    if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Codex child identity could not be verified");
}

function safeError(value: string): string {
  try {
    const parsed = JSON.parse(sanitizeCodexLine(value)) as { text?: unknown; error?: { message?: unknown } };
    return typeof parsed.text === "string" ? parsed.text.slice(0, 2_000) : typeof parsed.error?.message === "string" ? parsed.error.message.slice(0, 2_000) : "Codex wrapper failed";
  } catch {
    return sanitizeCodexLine(value).slice(0, 2_000) || "Codex wrapper failed";
  }
}

export function wrapperLaunch(): { command: string; args: string[] } {
  const source = fileURLToPath(import.meta.url);
  const script = source.replace(/codex-turn-wrapper\.(?:ts|js)$/, `codex-turn-wrapper${source.endsWith(".ts") ? ".ts" : ".js"}`);
  if (!source.endsWith(".ts")) return { command: process.execPath, args: [script] };
  const require = createRequire(import.meta.url);
  return { command: process.execPath, args: ["--import", require.resolve("tsx"), script] };
}

export async function prepareCodexTurnWrapper(request: CodexTurnWrapperRequest, executionRoot: string): Promise<PreparedCodexTurnWrapper> {
  await mkdir(executionRoot, { recursive: true, mode: 0o700 });
  const wrapperRequestPath = join(executionRoot, "request.json");
  await writeAtomic(wrapperRequestPath, request);
  const launch = wrapperLaunch();
  return { command: launch.command, args: [...launch.args, wrapperRequestPath], cwd: request.cwd, wrapperRequestPath, spoolPath: request.spoolPath, statusPath: request.statusPath };
}

async function runWrapper(requestPath: string): Promise<void> {
  // The detached wrapper owns the spool; a restarted worker may close this
  // optional observation pipe while the Codex child is still running.
  process.stdout.on("error", () => undefined);
  const request = JSON.parse(await readFile(requestPath, "utf8")) as CodexTurnWrapperRequest;
  await mkdir(dirname(request.spoolPath), { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  let status: WrapperStatus = { state: "starting", startedAt, updatedAt: startedAt, eventOffset: 0 };
  await writeAtomic(request.statusPath, status);
  const prompt = await readFile(request.promptPath, "utf8");
  const sessionStore = new FileSessionStore(request.sessionStoreRoot);
  const rawSessionId = request.resumeSessionRef ? await sessionStore.read(request.resumeSessionRef) : undefined;
  const args = buildCodexTurnArgs({ ...request, prompt, ...(rawSessionId ? { resumeSessionId: rawSessionId } : {}) });
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled = false;
  let buffer = "";
  let stderr = "";
  let outputChain = Promise.resolve();
  const append = async (line: string): Promise<void> => {
    const base = line.startsWith("{\"type\":\"forge.wrapper_started\"") ? line : sanitizeCodexLine(line);
    let sanitized = base;
    try {
      const parsed = JSON.parse(base) as Record<string, unknown>;
      if (typeof parsed.type === "string" && !parsed.type.startsWith("forge.")) sanitized = JSON.stringify({ ...parsed, observedAt: new Date().toISOString() });
    } catch { /* The sanitized fallback remains safe evidence. */ }
    let sessionRef: string | undefined;
    let event: { thread_id?: unknown; threadId?: unknown } | undefined;
    try { event = JSON.parse(line) as { thread_id?: unknown; threadId?: unknown }; } catch { /* Not every Codex line is JSON. */ }
    const rawThreadId = typeof event?.thread_id === "string" ? event.thread_id : typeof event?.threadId === "string" ? event.threadId : undefined;
    if (rawThreadId) {
      sessionRef = request.sessionRef ?? await sessionStore.reserve();
      await sessionStore.bind(sessionRef, rawThreadId);
    }
    if (sessionRef) await appendFile(request.spoolPath, `${JSON.stringify({ type: "forge.session_bound", sessionRef })}\n`, { encoding: "utf8", mode: 0o600 });
    await appendFile(request.spoolPath, `${sanitized}\n`, { encoding: "utf8", mode: 0o600 });
    status = { ...status, eventOffset: status.eventOffset + Buffer.byteLength(`${sanitized}\n`, "utf8"), updatedAt: new Date().toISOString() };
    await writeAtomic(request.statusPath, status);
    try { process.stdout.write(`${sanitized}\n`); } catch { /* The worker may have restarted; the spool is authoritative. */ }
    if (sessionRef) {
      try { process.stdout.write(`${JSON.stringify({ type: "forge.session_bound", sessionRef })}\n`); } catch { /* The spool is authoritative. */ }
    }
  };
  const queueAppend = (line: string): void => {
    outputChain = outputChain.then(() => append(line));
  };
  const finish = async (status: WrapperStatus): Promise<void> => {
    const next = { ...status, startedAt, updatedAt: new Date().toISOString(), eventOffset: Math.max(status.eventOffset, status.eventOffset ?? 0) };
    await writeAtomic(request.statusPath, next);
  };
  const forwardSignal = (signal: NodeJS.Signals): void => {
    cancelled = true;
    child?.kill(signal);
  };
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  try {
    child = spawn(request.command, args, { cwd: request.cwd, env: process.env, detached: false, stdio: ["pipe", "pipe", "pipe"] });
    if (!child.pid) throw new Error("Codex child could not be started");
    const childProcess = child;
    childProcess.stdin!.end(prompt);
    const exitPromise = new Promise<number>((resolve, reject) => {
      childProcess.once("error", reject);
      childProcess.once("close", (code) => resolve(code ?? -1));
    });
    childProcess.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) queueAppend(line);
    });
    childProcess.stderr!.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-16_384); });
    const identity = await childIdentity(child.pid);
    await append(JSON.stringify({ type: "forge.wrapper_started", childPid: child.pid, childProcessGroup: identity.processGroup, childStartIdentity: identity.startIdentity }));
    await finish({ ...status, state: "running", childPid: child.pid, childProcessGroup: identity.processGroup, childStartIdentity: identity.startIdentity });
    const exitCode = await exitPromise;
    if (buffer.trim()) queueAppend(buffer);
    await outputChain;
    await finish({ ...status, state: cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed", childPid: child.pid, childProcessGroup: identity.processGroup, childStartIdentity: identity.startIdentity, exitCode, ...(cancelled ? { code: "cancelled" } : exitCode === 0 ? {} : { code: "process_exit" }), ...(stderr ? { error: safeError(stderr) } : {}) });
    process.exitCode = exitCode;
  } catch (error) {
    await finish({ ...status, state: cancelled ? "cancelled" : "failed", ...(cancelled ? { code: "cancelled" } : { code: "process_exit" }), ...(child?.pid ? { childPid: child.pid } : {}), error: error instanceof Error ? safeError(error.message) : "Codex wrapper failed" });
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? basename(process.argv[1]) : "";
if (entrypoint === "codex-turn-wrapper.ts" || entrypoint === "codex-turn-wrapper.js") {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("Codex wrapper request path is required");
  await runWrapper(requestPath);
}
