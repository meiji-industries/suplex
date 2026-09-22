import { z } from "zod";
import { estimateUsageCost, modelPricingKey, type ModelPricingCatalog } from "../../profiles/model-pricing.js";
import type { TaskExecution } from "../../tasks/execution/contracts.js";
import type { NativeHistoryMessage } from "../../tasks/history/contracts.js";
import { emptyTokens, TaskUsageSchema, type TaskUsage } from "../../tasks/usage.js";
import { parseJsonLines } from "../claude-code/transcript.js";

// `codex exec --json` prints one thread event per line. Forge reads those turn
// logs; it never edits them.

const count = z.number().nonnegative().default(0);

const AgentMessageItemSchema = z.object({ id: z.string().min(1), type: z.literal("agent_message"), text: z.string() }).passthrough();
const ReasoningItemSchema = z.object({ id: z.string().min(1), type: z.literal("reasoning"), text: z.string() }).passthrough();
const CommandExecutionItemSchema = z.object({ id: z.string().min(1), type: z.literal("command_execution"), command: z.string(), aggregated_output: z.string().optional(), exit_code: z.number().optional(), status: z.string().optional() }).passthrough();
const FileChangeItemSchema = z.object({ id: z.string().min(1), type: z.literal("file_change"), changes: z.array(z.object({ path: z.string(), kind: z.string() }).passthrough()).default([]), status: z.string().optional() }).passthrough();
const McpToolCallItemSchema = z.object({ id: z.string().min(1), type: z.literal("mcp_tool_call"), server: z.string(), tool: z.string(), arguments: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional(), status: z.string().optional() }).passthrough();
const WebSearchItemSchema = z.object({ id: z.string().min(1), type: z.literal("web_search"), query: z.string().optional() }).passthrough();
const TodoListItemSchema = z.object({ id: z.string().min(1), type: z.literal("todo_list"), items: z.array(z.unknown()).default([]) }).passthrough();
const ErrorItemSchema = z.object({ id: z.string().min(1), type: z.literal("error"), message: z.string() }).passthrough();
/** An item type this Codex release added is carried as "other", not rejected. */
const OtherItemSchema = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough().transform(item => ({ id: item.id, type: "other" as const }));

export const CodexItemSchema = z.union([AgentMessageItemSchema, ReasoningItemSchema, CommandExecutionItemSchema, FileChangeItemSchema, McpToolCallItemSchema, WebSearchItemSchema, TodoListItemSchema, ErrorItemSchema, OtherItemSchema]);
export type CodexItem = z.infer<typeof CodexItemSchema>;

const CodexUsageSchema = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count,
  output_tokens: count,
  reasoning_output_tokens: count,
}).passthrough();

const ThreadStartedSchema = z.object({ type: z.literal("thread.started"), thread_id: z.string().min(1) }).passthrough();
const TurnStartedSchema = z.object({ type: z.literal("turn.started") }).passthrough();
const TurnCompletedSchema = z.object({ type: z.literal("turn.completed"), usage: CodexUsageSchema.optional() }).passthrough();
const TurnFailedSchema = z.object({ type: z.literal("turn.failed"), error: z.object({ message: z.string() }).passthrough() }).passthrough();
const CodexErrorSchema = z.object({ type: z.literal("error"), message: z.string() }).passthrough();
const ItemEventSchema = z.object({ type: z.enum(["item.started", "item.updated", "item.completed"]), item: CodexItemSchema }).passthrough();

export const CodexEventSchema = z.union([ThreadStartedSchema, TurnStartedSchema, TurnCompletedSchema, TurnFailedSchema, CodexErrorSchema, ItemEventSchema]);
export type CodexEvent = z.infer<typeof CodexEventSchema>;

export function parseCodexEvents(text: string): CodexEvent[] {
  return parseJsonLines(text).flatMap(value => { const parsed = CodexEventSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
}

export function codexThreadId(events: readonly CodexEvent[]): string | null {
  for (const event of events) if (event.type === "thread.started") return event.thread_id;
  return null;
}

export function codexResultText(events: readonly CodexEvent[]): string {
  let text = "";
  for (const event of events) if (event.type === "item.completed" && event.item.type === "agent_message") text = event.item.text;
  return text;
}

export function codexFailure(events: readonly CodexEvent[]): string | null {
  for (const event of events) {
    if (event.type === "turn.failed") return event.error.message;
    if (event.type === "error") return event.message;
  }
  return null;
}

export function codexCompletedTurn(events: readonly CodexEvent[]): boolean {
  return events.some(event => event.type === "turn.completed");
}

type TaskTool = TaskExecution["sessions"][number]["tools"][number];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function toolStatus(status: string | undefined, lifecycle: "started" | "completed"): TaskTool["status"] {
  if (status !== undefined && /fail|error|declined/i.test(status)) return "error";
  return lifecycle === "completed" ? "completed" : "running";
}

function taskTool(item: CodexItem, lifecycle: "started" | "completed"): TaskTool | null {
  if (item.type === "command_execution") {
    const failed = item.exit_code !== undefined && item.exit_code !== 0;
    return { id: item.id, name: "command_execution", status: failed ? "error" : toolStatus(item.status, lifecycle), input: { command: item.command }, output: item.aggregated_output ?? null, error: failed ? `exit ${item.exit_code}` : null };
  }
  if (item.type === "file_change") return { id: item.id, name: "file_change", status: toolStatus(item.status, lifecycle), input: { changes: item.changes }, output: null, error: null };
  if (item.type === "mcp_tool_call") return { id: item.id, name: `mcp__${item.server}__${item.tool}`, status: toolStatus(item.status, lifecycle), input: isRecord(item.arguments) ? item.arguments : {}, output: item.result === undefined ? null : JSON.stringify(item.result), error: item.error === undefined || item.error === null ? null : isRecord(item.error) && typeof item.error.message === "string" ? item.error.message : JSON.stringify(item.error) };
  if (item.type === "web_search") return { id: item.id, name: "web_search", status: toolStatus(undefined, lifecycle), input: item.query === undefined ? {} : { query: item.query }, output: null, error: null };
  return null;
}

export function codexTools(events: readonly CodexEvent[]): TaskExecution["sessions"][number]["tools"] {
  const tools: TaskTool[] = [];
  const index = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "item.started" && event.type !== "item.completed") continue;
    const tool = taskTool(event.item, event.type === "item.completed" ? "completed" : "started");
    if (!tool) continue;
    const position = index.get(tool.id);
    if (position === undefined) { index.set(tool.id, tools.length); tools.push(tool); continue; }
    tools[position] = tool;
  }
  return tools;
}

const TOOL_ITEM_TYPES = ["command_execution", "mcp_tool_call", "file_change"];

export function codexUnsettledToolIds(events: readonly CodexEvent[]): string[] {
  const settled = new Set<string>();
  const started: string[] = [];
  for (const event of events) {
    if (event.type === "item.completed") settled.add(event.item.id);
    else if (event.type === "item.started" && TOOL_ITEM_TYPES.includes(event.item.type)) started.push(event.item.id);
  }
  return started.filter(id => !settled.has(id));
}

export interface CodexTurn {
  id: string;
  /** The model this turn was dispatched with; a session's profile can change between turns. */
  model: string;
  events: readonly CodexEvent[];
  updatedAt: number;
}

type CodexUsage = z.infer<typeof CodexUsageSchema>;
const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;

export function codexUsage(turns: readonly CodexTurn[], sessionId: string, role: TaskUsage["role"], pricing?: ModelPricingCatalog): TaskUsage[] {
  const previousByThread = new Map<string, CodexUsage>();
  const gapModels = new Map<string, Set<string>>();
  const rememberGap = (threadId: string, model: string): void => {
    const models = gapModels.get(threadId) ?? new Set<string>();
    models.add(model);
    gapModels.set(threadId, models);
  };
  const nativeOrder = turns.every(turn => turn.id.startsWith("msg_"));
  const ordered = [...turns].sort((a, b) =>
    nativeOrder
      ? a.id.localeCompare(b.id)
      : a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  return ordered.flatMap(turn => {
    const listed = pricing?.get(modelPricingKey("openai", turn.model));
    const threadId = codexThreadId(turn.events);
    let reported: CodexUsage | undefined;
    for (const event of turn.events) if (event.type === "turn.completed" && event.usage) reported = event.usage;
    if (!reported) {
      if (threadId) rememberGap(threadId, turn.model);
      return [];
    }
    const previous = threadId ? previousByThread.get(threadId) : undefined;
    const regressed = previous && USAGE_FIELDS.some(field => reported[field] < previous[field]);
    const ambiguous = Boolean(regressed || threadId && [...gapModels.get(threadId) ?? []].some(model => model !== turn.model));
    const native = {
      input_tokens: reported.input_tokens - (previous?.input_tokens ?? 0),
      cached_input_tokens: reported.cached_input_tokens - (previous?.cached_input_tokens ?? 0),
      cache_write_input_tokens: reported.cache_write_input_tokens - (previous?.cache_write_input_tokens ?? 0),
      output_tokens: reported.output_tokens - (previous?.output_tokens ?? 0),
      reasoning_output_tokens: reported.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0),
    };
    if (threadId) {
      if (regressed) rememberGap(threadId, turn.model);
      else { previousByThread.set(threadId, reported); gapModels.delete(threadId); }
    }
    const tokens = emptyTokens();
    if (!regressed) {
      // The inclusive native totals are split into non-overlapping token slices.
      tokens.input = Math.max(0, native.input_tokens - native.cached_input_tokens - native.cache_write_input_tokens);
      tokens.output = Math.max(0, native.output_tokens - native.reasoning_output_tokens);
      tokens.reasoning = native.reasoning_output_tokens;
      tokens.cache.read = native.cached_input_tokens;
      tokens.cache.write = native.cache_write_input_tokens;
    }
    const estimate = !ambiguous && listed ? estimateUsageCost(tokens, listed) : 0;
    return [TaskUsageSchema.parse({
      sessionId, messageId: turn.id, turnId: turn.id, role, provider: "openai", model: ambiguous ? "unknown" : turn.model, startedAt: turn.updatedAt, completedAt: turn.updatedAt,
      failed: codexFailure(turn.events) !== null, summary: false, steps: 1, cost: estimate, subsidized: estimate > 0, tokens, source: "message",
    })];
  });
}

export function codexHistory(turns: readonly CodexTurn[]): NativeHistoryMessage[] {
  return turns.flatMap(turn => {
    const text = codexResultText(turn.events);
    return text ? [{ id: turn.id, role: "assistant" as const, createdAt: turn.updatedAt, content: [{ id: `${turn.id}:text`, type: "text" as const, text }] }] : [];
  });
}
