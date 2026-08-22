import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { StructuredLogger, redact } from "./logging.js";

const OUTPUT_TAIL_BYTES = 8 * 1024;
const logger = new StructuredLogger();

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
  taskId: string;
  stepId: string;
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

function tail(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= OUTPUT_TAIL_BYTES ? value : bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8");
}

function display(command: string, args: readonly string[]): string {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function record(input: RunCommandInput, result: CommandRunResult): void {
  if (!database) return;
  database.authQuery((db) => db.prepare(`INSERT INTO forge_task_command_activity
    (id, task_id, step_id, command, cwd, exit_code, duration_ms, stdout, stderr, entries_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(), input.taskId, input.stepId, result.command, result.cwd ?? null, result.exitCode, result.durationMs,
    result.stdout, result.stderr, JSON.stringify(result.entries), result.startedAt, result.finishedAt,
  ));
}

/** Runs one child process and records its redacted, interleaved output under its invoking task step. */
export async function runCommand(input: RunCommandInput): Promise<CommandRunResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const command = display(input.command, input.args);
  const entries: CommandStreamEntry[] = [];
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const child = spawn(input.command, [...input.args], { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    entries.push({ stream, text });
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  let timer: NodeJS.Timeout | undefined;
  if (input.timeout) timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, input.timeout);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  if (timer) clearTimeout(timer);
  const result: CommandRunResult = {
    command: String(redact(command)), ...(input.cwd ? { cwd: String(redact(input.cwd)) } : {}), exitCode,
    durationMs: Date.now() - started, stdout: tail(String(redact(stdout))), stderr: tail(String(redact(stderr))),
    entries: entries.map((entry) => ({ stream: entry.stream, text: tail(String(redact(entry.text))) })), startedAt, finishedAt: new Date().toISOString(), timedOut,
  };
  record(input, result);
  const context = { taskId: input.taskId, command: result.command, exitCode: result.exitCode, durationMs: result.durationMs };
  if (result.exitCode === 0 && !result.timedOut) logger.info(`Command completed: ${result.command}`, context);
  else logger.error("Command failed", { taskId: input.taskId }, context);
  return result;
}
