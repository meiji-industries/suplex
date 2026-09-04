import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { redact } from "./logging.js";
import type { NeutralTimelineEvent, RolloutCandidate, RolloutParserInput, RolloutParseResult } from "./codex-rollout.js";
import { claudeTranscriptCandidates } from "./agent-providers/claude-launch.js";
import { jsonRequired } from "./task-utils.js";

const clip = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, 4000);
const text = (value: unknown) => clip(String(redact(typeof value === "string" ? value : "")));
const stamp = (line: Record<string, unknown>) => typeof line.timestamp === "string" ? line.timestamp : new Date(0).toISOString();
const event = (input: RolloutParserInput, offset: number, timestamp: string, kind: NeutralTimelineEvent["kind"], data: Record<string, unknown>): NeutralTimelineEvent => ({ kind, timestamp, sessionId: input.sessionId, forgeTurnId: input.forgeTurnId, executionId: input.executionId, executionRole: input.executionRole, sourceOffset: offset, data });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const contentText = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block) => { const item = record(block); return item.type === "text" && typeof item.text === "string" ? [item.text] : []; }).join("\n") : "";
const numericUsage = (usage: Record<string, unknown>) => Object.fromEntries([["input_tokens", usage.input_tokens], ["cached_input_tokens", usage.cache_read_input_tokens], ["cache_write_input_tokens", usage.cache_creation_input_tokens], ["output_tokens", usage.output_tokens]].filter(([, value]) => typeof value === "number" && value >= 0));

export const claudeCandidatePaths = claudeTranscriptCandidates;
export async function discoverClaudeTranscript(candidates: readonly string[], expected: { sessionId?: string; cwd: string }): Promise<RolloutCandidate> {
  if (!expected.sessionId) throw new Error("Claude transcript identity requires a session id");
  const matches = candidates.filter((candidate) => basename(candidate) === `${expected.sessionId}.jsonl`);
  if (!matches.length) throw new Error("Claude transcript was not found");
  const path = (await Promise.all(matches.map(async (candidate) => ({ candidate, mtimeMs: (await fs.stat(candidate).catch(() => undefined))?.mtimeMs ?? 0 }))))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]!.candidate;
  return { path, sessionId: expected.sessionId, cwd: expected.cwd };
}

export function parseClaudeChunk(input: RolloutParserInput, chunk: string, remainder = "", state: { activeTurnId?: string } = {}): RolloutParseResult {
  const rows = (remainder + chunk).split("\n");
  const tail = rows.pop() ?? "";
  let offset = input.offset, unknown = 0, taskComplete = false, activeTurnId = state.activeTurnId;
  const events: NeutralTimelineEvent[] = [];
  for (const row of rows) {
    offset += Buffer.byteLength(`${row}\n`);
    const lineOffset = offset;
    let emitted = 0;
    // sourceOffset is line end offset plus its event index: timelineEventId hashes (sessionId, sourceOffset), while turn_finished is alone and retains the snapshot byte offset.
    const emit = (timestamp: string, kind: NeutralTimelineEvent["kind"], data: Record<string, unknown>) =>
      events.push(event(input, lineOffset + emitted++, timestamp, kind, data));
    let line: Record<string, unknown>;
    try { line = jsonRequired(row) as Record<string, unknown>; } catch { emit(new Date().toISOString(), "message", { role: "system", level: "error", text: "Malformed Claude transcript line" }); continue; }
    if (line.isSidechain === true || line.isMeta === true) continue;
    const when = stamp(line), message = record(line.message), content = message.content;
    if (line.type === "user") {
      const blocks = Array.isArray(content) ? content.map(record) : [];
      const results = blocks.filter((block) => block.type === "tool_result");
      if (results.length) for (const block of results) emit(when, "tool_call", { id: block.tool_use_id, output: text(typeof block.content === "string" ? block.content : JSON.stringify(block.content)) });
      else { activeTurnId = typeof line.uuid === "string" ? line.uuid : undefined; emit(when, "turn_started", { turnId: activeTurnId }); emit(when, "message", { role: "human", text: text(contentText(content)) }); }
    } else if (line.type === "assistant") {
      for (const raw of Array.isArray(content) ? content : []) {
        const block = record(raw);
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) emit(when, "thinking_summary", { text: text(block.thinking) });
        else if (block.type === "text" && typeof block.text === "string") emit(when, "message", { role: "agent", text: text(block.text) });
        else if (block.type === "tool_use") { const inputValue = record(block.input); const name = typeof block.name === "string" ? block.name : "tool"; const id = block.id; if (name === "Bash") emit(when, "command", { id, command: text(inputValue.command), ...(typeof inputValue.description === "string" ? { description: text(inputValue.description) } : {}) }); else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) emit(when, "file_change", { path: inputValue.file_path ?? inputValue.notebook_path, kind: name === "Write" ? "add" : "update" }); else emit(when, "tool_call", { id, name, input: text(JSON.stringify(inputValue)) }); }
      }
      const usage = record(message.usage); if (Object.keys(usage).length) emit(when, "usage", numericUsage(usage));
      if (line.isApiErrorMessage === true) emit(when, "message", { role: "system", level: "error", text: text(contentText(content) || "Claude API error") });
    } else if (line.type === "system" && line.subtype === "turn_duration") { emit(when, "turn_finished", { turnId: activeTurnId, durationMs: line.durationMs }); taskComplete = true; activeTurnId = undefined; }
    else unknown += 1;
  }
  return { events, offset, remainder: tail, unknown, taskComplete, ...(activeTurnId ? { turnId: activeTurnId } : {}) };
}

export function sanitizeClaudeLine(line: string): string {
  try { const value = jsonRequired(line) as Record<string, unknown>; return JSON.stringify({ type: value.type, ...(typeof value.subtype === "string" ? { subtype: value.subtype } : {}), ...(value.type === "assistant" && typeof record(value.message).stop_reason === "string" ? { stop_reason: record(value.message).stop_reason } : {}) }); } catch { return JSON.stringify({ type: "invalid" }); }
}
