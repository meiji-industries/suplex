import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { estimateUsageCost, modelPricingKey, type ModelPricingCatalog } from "../../profiles/model-pricing.js";
import { TaskPlanItemSchema, type TaskExecution } from "../../tasks/execution/contracts.js";
import { emptyTokens, TaskUsageSchema, type TaskUsage } from "../../tasks/usage.js";
import type { NativeHistoryMessage } from "../../tasks/history/contracts.js";

// Claude Code owns the transcript at <config dir>/projects/<project>/<session>.jsonl
// and the stream-json output of every headless turn. Forge reads both; it
// never edits them.

const ToolUseBlockSchema = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const ToolResultBlockSchema = z.object({ type: z.literal("tool_result"), tool_use_id: z.string().min(1), content: z.unknown().optional(), is_error: z.boolean().optional() }).passthrough();
const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const OtherBlockSchema = z.object({ type: z.string().min(1).refine(type => !["tool_use", "tool_result", "text"].includes(type)) }).passthrough();
export const ClaudeContentBlockSchema = z.union([ToolUseBlockSchema, ToolResultBlockSchema, TextBlockSchema, OtherBlockSchema]);
type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
type TextBlock = z.infer<typeof TextBlockSchema>;
export type ClaudeContentBlock = ToolUseBlock | ToolResultBlock | TextBlock | { type: "other" };

const UsageSchema = z.object({
  input_tokens: z.number().nonnegative().default(0),
  output_tokens: z.number().nonnegative().default(0),
  cache_read_input_tokens: z.number().nonnegative().default(0),
  cache_creation_input_tokens: z.number().nonnegative().default(0),
  output_tokens_details: z.object({ thinking_tokens: z.number().nonnegative().default(0) }).passthrough().optional(),
}).passthrough();

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ClaudeContentBlockSchema)]),
  model: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  usage: UsageSchema.optional(),
  stop_reason: z.string().nullable().optional(),
}).passthrough();

/** One user or assistant line. Transcript lines use `timestamp`; stream lines omit it. */
export const ClaudeMessageEntrySchema = z.object({
  type: z.enum(["user", "assistant"]),
  uuid: z.string().min(1),
  parentUuid: z.string().nullable().optional(),
  timestamp: z.string().optional(),
  message: MessageSchema,
  isApiErrorMessage: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
}).passthrough();
export type ClaudeMessageEntry = z.infer<typeof ClaudeMessageEntrySchema>;

export const ClaudeStreamInitSchema = z.object({ type: z.literal("system"), subtype: z.literal("init"), session_id: z.string().min(1), cwd: z.string().min(1), model: z.string().min(1) }).passthrough();
export const ClaudeStreamResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().min(1),
  is_error: z.boolean(),
  result: z.string().optional(),
  session_id: z.string().min(1),
  uuid: z.string().min(1).optional(),
  total_cost_usd: z.number().nonnegative().optional(),
}).passthrough();
export type ClaudeStreamResult = z.infer<typeof ClaudeStreamResultSchema>;

export function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch { /* a partially written line is not evidence */ }
  }
  return values;
}

export function claudeMessageEntries(values: readonly unknown[]): ClaudeMessageEntry[] {
  return values.flatMap(value => { const parsed = ClaudeMessageEntrySchema.safeParse(value); return parsed.success && !parsed.data.isSidechain ? [parsed.data] : []; });
}

export function claudeConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Claude Code resolves a session id across projects; so does Forge. */
export async function findClaudeTranscript(sessionId: string, configDirectory = claudeConfigDirectory()): Promise<string | null> {
  const projects = join(configDirectory, "projects");
  let directories: string[];
  try { directories = await readdir(projects); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  for (const directory of directories) {
    const candidate = join(projects, directory, `${sessionId}.jsonl`);
    try { await readFile(candidate, { encoding: "utf8", flag: "r" }); return candidate; }
    catch (error) { if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) throw error; }
  }
  return null;
}

export async function readClaudeTranscript(sessionId: string, configDirectory = claudeConfigDirectory()): Promise<ClaudeMessageEntry[]> {
  const path = await findClaudeTranscript(sessionId, configDirectory);
  if (!path) throw new Error("Claude Code session transcript is not available");
  return claudeMessageEntries(parseJsonLines(await readFile(path, "utf8")));
}

function blocks(entry: ClaudeMessageEntry): ClaudeContentBlock[] {
  const content = entry.message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(block => block.type === "tool_use" ? block as ToolUseBlock : block.type === "tool_result" ? block as ToolResultBlock : block.type === "text" ? block as TextBlock : { type: "other" as const });
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content.map(block => { const text = TextBlockSchema.safeParse(block); return text.success ? text.data.text : JSON.stringify(block); }).join("\n");
}

export function claudeHistoryMessages(entries: readonly ClaudeMessageEntry[]): NativeHistoryMessage[] {
  const results = new Map<string, ToolResultBlock>();
  for (const entry of entries) for (const block of blocks(entry)) if (block.type === "tool_result") results.set(block.tool_use_id, block);
  return entries.flatMap(entry => {
    const content: NativeHistoryMessage["content"] = [];
    for (const block of blocks(entry)) {
      if (block.type === "text") {
        const identity = createHash("sha256").update(block.text).digest("hex").slice(0, 16);
        content.push({ id: `${entry.uuid}:text:${identity}`, type: "text", text: block.text });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const result = results.get(block.id);
      const text = result ? resultText(result.content) : null;
      content.push({
        id: block.id,
        type: "tool",
        name: block.name,
        status: result ? result.is_error ? "error" : "completed" : "running",
        input: block.input,
        output: result && !result.is_error ? text : null,
        error: result?.is_error ? text : null,
      });
    }
    if (!content.length) return [];
    const createdAt = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    return [{ id: entry.uuid, role: entry.type, createdAt: Number.isFinite(createdAt) ? createdAt : null, content }];
  });
}

const PlanInputSchema = z.object({ todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) }).passthrough()) });

export function claudeExecution(entries: readonly ClaudeMessageEntry[]): { tools: TaskExecution["sessions"][number]["tools"]; plan: TaskExecution["sessions"][number]["plan"] } {
  const tools: TaskExecution["sessions"][number]["tools"] = [];
  const index = new Map<string, number>();
  let plan: TaskExecution["sessions"][number]["plan"] = null;
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (block.type === "tool_use") {
        index.set(block.id, tools.length);
        tools.push({ id: block.id, name: block.name, status: "running", input: block.input, output: null, error: null });
        continue;
      }
      if (block.type !== "tool_result") continue;
      const position = index.get(block.tool_use_id);
      const tool = position === undefined ? undefined : tools[position];
      if (!tool) continue;
      const text = resultText(block.content);
      tools[position!] = { ...tool, status: block.is_error ? "error" : "completed", output: block.is_error ? null : text, error: block.is_error ? text : null };
      if (tool.name === "TodoWrite" && !block.is_error) {
        const input = PlanInputSchema.safeParse(tool.input);
        if (input.success) plan = input.data.todos.map(todo => TaskPlanItemSchema.parse({ content: todo.content, status: todo.status }));
      }
    }
  }
  return { tools, plan };
}

export function claudeUnsettledToolIds(entries: readonly ClaudeMessageEntry[]): string[] {
  const settled = new Set(entries.flatMap(entry => blocks(entry).flatMap(block => block.type === "tool_result" ? [block.tool_use_id] : [])));
  return entries.flatMap(entry => blocks(entry).flatMap(block => block.type === "tool_use" && !settled.has(block.id) ? [block.id] : []));
}

export function claudeAssistantText(entries: readonly ClaudeMessageEntry[]): string {
  return entries.filter(entry => entry.type === "assistant").flatMap(entry => blocks(entry).flatMap(block => block.type === "text" ? [block.text] : [])).join("\n");
}

function isPrompt(entry: ClaudeMessageEntry): boolean {
  return entry.type === "user" && blocks(entry).every(block => block.type !== "tool_result");
}

/** One usage record per API response. Claude Code reports no native cost per message, so listed prices estimate it. */
export function claudeUsage(entries: readonly ClaudeMessageEntry[], sessionId: string, role: TaskUsage["role"], pricing?: ModelPricingCatalog): TaskUsage[] {
  const usage: TaskUsage[] = [];
  const seen = new Set<string>();
  let turnId = "";
  for (const entry of entries) {
    if (isPrompt(entry)) { turnId = entry.uuid; continue; }
    if (entry.type !== "assistant" || !turnId) continue;
    const responseId = entry.message.id ?? entry.uuid;
    if (seen.has(responseId)) continue;
    seen.add(responseId);
    const native = entry.message.usage;
    const tokens = emptyTokens();
    if (native) {
      tokens.input = native.input_tokens; tokens.output = native.output_tokens; tokens.reasoning = native.output_tokens_details?.thinking_tokens ?? 0;
      tokens.cache.read = native.cache_read_input_tokens; tokens.cache.write = native.cache_creation_input_tokens;
    }
    const model = entry.message.model ?? "unknown";
    const listed = pricing?.get(modelPricingKey("anthropic", model));
    const estimate = listed ? estimateUsageCost(tokens, listed) : 0;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(at) ? at : 0;
    usage.push(TaskUsageSchema.parse({
      sessionId, messageId: entry.uuid, turnId, role, provider: "anthropic", model, startedAt: timestamp, completedAt: timestamp,
      failed: entry.isApiErrorMessage === true, summary: false, steps: 1, cost: estimate, subsidized: estimate > 0, tokens, source: "message",
    }));
  }
  return usage;
}
