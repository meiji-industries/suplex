import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import type { ForgeDatabase } from "./database.js";
import { StructuredLogger, redact } from "./logging.js";
import { defaultProcessController, inspectProcessOnce, signalOwnedProcess, type OwnedProcess, type ProcessController } from "./process-manager.js";

const OUTPUT_TAIL_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 250;
let logger = new StructuredLogger();

export type CommandStreamEntry = { stream: "stdout" | "stderr"; text: string };
export type CommandRunResult = {
  command: string;
  cwd?: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  entries: CommandStreamEntry[];
  startedAt: string;
  finishedAt: string;
  timedOut: boolean;
};

export type RunCommandInput = {
  /** Null is a worker-level observation: emit a structured log but no task activity row. */
  taskId: string | null;
  stepId: string | null;
  /** Non-zero exit is an expected answer (probe); log at debug instead of error. A matcher keeps unexpected probe failures visible. */
  expectNonZero?: boolean | ((result: CommandRunResult) => boolean);
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

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
  const detached = process.platform !== "win32";
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    appendEntry(entryTail, { stream, text });
    if (stream === "stdout") stdout = tail(stdout + text);
    else stderr = tail(stderr + text);
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  const terminate = async (): Promise<void> => {
    if (!child.pid) return;
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
  };

  const closed = once(child, "close").then(
    ([code]) => typeof code === "number" ? code : null,
    () => null,
  );
  let exitCode: number | null;
  if (input.timeout) {
    const outcome = await Promise.race([
      closed,
      delay(input.timeout, "timeout" as const, { ref: false }),
    ]);
    if (outcome === "timeout") {
      timedOut = true;
      await terminate();
      exitCode = await closed;
    } else {
      exitCode = outcome;
    }
  } else {
    exitCode = await closed;
  }

  const redactedEntries: EntryTail = { entries: [], bytes: 0 };
  for (const entry of entryTail.entries) {
    appendEntry(redactedEntries, { stream: entry.stream, text: String(redact(entry.text)) });
  }
  const result: CommandRunResult = {
    command: String(redact(command)),
    ...(input.cwd ? { cwd: String(redact(input.cwd)) } : {}),
    exitCode: timedOut ? null : exitCode,
    durationMs: Date.now() - started,
    stdout: tail(String(redact(stdout))),
    stderr: tail(String(redact(stderr))),
    entries: redactedEntries.entries,
    startedAt,
    finishedAt: new Date().toISOString(),
    timedOut,
  };
  record(input, result);
  const context = { ...(input.taskId ? { taskId: input.taskId } : {}), command: result.command, exitCode: result.exitCode, durationMs: result.durationMs };
  if (result.exitCode === 0 && !result.timedOut) logger.info(`Command completed: ${result.command}`, context);
  else {
    const stderrTail = tail(result.stderr).trim().split("\n").slice(-3).join("\n");
    const message = `Command failed: ${result.command} (exit ${result.exitCode ?? "signal"}${result.timedOut ? ", timed out" : ""})`;
    const details = { ...context, ...(stderrTail ? { error: stderrTail } : {}) };
    const expectedNonZero = typeof input.expectNonZero === "function" ? input.expectNonZero(result) : input.expectNonZero;
    if (expectedNonZero) logger.debug(message, details);
    else logger.error(message, input.taskId ? { taskId: input.taskId } : {}, details);
  }
  return result;
}
