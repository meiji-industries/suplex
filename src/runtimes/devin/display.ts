import { open, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { TASK_BRIDGE_ENVIRONMENT_KEYS } from "../../coordination/bridge-auth.js";
import { isEntrypoint } from "../../shared/entrypoint.js";

const TURN_OUTPUT = /^turn-.+\.(?:jsonl|stderr\.log)$/;
const WAITING_LABEL = "Waiting for Devin output...\n";

interface DisplayFile {
  path: string;
  name: string;
  createdAt: number;
}

interface DisplayCursor {
  decoder: TextDecoder;
  offset: number;
}

export interface DevinDisplayCommand {
  executable: string;
  args: string[];
  command: string;
}

export interface DevinDisplayOptions {
  output?: Pick<NodeJS.WriteStream, "write">;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function devinDisplayCommand(runtimeDirectory: string): DevinDisplayCommand {
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

export function devinDisplayAttached(runtimeDirectory: string, argv: readonly string[]): boolean {
  const expected = devinDisplayCommand(runtimeDirectory);
  return argv.length === expected.args.length + 1
    && argv[0] === expected.executable
    && expected.args.every((argument, index) => argv[index + 1] === argument);
}

function safeTerminalText(text: string): string {
  return text.replaceAll("\r", "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
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
      return details ? { path, name: entry.name, createdAt: details.birthtimeMs || details.mtimeMs } : null;
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

async function scan(runtimeDirectory: string, cursors: Map<string, DisplayCursor>, output: Pick<NodeJS.WriteStream, "write">): Promise<boolean> {
  let wrote = false;
  for (const file of await outputFiles(runtimeDirectory)) {
    const cursor = cursors.get(file.path) ?? { decoder: new TextDecoder(), offset: 0 };
    cursors.set(file.path, cursor);
    const text = safeTerminalText(await readAppended(file, cursor));
    if (!text) continue;
    output.write(text);
    wrote = true;
  }
  return wrote;
}

export async function runDevinDisplay(runtimeDirectory: string, options: DevinDisplayOptions = {}): Promise<void> {
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
  await runDevinDisplay(runtimeDirectory, { signal: controller.signal });
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
