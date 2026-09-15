import { open, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { TASK_BRIDGE_ENVIRONMENT_KEYS } from "../../coordination/bridge-auth.js";
import { CodexEventSchema, type CodexEvent } from "./transcript.js";

const TURN_OUTPUT = /^turn-.+\.(?:jsonl|stderr\.log)$/;
const WAITING_LABEL = "Waiting for Codex output...\n";

interface DisplayFile {
  path: string;
  name: string;
  events: boolean;
  createdAt: number;
}

interface DisplayCursor {
  decoder: TextDecoder;
  offset: number;
  pendingLine: string;
}

export interface CodexDisplayCommand {
  executable: string;
  args: string[];
  command: string;
}

export interface CodexDisplayOptions {
  output?: Pick<NodeJS.WriteStream, "write">;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function codexDisplayCommand(runtimeDirectory: string): CodexDisplayCommand {
  const currentFile = fileURLToPath(import.meta.url);
  const source = currentFile.endsWith(".ts");
  const executable = process.execPath;
  const args = [
    ...(source ? [join(dirname(currentFile), "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs")] : []),
    currentFile,
    runtimeDirectory,
  ];
  const clear = TASK_BRIDGE_ENVIRONMENT_KEYS.flatMap(key => ["-u", key]);
  const command = ["/usr/bin/env", ...clear, executable, ...args].map(shellQuote).join(" ");
  return { executable, args, command };
}

export function codexDisplayAttached(runtimeDirectory: string, argv: readonly string[]): boolean {
  const expected = codexDisplayCommand(runtimeDirectory);
  return argv.length === expected.args.length + 1
    && argv[0] === expected.executable
    && expected.args.every((argument, index) => argv[index + 1] === argument);
}

function safeTerminalText(text: string): string {
  return text.replaceAll("\r", "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function renderCodexEvent(event: CodexEvent): string {
  if (event.type === "turn.completed") return "\n";
  if (event.type === "turn.failed") return `error: ${event.error.message}\n`;
  if (event.type === "error") return `error: ${event.message}\n`;
  if (event.type === "item.updated" || event.type === "thread.started" || event.type === "turn.started") return "";
  const item = event.item;
  const started = event.type === "item.started";
  if (item.type === "agent_message") return started ? "" : `${item.text}\n`;
  if (item.type === "reasoning") return started ? "" : `${item.text.split("\n").map(line => `  · ${line}`).join("\n")}\n`;
  if (item.type === "command_execution") return started ? `$ ${item.command}\n` : item.exit_code === undefined || item.exit_code === 0 ? "" : `exit ${item.exit_code}\n`;
  if (item.type === "file_change") return started ? "" : item.changes.map(change => `edit ${change.path}\n`).join("");
  if (item.type === "mcp_tool_call") return started ? `tool ${item.server}.${item.tool}\n` : "";
  if (item.type === "error") return started ? "" : `error: ${item.message}\n`;
  return "";
}

async function outputFiles(runtimeDirectory: string): Promise<DisplayFile[]> {
  const entries = await readdir(runtimeDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = await Promise.all(entries
    .filter(entry => entry.isFile() && TURN_OUTPUT.test(entry.name))
    .map(async entry => {
      const path = join(runtimeDirectory, entry.name);
      const details = await stat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      return details ? { path, name: entry.name, events: entry.name.endsWith(".jsonl"), createdAt: details.birthtimeMs || details.mtimeMs } : null;
    }));
  return files
    .filter((file): file is DisplayFile => file !== null)
    .sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
}

async function readAppended(file: DisplayFile, cursor: DisplayCursor): Promise<string> {
  const details = await stat(file.path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!details) return "";
  if (details.size < cursor.offset) {
    cursor.offset = 0;
    cursor.decoder = new TextDecoder();
    cursor.pendingLine = "";
  }
  const length = details.size - cursor.offset;
  if (length === 0) return "";
  const buffer = Buffer.alloc(length);
  const handle = await open(file.path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
    cursor.offset += bytesRead;
    return cursor.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
  } finally {
    await handle.close();
  }
}

/** Renders the complete lines in `text`; a partial trailing line waits for the next append. */
function renderAppended(cursor: DisplayCursor, text: string): string {
  let remaining = cursor.pendingLine + text;
  let rendered = "";
  for (;;) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) break;
    const line = remaining.slice(0, newline);
    remaining = remaining.slice(newline + 1);
    if (!line.trim()) continue;
    const parsed = (() => { try { return CodexEventSchema.safeParse(JSON.parse(line)); } catch { return null; } })();
    rendered += parsed?.success ? renderCodexEvent(parsed.data) : `${line}\n`;
  }
  cursor.pendingLine = remaining;
  return rendered;
}

async function scan(runtimeDirectory: string, cursors: Map<string, DisplayCursor>, output: Pick<NodeJS.WriteStream, "write">): Promise<boolean> {
  let wrote = false;
  for (const file of await outputFiles(runtimeDirectory)) {
    const cursor = cursors.get(file.path) ?? { decoder: new TextDecoder(), offset: 0, pendingLine: "" };
    cursors.set(file.path, cursor);
    const appended = await readAppended(file, cursor);
    if (!appended) continue;
    const text = safeTerminalText(file.events ? renderAppended(cursor, appended) : appended);
    if (!text) continue;
    output.write(text);
    wrote = true;
  }
  return wrote;
}

export async function runCodexDisplay(runtimeDirectory: string, options: CodexDisplayOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const cursors = new Map<string, DisplayCursor>();
  if (!await scan(runtimeDirectory, cursors, output)) output.write(WAITING_LABEL);
  const interval = options.pollIntervalMs ?? 250;
  while (!options.signal?.aborted) {
    try {
      await delay(interval, undefined, options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      if (options.signal?.aborted) break;
      throw error;
    }
    await scan(runtimeDirectory, cursors, output);
  }
}

async function main(): Promise<void> {
  const runtimeDirectory = process.argv[2];
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) throw new Error("A private runtime directory is required");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runCodexDisplay(runtimeDirectory, { signal: controller.signal });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
