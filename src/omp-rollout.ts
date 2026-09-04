import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./logging.js";
import type { NeutralTimelineEvent, RolloutCandidate, RolloutParseResult, RolloutParserInput } from "./codex-rollout.js";
import { json } from "./task-utils.js";
const clip = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, 4000);
const text = (value: unknown) => clip(String(redact(typeof value === "string" ? value : "")));
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const contentText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map(record).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n") : "";
const stamp = (line: Record<string, unknown>): string => typeof line.timestamp === "string" ? line.timestamp : new Date(0).toISOString();
const usage = (value: unknown): Record<string, number> => {
  const source = record(value);
  return Object.fromEntries([["input_tokens", source.input], ["output_tokens", source.output], ["cached_input_tokens", source.cacheRead], ["cache_write_input_tokens", source.cacheWrite]].filter(([, count]) => typeof count === "number" && count >= 0)) as Record<string, number>;
};
export async function ompCandidatePaths(env: NodeJS.ProcessEnv): Promise<string[]> { const root = join(env.OMP_HOME ?? join(homedir(), ".omp"), "agent/sessions"); try { return (await Promise.all((await readdir(root)).map(async (name) => (await readdir(join(root, name))).filter((file) => file.endsWith(".jsonl")).map((file) => join(root, name, file))))).flat(); } catch { return []; } }
const ompSessionHeader = (value: string): { id: string; cwd: string } | undefined => {
  for (const row of value.split(/\r?\n/, 8)) {
    const header = json(row, undefined) as { type?: string; id?: string; cwd?: string } | undefined;
    if (header?.type === "session" && header.id && header.cwd) return { id: header.id, cwd: header.cwd };
  }
  return undefined;
};
export async function discoverOmpSession(candidates: readonly string[], expected: { sessionId?: string; cwd: string; before?: ReadonlySet<string>; preferNewestMarker?: boolean }): Promise<RolloutCandidate> { const found: Array<(RolloutCandidate & { mtime: number }) | undefined> = await Promise.all(candidates.map(async (path) => { try { const header = ompSessionHeader(await readFile(path, "utf8")); if (!header || (expected.sessionId ? header.id !== expected.sessionId : header.cwd !== expected.cwd || expected.before?.has(path))) return undefined; return { path, sessionId: header.id, cwd: header.cwd, mtime: (await stat(path)).mtimeMs }; } catch { return undefined; } })); const results = found.filter((entry): entry is RolloutCandidate & { mtime: number } => entry !== undefined); if (!results.length) throw new Error("omp session transcript was not found"); return results.sort((a, b) => b.mtime - a.mtime)[0]!; }
export function sanitizeOmpLine(line: string): string { const value = json(line, undefined) as Record<string, unknown> | undefined; return value ? JSON.stringify({ type: value.type, role: value.role, stopReason: value.stopReason }) : "{}"; }
export function parseOmpChunk(input: RolloutParserInput, chunk: string, remainder = "", state: { activeTurnId?: string } = {}): RolloutParseResult {
  const rows = `${remainder}${chunk}`.split(/\r?\n/);
  const tail = rows.pop() ?? "";
  let offset = input.offset, unknown = 0, taskComplete = false, activeTurnId = state.activeTurnId;
  const events: NeutralTimelineEvent[] = [];
  for (const raw of rows) {
    offset += Buffer.byteLength(`${raw}\n`);
    const lineOffset = offset;
    let emitted = 0;
    const emit = (timestamp: string, kind: NeutralTimelineEvent["kind"], data: Record<string, unknown>) => events.push({ kind, timestamp, sessionId: input.sessionId, forgeTurnId: input.forgeTurnId, executionId: input.executionId, executionRole: input.executionRole, sourceOffset: lineOffset + emitted++, data });
    let line: Record<string, unknown>;
    try { line = JSON.parse(raw) as Record<string, unknown>; } catch { unknown++; continue; }
    if (line.type !== "message") { unknown++; continue; }
    const message = record(line.message ?? line);
    const when = stamp(line), role = line.role ?? message.role;
    if (role === "user") {
      activeTurnId = typeof line.id === "string" ? line.id : activeTurnId;
      emit(when, "turn_started", { turnId: activeTurnId });
      emit(when, "message", { role: "human", text: text(contentText(message.content)) });
    } else if (role === "assistant") {
      for (const rawBlock of Array.isArray(message.content) ? message.content : []) {
        const block = record(rawBlock), args = record(block.arguments);
        if (block.type === "thinking") emit(when, "thinking_summary", { text: text(block.text ?? block.thinking) });
        else if (block.type === "text") emit(when, "message", { role: "agent", text: text(block.text) });
        else if (block.type === "toolCall") {
          const name = typeof block.name === "string" ? block.name : "tool";
          if (name === "bash") emit(when, "command", { id: block.id, command: text(args.command ?? args.cmd) });
          else if (["write", "edit"].includes(name)) emit(when, "file_change", { id: block.id, path: text(args.path) });
          else emit(when, "tool_call", { id: block.id, name, input: args });
        }
      }
      const counts = usage(message.usage);
      if (Object.keys(counts).length) emit(when, "usage", counts);
      if (["stop", "error", "aborted"].includes(String(line.stopReason))) {
        emit(when, "turn_finished", { turnId: activeTurnId, ...(line.stopReason === "stop" ? {} : { error: true }) });
        taskComplete = line.stopReason === "stop";
      }
    } else if (role === "toolResult") emit(when, "tool_call", { id: line.toolCallId, output: text(contentText(message.content) || line.content) });
    else unknown++;
  }
  return { events, offset, remainder: tail, taskComplete, unknown, ...(activeTurnId ? { turnId: activeTurnId } : {}) };
}
