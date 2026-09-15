import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import type { ForgeDatabase } from "./database.js";
import { StructuredLogger, redact } from "./logging.js";
import { defaultProcessController, inspectProcessOnce, signalOwnedProcess, type OwnedProcess, type ProcessController } from "./process-manager.js";

const OUTPUT_TAIL_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 250;
const POST_TERMINATION_CLOSE_MS = 500;
let logger = new StructuredLogger();

export type CommandStreamEntry = { stream: "stdout" | "stderr"; text: string };
export type CommandRunResult = {
  command: string;
  cwd?: string;
  exitCode: number | null;
  signal: string | null;
  spawnError: { code: string; message: string } | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  entries: CommandStreamEntry[];
  startedAt: string;
  finishedAt: string;
  timedOut: boolean;
};

export class CommandCleanupError extends Error {
  readonly result: CommandRunResult;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut = true;

  constructor(result: CommandRunResult) {
    super(`Command hard-stopped after timeout because cleanup could not be proven: ${result.command}`);
    this.name = "CommandCleanupError";
    this.result = result;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export type RunCommandInput = {
  /** Null is a worker-level observation: emit a structured log but no task activity row. */
  taskId: string | null;
  stepId: string | null;
  /** Non-zero exit is an expected answer (probe); log at debug instead of error. A matcher keeps unexpected probe failures visible. */
  expectNonZero?: boolean | ((result: CommandRunResult) => boolean);
  /** Exit codes that are expected answers (probes); log at debug instead of error. */
  expectedExitCodes?: readonly number[];
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

export function runCommandSync(input: Pick<RunCommandInput, "command" | "args" | "cwd">): string {
  return execFileSync(input.command, [...input.args], { cwd: input.cwd, encoding: "utf8" });
}

/** File-backed stdout also supports CLIs that exit before flushing a large pipe. */
export async function readCommandOutput(command: string, args: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-command-"));
  const output = join(directory, "stdout");
  const file = await open(output, "w", 0o600);
  try {
    const child = spawn(command, [...args], { stdio: ["ignore", file.fd, "ignore"], timeout: 30_000, killSignal: "SIGKILL" });
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error("Command could not read native data");
    return await readFile(output, "utf8");
  } finally {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
}

let database: ForgeDatabase | undefined;

/** Connects worker command observations to the task activity projection. */
export function configureCommandActivityStore(value: ForgeDatabase): void {
  database = value;
}

/** Replaces the command logger for focused tests. */
export function setCommandRunnerLogger(value: StructuredLogger): void {
  logger = value;
}

function tail(value: string, maximumBytes = OUTPUT_TAIL_BYTES): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let offset = bytes.length - maximumBytes;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return bytes.subarray(offset).toString("utf8");
}

type EntryTail = { entries: CommandStreamEntry[]; bytes: number };

function appendEntry(target: EntryTail, entry: CommandStreamEntry): void {
  if (!entry.text) return;
  target.entries.push(entry);
  target.bytes += Buffer.byteLength(entry.text);
  while (target.bytes > OUTPUT_TAIL_BYTES) {
    const first = target.entries[0]!;
    const firstBytes = Buffer.byteLength(first.text);
    const keepBytes = firstBytes - (target.bytes - OUTPUT_TAIL_BYTES);
    if (keepBytes <= 0) {
      target.entries.shift();
      target.bytes -= firstBytes;
      continue;
    }
    const text = tail(first.text, keepBytes);
    if (!text) {
      target.entries.shift();
      target.bytes -= firstBytes;
    } else {
      target.entries[0] = { ...first, text };
      target.bytes += Buffer.byteLength(text) - firstBytes;
    }
  }
}

function display(command: string, args: readonly string[]): string {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

type CommandClose = { code: number | null; signal: string | null };

async function waitForClose(closed: Promise<CommandClose>, timeout: number): Promise<CommandClose | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeout);
    timer.unref();
  });
  try {
    return await Promise.race([closed, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOwnedGroupToStop(owned: OwnedProcess | undefined, timeout: number): Promise<boolean> {
  if (
    process.platform === "win32"
    || !owned
    || owned.processGroup !== owned.pid
    || !defaultProcessController.isProcessGroupAlive
  ) return true;
  const deadline = Date.now() + timeout;
  while (await defaultProcessController.isProcessGroupAlive(owned.processGroup)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, deadline - Date.now()));
  }
  return true;
}

function record(input: RunCommandInput, result: CommandRunResult): void {
  if (!database || !input.taskId || !input.stepId) return;
  database.authQuery((db) => db.prepare(`INSERT INTO forge_task_command_activity
    (id, task_id, step_id, command, cwd, exit_code, duration_ms, stdout, stderr, entries_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(), input.taskId, input.stepId, result.command, result.cwd ?? null, result.exitCode, result.durationMs,
    tail(result.stdout), tail(result.stderr), JSON.stringify(result.entries.map((entry) => ({ ...entry, text: tail(entry.text) }))), result.startedAt, result.finishedAt,
  ));
}

/** Runs one child process and records its redacted, interleaved output under its invoking task step. */
export async function runCommand(input: RunCommandInput): Promise<CommandRunResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const command = display(input.command, input.args);
  const entryTail: EntryTail = { entries: [], bytes: 0 };
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: { code: string; message: string } | null = null;
  const detached = process.platform !== "win32";
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => {
    const code = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
    spawnError = { code, message: error.message };
  });
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    appendEntry(entryTail, { stream, text });
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  const onStdout = (chunk: Buffer): void => append("stdout", chunk);
  const onStderr = (chunk: Buffer): void => append("stderr", chunk);
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  const stopReading = (destroy: boolean): void => {
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
    if (destroy) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
  };

  const closeController = new AbortController();
  const closed = once(child, "close", { signal: closeController.signal }).then(
    ([code, signal]) => ({ code: typeof code === "number" ? code : null, signal: typeof signal === "string" ? signal : null }),
    () => ({ code: null, signal: null }),
  );

  const terminate = async (): Promise<OwnedProcess | undefined> => {
    if (!child.pid) return undefined;
    const fallback: OwnedProcess = {
      name: input.command,
      pid: child.pid,
      command,
      startedAt,
      processGroup: child.pid,
      startTime: startedAt,
      executable: input.command,
      argv: [input.command, ...input.args],
    };
    const inspection = process.platform !== "win32" && child.exitCode === null
      ? await defaultProcessController.inspect(child.pid)
      : undefined;
    const owned: OwnedProcess = inspection
      ? {
          ...fallback,
          command: inspection.command,
          processGroup: inspection.processGroup,
          startTime: inspection.startTime,
          executable: inspection.executable,
          argv: inspection.argv,
          ...(inspection.ownerUid === undefined ? {} : { ownerUid: inspection.ownerUid }),
        }
      : fallback;
    const controller: ProcessController = process.platform === "win32"
      ? {
          async inspect(pid) {
            if (pid !== child.pid || child.exitCode !== null || child.signalCode !== null) return undefined;
            return {
              pid,
              command: owned.command,
              processGroup: owned.processGroup!,
              startTime: owned.startTime!,
              executable: owned.executable!,
              argv: owned.argv!,
            };
          },
          async signal(pid, signal) {
            if (pid === child.pid && child.exitCode === null) child.kill(signal);
          },
        }
      : { ...defaultProcessController, inspect: inspectProcessOnce };
    await signalOwnedProcess(owned, "SIGTERM", controller);
    await delay(TERMINATION_GRACE_MS);
    await signalOwnedProcess(owned, "SIGKILL", controller);
    return owned;
  };

  let close: CommandClose = { code: null, signal: null };
  let cleanupUnproven = false;
  try {
    if (input.timeout) {
      const outcome = await waitForClose(closed, input.timeout);
      if (outcome === "timeout") {
        timedOut = true;
        const owned = await terminate();
        const groupStopped = await waitForOwnedGroupToStop(owned, POST_TERMINATION_CLOSE_MS);
        const terminated = groupStopped ? await waitForClose(closed, POST_TERMINATION_CLOSE_MS) : "timeout";
        if (terminated === "timeout") {
          cleanupUnproven = true;
          close = { code: null, signal: null };
          closeController.abort();
          stopReading(true);
        } else {
          close = terminated;
        }
      } else {
        close = outcome;
      }
    } else {
      close = await closed;
    }
  } catch (error) {
    closeController.abort();
    stopReading(true);
    throw error;
  }
  if (!cleanupUnproven) stopReading(false);

  const redactedEntries: EntryTail = { entries: [], bytes: 0 };
  for (const entry of entryTail.entries) {
    appendEntry(redactedEntries, { stream: entry.stream, text: String(redact(entry.text)) });
  }
  const result: CommandRunResult = {
    command: String(redact(command)),
    ...(input.cwd ? { cwd: String(redact(input.cwd)) } : {}),
    exitCode: timedOut || spawnError ? null : close.code,
    signal: close.signal,
    spawnError,
    durationMs: Date.now() - started,
    stdout: String(redact(stdout)),
    stderr: String(redact(stderr)),
    entries: redactedEntries.entries,
    startedAt,
    finishedAt: new Date().toISOString(),
    timedOut,
  };
  record(input, result);
  const context = { ...(input.taskId ? { taskId: input.taskId } : {}), command: result.command, exitCode: result.exitCode, durationMs: result.durationMs };
  if (cleanupUnproven) {
    const stderrTail = tail(result.stderr).trim().split("\n").slice(-3).join("\n");
    logger.error(`Command hard-stopped after timeout because cleanup could not be proven: ${result.command}`, input.taskId ? { taskId: input.taskId } : {}, {
      ...context,
      ...(stderrTail ? { error: stderrTail } : {}),
    });
    throw new CommandCleanupError(result);
  }
  if (result.exitCode === 0 && !result.timedOut) logger.info(`Command completed: ${result.command}`, context);
  else {
    const stderrTail = tail(result.stderr).trim().split("\n").slice(-3).join("\n");
    const terminal = result.exitCode ?? result.spawnError?.code ?? result.signal ?? "unknown";
    const message = `Command failed: ${result.command} (exit ${terminal}${result.timedOut ? ", timed out" : ""})`;
    const details = { ...context, ...(stderrTail ? { error: stderrTail } : {}) };
    const expectedNonZero = input.expectedExitCodes?.includes(result.exitCode ?? NaN)
      || (typeof input.expectNonZero === "function" ? input.expectNonZero(result) : input.expectNonZero);
    if (expectedNonZero) logger.debug(message, details);
    else logger.error(message, input.taskId ? { taskId: input.taskId } : {}, details);
  }
  return result;
}
