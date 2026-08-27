import { expect, test } from "vitest";

import { NeutralTimelineEventSchema } from "../src/codex-rollout.js";
import { parseClaudeChunk, sanitizeClaudeLine } from "../src/claude-rollout.js";

const input = { offset: 0, sessionId: "session", forgeTurnId: "turn", executionId: "execution", executionRole: "reviewer" } as const;
const userId = "00000000-0000-4000-8000-000000000001";
const rows = [
  { type: "user", uuid: userId, timestamp: "2026-08-27T00:00:00.000Z", message: { content: "[forge-turn:turn]\nPrompt" } },
  { type: "assistant", timestamp: "2026-08-27T00:00:01.000Z", message: { content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "working" }, { type: "tool_use", id: "bash", name: "Bash", input: { command: "pwd", description: "Print cwd" } }], usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } } },
  { type: "user", timestamp: "2026-08-27T00:00:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "/tmp" }] } },
  { type: "assistant", timestamp: "2026-08-27T00:00:03.000Z", message: { content: [{ type: "tool_use", id: "write", name: "Write", input: { file_path: "/tmp/result.json" } }], usage: { input_tokens: 5 } } },
  { type: "assistant", timestamp: "2026-08-27T00:00:04.000Z", message: { content: [{ type: "text", text: "done" }], usage: { output_tokens: 6 } } },
  { type: "system", subtype: "turn_duration", timestamp: "2026-08-27T00:00:05.000Z", durationMs: 5 },
];
const transcript = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

test("parses Claude transcript events, offsets, and completion", () => {
  const parsed = parseClaudeChunk(input, transcript);
  expect(parsed.events.map((event) => event.kind)).toEqual(["turn_started", "message", "thinking_summary", "message", "command", "usage", "tool_call", "file_change", "usage", "message", "usage", "turn_finished"]);
  expect(parsed.events.at(-1)?.data).toMatchObject({ turnId: userId, durationMs: 5 });
  expect(parsed.taskComplete).toBe(true);
  expect(parsed.offset).toBe(Buffer.byteLength(transcript));
  for (const event of parsed.events) NeutralTimelineEventSchema.parse(event);
});

test("frames split Claude rows and ignores non-timeline records", () => {
  const first = parseClaudeChunk(input, transcript.slice(0, 47));
  const second = parseClaudeChunk({ ...input, offset: first.offset }, `${transcript.slice(47)}${JSON.stringify({ type: "attachment" })}\n${JSON.stringify({ type: "assistant", isSidechain: true })}\nnot json\n`, first.remainder, first.turnId ? { activeTurnId: first.turnId } : {});
  const whole = parseClaudeChunk(input, transcript);
  expect([...first.events, ...second.events].map((event) => event.kind)).toEqual([...whole.events.map((event) => event.kind), "message"]);
  expect(second.events.at(-1)?.data).toMatchObject({ role: "system", level: "error", text: "Malformed Claude transcript line" });
  expect(sanitizeClaudeLine(JSON.stringify(rows[1]))).toBe(JSON.stringify({ type: "assistant" }));
});
