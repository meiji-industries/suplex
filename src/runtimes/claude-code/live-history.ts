import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

import type { NativeHistoryMessage } from "../../tasks/history/contracts.js";
import { claudeHistoryMessages, ClaudeMessageEntrySchema, type ClaudeMessageEntry } from "./transcript.js";

const TURN_OUTPUT = /^turn-.+\.jsonl$/;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSON_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PARTIAL_TOOL_INPUT_CHARACTERS = 64 * 1024;

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const ToolUseBlockSchema = z.object({ type: z.enum(["tool_use", "server_tool_use"]), id: z.string().min(1), name: z.string().min(1), input: z.unknown().optional() }).passthrough();
const MessageStartSchema = z.object({ type: z.literal("message_start"), message: z.object({ id: z.string().min(1).optional() }).passthrough() }).passthrough();
const ContentBlockStartSchema = z.object({ type: z.literal("content_block_start"), index: z.number().int().nonnegative(), content_block: z.unknown() }).passthrough();
const ContentBlockDeltaSchema = z.object({ type: z.literal("content_block_delta"), index: z.number().int().nonnegative(), delta: z.unknown() }).passthrough();
const ContentBlockStopSchema = z.object({ type: z.literal("content_block_stop"), index: z.number().int().nonnegative() }).passthrough();
const StreamEventSchema = z.object({ type: z.literal("stream_event"), event: z.unknown() }).passthrough();
const TextDeltaSchema = z.object({ type: z.literal("text_delta"), text: z.string() }).passthrough();
const InputJsonDeltaSchema = z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }).passthrough();
const ToolInputSchema = z.record(z.string(), z.unknown());

type SourceItem = { kind: "entry"; id: string } | { kind: "draft"; key: string };
type DraftBlock =
  | { kind: "text"; messageId: string; index: number; text: string }
  | { kind: "tool"; messageId: string; index: number; id: string; name: string; input: Record<string, unknown>; partialInput: string; stopped: boolean };

interface FileDetails {
  path: string;
  createdAt: number;
  size: number;
  mtimeMs: number;
  transcript: boolean;
}

function draftKey(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

function messageBlockCount(entry: ClaudeMessageEntry): number {
  return Array.isArray(entry.message.content) ? entry.message.content.length : 0;
}

function toolInput(value: unknown): Record<string, unknown> {
  const parsed = ToolInputSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

class ClaudeHistoryFile {
  private decoder = new TextDecoder();
  private offset = 0;
  private pendingLine = "";
  private pendingLineBytes = 0;
  private droppingOversizedLine = false;
  private observedSize = 0;
  private observedMtimeMs = 0;
  private currentMessageId: string | null = null;
  private readonly entriesById = new Map<string, ClaudeMessageEntry>();
  private readonly entriesInOrder: ClaudeMessageEntry[] = [];
  private readonly items: SourceItem[] = [];
  private readonly drafts = new Map<string, DraftBlock>();
  private readonly representedDrafts = new Set<string>();
  private readonly completedBlockOffsets = new Map<string, number>();

  constructor(readonly path: string, readonly transcript: boolean, readonly createdAt: number) {}

  entries(): readonly ClaudeMessageEntry[] {
    return this.entriesInOrder;
  }

  orderedItems(): readonly SourceItem[] {
    return this.items;
  }

  draftPosition(key: string): string | null {
    const block = this.drafts.get(key);
    return block ? draftKey(block.messageId, block.index) : null;
  }

  draft(key: string, globallyRepresented: ReadonlySet<string>): NativeHistoryMessage | null {
    const block = this.drafts.get(key);
    if (!block) return null;
    if (this.representedDrafts.has(key) || globallyRepresented.has(draftKey(block.messageId, block.index))) return null;
    const id = `claude-live:${basename(this.path)}:${block.messageId}:${block.index}`;
    if (block.kind === "text") {
      if (!block.text) return null;
      return { id, role: "assistant", createdAt: Math.floor(this.createdAt), content: [{ id: `${id}:text`, type: "text", text: block.text }] };
    }
    return {
      id,
      role: "assistant",
      createdAt: Math.floor(this.createdAt),
      content: [{
        id: block.id,
        type: "tool",
        name: block.name,
        status: block.stopped ? "running" : "pending",
        input: block.input,
        output: null,
        error: null,
      }],
    };
  }

  reset(): void {
    this.decoder = new TextDecoder();
    this.offset = 0;
    this.pendingLine = "";
    this.pendingLineBytes = 0;
    this.droppingOversizedLine = false;
    this.currentMessageId = null;
    this.entriesById.clear();
    this.entriesInOrder.length = 0;
    this.items.length = 0;
    this.drafts.clear();
    this.representedDrafts.clear();
    this.completedBlockOffsets.clear();
  }

  async update(details: FileDetails): Promise<boolean> {
    let changed = false;
    if (details.size < this.offset || (details.size === this.observedSize && details.mtimeMs !== this.observedMtimeMs && this.offset > 0)) {
      this.reset();
      changed = true;
    }
    while (this.offset < details.size) {
      const length = Math.min(READ_CHUNK_BYTES, details.size - this.offset);
      const buffer = Buffer.alloc(length);
      const handle = await open(this.path, "r");
      try {
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        if (this.consume(this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }))) changed = true;
      } finally {
        await handle.close();
      }
    }
    if (this.pendingLine.trim() && this.pendingLineBytes <= MAX_JSON_RECORD_BYTES) {
      let value: unknown;
      try { value = JSON.parse(this.pendingLine); } catch { value = undefined; }
      if (value !== undefined) {
        this.pendingLine = "";
        this.pendingLineBytes = 0;
        if (this.accept(value)) changed = true;
      }
    }
    this.observedSize = details.size;
    this.observedMtimeMs = details.mtimeMs;
    return changed;
  }

  private consume(text: string): boolean {
    let changed = false;
    let remaining = text;
    while (true) {
      const newline = remaining.indexOf("\n");
      if (newline < 0) break;
      const segment = remaining.slice(0, newline);
      remaining = remaining.slice(newline + 1);
      if (this.droppingOversizedLine) {
        this.droppingOversizedLine = false;
        this.pendingLine = "";
        this.pendingLineBytes = 0;
        continue;
      }
      const line = this.pendingLine + segment;
      const lineBytes = this.pendingLineBytes + Buffer.byteLength(segment);
      this.pendingLine = "";
      this.pendingLineBytes = 0;
      if (!line.trim() || lineBytes > MAX_JSON_RECORD_BYTES) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (this.accept(value)) changed = true;
    }
    if (!this.droppingOversizedLine) {
      this.pendingLine += remaining;
      this.pendingLineBytes += Buffer.byteLength(remaining);
      if (this.pendingLineBytes > MAX_JSON_RECORD_BYTES) {
        this.pendingLine = "";
        this.pendingLineBytes = 0;
        this.droppingOversizedLine = true;
      }
    }
    return changed;
  }

  private accept(value: unknown): boolean {
    const entry = ClaudeMessageEntrySchema.safeParse(value);
    if (entry.success && !entry.data.isSidechain) {
      if (this.entriesById.has(entry.data.uuid)) return false;
      this.entriesById.set(entry.data.uuid, entry.data);
      this.entriesInOrder.push(entry.data);
      this.items.push({ kind: "entry", id: entry.data.uuid });
      const messageId = entry.data.message.id;
      const blockCount = messageBlockCount(entry.data);
      if (messageId && blockCount) {
        const offset = this.completedBlockOffsets.get(messageId) ?? 0;
        for (let index = 0; index < blockCount; index += 1) this.representedDrafts.add(draftKey(messageId, offset + index));
        this.completedBlockOffsets.set(messageId, offset + blockCount);
      }
      return true;
    }
    if (this.transcript) return false;
    const stream = StreamEventSchema.safeParse(value);
    if (!stream.success) return false;
    const start = MessageStartSchema.safeParse(stream.data.event);
    if (start.success) {
      this.currentMessageId = start.data.message.id ?? null;
      return false;
    }
    const blockStart = ContentBlockStartSchema.safeParse(stream.data.event);
    if (blockStart.success && this.currentMessageId) {
      const key = draftKey(this.currentMessageId, blockStart.data.index);
      const text = TextBlockSchema.safeParse(blockStart.data.content_block);
      if (text.success) this.drafts.set(key, { kind: "text", messageId: this.currentMessageId, index: blockStart.data.index, text: text.data.text });
      else {
        const tool = ToolUseBlockSchema.safeParse(blockStart.data.content_block);
        if (!tool.success) return false;
        this.drafts.set(key, { kind: "tool", messageId: this.currentMessageId, index: blockStart.data.index, id: tool.data.id, name: tool.data.name, input: toolInput(tool.data.input), partialInput: "", stopped: false });
      }
      this.items.push({ kind: "draft", key });
      return true;
    }
    const delta = ContentBlockDeltaSchema.safeParse(stream.data.event);
    if (delta.success && this.currentMessageId) {
      const block = this.drafts.get(draftKey(this.currentMessageId, delta.data.index));
      const text = TextDeltaSchema.safeParse(delta.data.delta);
      if (text.success && block?.kind === "text") {
        block.text += text.data.text;
        return Boolean(text.data.text);
      }
      const input = InputJsonDeltaSchema.safeParse(delta.data.delta);
      if (input.success && block?.kind === "tool" && block.partialInput.length < MAX_PARTIAL_TOOL_INPUT_CHARACTERS) {
        const available = MAX_PARTIAL_TOOL_INPUT_CHARACTERS - block.partialInput.length;
        block.partialInput += input.data.partial_json.slice(0, available);
        try { block.input = toolInput(JSON.parse(block.partialInput)); } catch { /* keep the last complete input */ }
        return true;
      }
      return false;
    }
    const stop = ContentBlockStopSchema.safeParse(stream.data.event);
    if (!stop.success || !this.currentMessageId) return false;
    const block = this.drafts.get(draftKey(this.currentMessageId, stop.data.index));
    if (block?.kind !== "tool") return false;
    block.stopped = true;
    try { block.input = toolInput(JSON.parse(block.partialInput)); } catch { /* malformed partial input remains hidden */ }
    return true;
  }
}

async function runtimeFiles(runtimeDirectory: string): Promise<FileDetails[]> {
  const entries = await readdir(runtimeDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = await Promise.all(entries.flatMap(async entry => {
    if (!entry.isFile() || !TURN_OUTPUT.test(entry.name)) return [];
    const path = join(runtimeDirectory, entry.name);
    const details = await stat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!details) return [];
    return [{ path, createdAt: details.birthtimeMs || details.mtimeMs, size: details.size, mtimeMs: details.mtimeMs, transcript: false } satisfies FileDetails];
  }));
  return files.flat().sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
}

export class ClaudeLiveHistory {
  private readonly files = new Map<string, ClaudeHistoryFile>();
  private cached: NativeHistoryMessage[] = [];
  private initialized = false;

  constructor(private readonly runtimeDirectory: string) {}

  async read(transcriptPath: string | null): Promise<NativeHistoryMessage[]> {
    const details: FileDetails[] = [];
    if (transcriptPath) {
      const transcript = await stat(transcriptPath);
      details.push({ path: transcriptPath, createdAt: transcript.birthtimeMs || transcript.mtimeMs, size: transcript.size, mtimeMs: transcript.mtimeMs, transcript: true });
    }
    details.push(...await runtimeFiles(this.runtimeDirectory));
    const paths = new Set(details.map(file => file.path));
    let changed = !this.initialized;
    for (const path of this.files.keys()) {
      if (paths.has(path)) continue;
      this.files.delete(path);
      changed = true;
    }
    for (const file of details) {
      let source = this.files.get(file.path);
      if (!source || source.transcript !== file.transcript) {
        source = new ClaudeHistoryFile(file.path, file.transcript, file.createdAt);
        this.files.set(file.path, source);
        changed = true;
      }
      if (await source.update(file)) changed = true;
    }
    this.initialized = true;
    if (!changed) return this.cached;

    const sources = details.flatMap(file => {
      const source = this.files.get(file.path);
      return source ? [source] : [];
    });
    const entries: ClaudeMessageEntry[] = [];
    const seenEntries = new Set<string>();
    for (const source of sources) for (const entry of source.entries()) {
      if (seenEntries.has(entry.uuid)) continue;
      seenEntries.add(entry.uuid);
      entries.push(entry);
    }
    const completed = new Map(claudeHistoryMessages(entries).map(message => [message.id, message]));
    const globallyRepresented = new Set<string>();
    const completedOwners = new Map<string, string>();
    const completedOffsets = new Map<string, number>();
    for (const entry of entries) {
      const messageId = entry.message.id;
      const blockCount = messageBlockCount(entry);
      if (!messageId || !blockCount) continue;
      const offset = completedOffsets.get(messageId) ?? 0;
      for (let index = 0; index < blockCount; index += 1) {
        const key = draftKey(messageId, offset + index);
        globallyRepresented.add(key);
        completedOwners.set(key, entry.uuid);
      }
      completedOffsets.set(messageId, offset + blockCount);
    }
    const emitted = new Set<string>();
    const messages: NativeHistoryMessage[] = [];
    for (const source of sources) {
      for (const item of source.orderedItems()) {
        const position = item.kind === "draft" ? source.draftPosition(item.key) : null;
        const owner = position ? completedOwners.get(position) : undefined;
        const message = item.kind === "entry" ? completed.get(item.id) : owner ? completed.get(owner) : source.draft(item.key, globallyRepresented);
        if (!message || emitted.has(message.id)) continue;
        emitted.add(message.id);
        messages.push(message);
      }
    }
    this.cached = messages;
    return messages;
  }
}
