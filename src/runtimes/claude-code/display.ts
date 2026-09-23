import { open, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";

import { TASK_BRIDGE_ENVIRONMENT_KEYS } from "../../coordination/bridge-auth.js";
import { isEntrypoint } from "../../shared/entrypoint.js";

const TURN_OUTPUT = /^(turn-.+)\.(jsonl|stderr\.log)$/;
const WAITING_LABEL = "No Claude output yet.\n";
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSON_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PARTIAL_TOOL_INPUT_CHARACTERS = 64 * 1024;
const MAX_INPUT_PREVIEW_CHARACTERS = 800;
const MAX_RESULT_PREVIEW_CHARACTERS = 4_000;

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const ToolUseBlockSchema = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown().optional() }).passthrough();
const ServerToolUseBlockSchema = z.object({ type: z.literal("server_tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown().optional() }).passthrough();
const ToolResultBlockSchema = z.object({ type: z.literal("tool_result"), tool_use_id: z.string().min(1), content: z.unknown().optional(), is_error: z.boolean().optional() }).passthrough();
const WebSearchToolResultBlockSchema = z.object({ type: z.literal("web_search_tool_result"), tool_use_id: z.string().min(1), content: z.unknown().optional() }).passthrough();
const WebFetchToolResultBlockSchema = z.object({ type: z.literal("web_fetch_tool_result"), tool_use_id: z.string().min(1), content: z.unknown().optional() }).passthrough();
const RenderedToolUseBlockSchema = z.union([ToolUseBlockSchema, ServerToolUseBlockSchema]);
const RenderedToolResultBlockSchema = z.union([ToolResultBlockSchema, WebSearchToolResultBlockSchema, WebFetchToolResultBlockSchema]);
const CompletedMessageSchema = z.object({
  type: z.enum(["assistant", "user"]),
  uuid: z.string().min(1),
  message: z.object({ id: z.string().min(1).optional(), role: z.enum(["assistant", "user"]), content: z.union([z.string(), z.array(z.unknown())]) }).passthrough(),
}).passthrough();
const ResultSchema = z.object({ type: z.literal("result"), subtype: z.string().min(1), is_error: z.boolean(), result: z.string().optional() }).passthrough();

const MessageStartSchema = z.object({ type: z.literal("message_start"), message: z.object({ id: z.string().min(1).optional() }).passthrough() }).passthrough();
const ContentBlockStartSchema = z.object({ type: z.literal("content_block_start"), index: z.number().int().nonnegative(), content_block: z.unknown() }).passthrough();
const ContentBlockDeltaSchema = z.object({ type: z.literal("content_block_delta"), index: z.number().int().nonnegative(), delta: z.unknown() }).passthrough();
const ContentBlockStopSchema = z.object({ type: z.literal("content_block_stop"), index: z.number().int().nonnegative() }).passthrough();
const StreamEventSchema = z.object({ type: z.literal("stream_event"), event: z.unknown() }).passthrough();
const TextDeltaSchema = z.object({ type: z.literal("text_delta"), text: z.string() }).passthrough();
const InputJsonDeltaSchema = z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }).passthrough();

interface DisplayFile {
  path: string;
  name: string;
  turn: string;
  kind: "jsonl" | "stderr";
  createdAt: number;
  size: number;
}

interface FileCursor {
  decoder: TextDecoder;
  offset: number;
  pendingLine: string;
  pendingLineBytes: number;
  droppingOversizedLine: boolean;
  wroteStderrLabel: boolean;
}

type StreamBlock =
  | { kind: "text"; messageId: string | null; endsWithNewline: boolean }
  | { kind: "tool"; id: string; name: string; partialInput: string };

interface TurnRenderState {
  currentMessageId: string | null;
  blocks: Map<number, StreamBlock>;
  streamedTextBlocks: Set<string>;
  completedEntries: Set<string>;
  completedBlockOffsets: Map<string, number>;
  startedTools: Map<string, string>;
  displayedToolInputs: Map<string, string>;
  displayedToolResults: Set<string>;
  wroteAssistantText: boolean;
  displayedResult: boolean;
}

export interface ClaudeDisplayCommand {
  executable: string;
  args: string[];
  command: string;
}

export interface ClaudeDisplayOptions {
  output?: Pick<NodeJS.WriteStream, "write">;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function claudeDisplayCommand(runtimeDirectory: string): ClaudeDisplayCommand {
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

export function claudeDisplayAttached(runtimeDirectory: string, argv: readonly string[]): boolean {
  const expected = claudeDisplayCommand(runtimeDirectory);
  return argv.length === expected.args.length + 1
    && argv[0] === expected.executable
    && expected.args.every((argument, index) => argv[index + 1] === argument);
}

function safeTerminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Output truncated]`;
}

function jsonPreview(value: unknown, limit: number): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncate(safeTerminalText(value), limit);
  return truncate(safeTerminalText(JSON.stringify(value)), limit);
}

function resultPreview(content: unknown): string {
  if (typeof content === "string") return truncate(safeTerminalText(content), MAX_RESULT_PREVIEW_CHARACTERS);
  if (Array.isArray(content)) {
    const text = content.flatMap(value => {
      const parsed = TextBlockSchema.safeParse(value);
      return parsed.success ? [parsed.data.text] : [];
    }).join("\n");
    if (text) return truncate(safeTerminalText(text), MAX_RESULT_PREVIEW_CHARACTERS);
  }
  return jsonPreview(content, MAX_RESULT_PREVIEW_CHARACTERS);
}

function writeLine(output: Pick<NodeJS.WriteStream, "write">, text: string): void {
  const safe = safeTerminalText(text);
  if (!safe) return;
  output.write(safe.endsWith("\n") ? safe : `${safe}\n`);
}

function newTurnState(): TurnRenderState {
  return {
    currentMessageId: null,
    blocks: new Map(),
    streamedTextBlocks: new Set(),
    completedEntries: new Set(),
    completedBlockOffsets: new Map(),
    startedTools: new Map(),
    displayedToolInputs: new Map(),
    displayedToolResults: new Set(),
    wroteAssistantText: false,
    displayedResult: false,
  };
}

function textBlockKey(messageId: string | null, index: number): string {
  return `${messageId ?? "unknown"}:${index}`;
}

function showToolStart(state: TurnRenderState, output: Pick<NodeJS.WriteStream, "write">, tool: { id: string; name: string; input?: unknown }): void {
  if (!state.startedTools.has(tool.id)) {
    state.startedTools.set(tool.id, tool.name);
    writeLine(output, `[Tool: ${tool.name}]`);
  }
  const preview = jsonPreview(tool.input, MAX_INPUT_PREVIEW_CHARACTERS);
  if (preview && preview !== "{}" && state.displayedToolInputs.get(tool.id) !== preview) {
    state.displayedToolInputs.set(tool.id, preview);
    writeLine(output, `[Tool input: ${tool.name}] ${preview}`);
  }
}

function renderStreamEvent(state: TurnRenderState, output: Pick<NodeJS.WriteStream, "write">, value: z.infer<typeof StreamEventSchema>): void {
  const messageStart = MessageStartSchema.safeParse(value.event);
  if (messageStart.success) {
    state.currentMessageId = messageStart.data.message.id ?? null;
    state.blocks.clear();
    return;
  }

  const start = ContentBlockStartSchema.safeParse(value.event);
  if (start.success) {
    const text = TextBlockSchema.safeParse(start.data.content_block);
    if (text.success) {
      state.blocks.set(start.data.index, { kind: "text", messageId: state.currentMessageId, endsWithNewline: text.data.text.endsWith("\n") });
      if (text.data.text) {
        state.streamedTextBlocks.add(textBlockKey(state.currentMessageId, start.data.index));
        output.write(safeTerminalText(text.data.text));
        state.wroteAssistantText = true;
      }
      return;
    }
    const tool = RenderedToolUseBlockSchema.safeParse(start.data.content_block);
    if (tool.success) {
      state.blocks.set(start.data.index, { kind: "tool", id: tool.data.id, name: tool.data.name, partialInput: "" });
      showToolStart(state, output, tool.data);
    }
    return;
  }

  const delta = ContentBlockDeltaSchema.safeParse(value.event);
  if (delta.success) {
    const block = state.blocks.get(delta.data.index);
    const text = TextDeltaSchema.safeParse(delta.data.delta);
    if (text.success && block?.kind === "text") {
      output.write(safeTerminalText(text.data.text));
      if (text.data.text) block.endsWithNewline = text.data.text.endsWith("\n");
      state.streamedTextBlocks.add(textBlockKey(block.messageId, delta.data.index));
      state.wroteAssistantText = true;
      return;
    }
    const input = InputJsonDeltaSchema.safeParse(delta.data.delta);
    if (input.success && block?.kind === "tool" && block.partialInput.length < MAX_PARTIAL_TOOL_INPUT_CHARACTERS) {
      const available = MAX_PARTIAL_TOOL_INPUT_CHARACTERS - block.partialInput.length;
      block.partialInput += input.data.partial_json.slice(0, available);
    }
    return;
  }

  const stop = ContentBlockStopSchema.safeParse(value.event);
  if (!stop.success) return;
  const block = state.blocks.get(stop.data.index);
  if (block?.kind === "text") {
    if (!block.endsWithNewline) output.write("\n");
    return;
  }
  if (block?.kind !== "tool" || !block.partialInput) return;
  let input: unknown;
  try { input = JSON.parse(block.partialInput); } catch { input = block.partialInput; }
  const preview = jsonPreview(input, MAX_INPUT_PREVIEW_CHARACTERS);
  if (preview && state.displayedToolInputs.get(block.id) !== preview) {
    state.displayedToolInputs.set(block.id, preview);
    writeLine(output, `[Tool input: ${block.name}] ${preview}`);
  }
}

function renderCompletedMessage(state: TurnRenderState, output: Pick<NodeJS.WriteStream, "write">, value: z.infer<typeof CompletedMessageSchema>): void {
  if (state.completedEntries.has(value.uuid)) return;
  state.completedEntries.add(value.uuid);
  const messageKey = value.message.id ?? value.uuid;
  const content = value.message.content;
  if (typeof content === "string") {
    if (value.message.role === "assistant" && content) {
      writeLine(output, content);
      state.wroteAssistantText = true;
    }
    return;
  }
  const blockOffset = state.completedBlockOffsets.get(messageKey) ?? 0;
  for (const [index, unknownBlock] of content.entries()) {
    const blockIndex = blockOffset + index;
    const text = TextBlockSchema.safeParse(unknownBlock);
    if (text.success && value.message.role === "assistant") {
      if (!state.streamedTextBlocks.has(textBlockKey(value.message.id ?? null, blockIndex)) && text.data.text) writeLine(output, text.data.text);
      if (text.data.text) state.wroteAssistantText = true;
      continue;
    }
    const tool = RenderedToolUseBlockSchema.safeParse(unknownBlock);
    if (tool.success) {
      showToolStart(state, output, tool.data);
      continue;
    }
    const result = RenderedToolResultBlockSchema.safeParse(unknownBlock);
    if (!result.success || state.displayedToolResults.has(result.data.tool_use_id)) continue;
    state.displayedToolResults.add(result.data.tool_use_id);
    const name = state.startedTools.get(result.data.tool_use_id) ?? "tool";
    const preview = resultPreview(result.data.content);
    const failed = "is_error" in result.data && result.data.is_error === true;
    writeLine(output, `[${failed ? "Error" : "Result"}: ${name}]${preview ? `\n${preview}` : ""}`);
  }
  state.completedBlockOffsets.set(messageKey, blockOffset + content.length);
}

function renderJsonValue(state: TurnRenderState, output: Pick<NodeJS.WriteStream, "write">, raw: unknown): boolean {
  const stream = StreamEventSchema.safeParse(raw);
  if (stream.success) {
    renderStreamEvent(state, output, stream.data);
    return true;
  }
  const message = CompletedMessageSchema.safeParse(raw);
  if (message.success) {
    renderCompletedMessage(state, output, message.data);
    return true;
  }
  const result = ResultSchema.safeParse(raw);
  if (!result.success || state.displayedResult) return false;
  state.displayedResult = true;
  if (!result.data.result || (!result.data.is_error && state.wroteAssistantText)) return true;
  writeLine(output, `${result.data.is_error ? "[Claude error]\n" : ""}${result.data.result}`);
  return true;
}

async function outputFiles(runtimeDirectory: string): Promise<DisplayFile[]> {
  const entries = await readdir(runtimeDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = await Promise.all(entries.flatMap(async entry => {
    const matched = entry.isFile() ? TURN_OUTPUT.exec(entry.name) : null;
    if (!matched?.[1] || !matched[2]) return [];
    const path = join(runtimeDirectory, entry.name);
    const details = await stat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!details) return [];
    const kind = matched[2] === "jsonl" ? "jsonl" as const : "stderr" as const;
    return [{ path, name: entry.name, turn: matched[1], kind, createdAt: details.birthtimeMs || details.mtimeMs, size: details.size }];
  }));
  return files.flat().sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
}

function newCursor(): FileCursor {
  return { decoder: new TextDecoder(), offset: 0, pendingLine: "", pendingLineBytes: 0, droppingOversizedLine: false, wroteStderrLabel: false };
}

async function readAppended(file: DisplayFile, cursor: FileCursor): Promise<string> {
  const details = await stat(file.path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!details) return "";
  if (details.size < cursor.offset) Object.assign(cursor, newCursor());
  const length = Math.min(Math.min(details.size, file.size) - cursor.offset, READ_CHUNK_BYTES);
  if (length === 0) return "";
  const buffer = Buffer.alloc(length);
  let handle;
  try { handle = await open(file.path, "r"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; }
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
    cursor.offset += bytesRead;
    return cursor.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
  } finally {
    await handle.close();
  }
}

function consumeJsonText(cursor: FileCursor, text: string, render: (value: unknown) => void, omit: () => void): void {
  let remaining = text;
  while (true) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) break;
    const segment = remaining.slice(0, newline);
    remaining = remaining.slice(newline + 1);
    if (cursor.droppingOversizedLine) {
      cursor.droppingOversizedLine = false;
      cursor.pendingLine = "";
      cursor.pendingLineBytes = 0;
      continue;
    }
    const line = cursor.pendingLine + segment;
    const lineBytes = cursor.pendingLineBytes + Buffer.byteLength(segment);
    cursor.pendingLine = "";
    cursor.pendingLineBytes = 0;
    if (!line.trim()) continue;
    if (lineBytes > MAX_JSON_RECORD_BYTES) {
      omit();
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    render(value);
  }
  if (cursor.droppingOversizedLine) return;
  cursor.pendingLine += remaining;
  cursor.pendingLineBytes += Buffer.byteLength(remaining);
  if (cursor.pendingLineBytes > MAX_JSON_RECORD_BYTES) {
    cursor.pendingLine = "";
    cursor.pendingLineBytes = 0;
    cursor.droppingOversizedLine = true;
    omit();
  }
}

async function scan(runtimeDirectory: string, cursors: Map<string, FileCursor>, turns: Map<string, TurnRenderState>, output: Pick<NodeJS.WriteStream, "write">): Promise<boolean> {
  let wrote = false;
  for (const file of await outputFiles(runtimeDirectory)) {
    const cursor = cursors.get(file.path) ?? newCursor();
    cursors.set(file.path, cursor);
    while (cursor.offset < file.size) {
      const previousOffset = cursor.offset;
      const text = await readAppended(file, cursor);
      if (cursor.offset === previousOffset) break;
      if (!text) continue;
      if (file.kind === "stderr") {
        const safe = safeTerminalText(text);
        if (!safe) continue;
        if (!cursor.wroteStderrLabel) {
          output.write("[Claude stderr]\n");
          cursor.wroteStderrLabel = true;
        }
        output.write(safe);
        wrote = true;
        continue;
      }
      const state = turns.get(file.turn) ?? newTurnState();
      turns.set(file.turn, state);
      consumeJsonText(
        cursor,
        text,
        value => { if (renderJsonValue(state, output, value)) wrote = true; },
        () => { writeLine(output, "Suplex omitted a Claude record larger than 8 MiB."); wrote = true; },
      );
    }
  }
  return wrote;
}

export async function runClaudeDisplay(runtimeDirectory: string, options: ClaudeDisplayOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const cursors = new Map<string, FileCursor>();
  const turns = new Map<string, TurnRenderState>();
  if (!await scan(runtimeDirectory, cursors, turns, output)) output.write(WAITING_LABEL);
  const interval = options.pollIntervalMs ?? 250;
  while (!options.signal?.aborted) {
    try {
      await delay(interval, undefined, options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      if (options.signal?.aborted) break;
      throw error;
    }
    await scan(runtimeDirectory, cursors, turns, output);
  }
}

async function main(): Promise<void> {
  const runtimeDirectory = process.argv[2];
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) throw new Error("A private runtime directory is necessary");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runClaudeDisplay(runtimeDirectory, { signal: controller.signal });
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
