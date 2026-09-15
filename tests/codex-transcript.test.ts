import { expect, test } from "vitest";
import { renderCodexEvent } from "../src/runtimes/codex/display.js";
import { codexResultText, codexTools, codexUnsettledToolIds, codexUsage, parseCodexEvents } from "../src/runtimes/codex/transcript.js";

const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "11111111-2222-4333-8444-555555555555" }),
  JSON.stringify({ type: "turn.started" }),
  "not json at all",
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "sparkle_dance", note: "from a later release" } }),
  JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "pnpm test", status: "in_progress" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "pnpm test", aggregated_output: "2 passed", exit_code: 0, status: "completed" } }),
  JSON.stringify({ type: "item.started", item: { id: "item_2", type: "mcp_tool_call", server: "forge_root", tool: "ask_human", arguments: { question: "Ship?" }, status: "in_progress" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "command_execution", command: "false", aggregated_output: "", exit_code: 3, status: "failed" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "file_change", changes: [{ path: "src/a.ts", kind: "modify" }], status: "completed" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_5", type: "agent_message", text: "Reviewed the change." } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 } }),
].join("\n");

test("parsing skips a malformed line and keeps an unknown item type", () => {
  const events = parseCodexEvents(`${lines}\n`);
  expect(events).toHaveLength(10);
  expect(events.filter(event => event.type === "item.completed")).toHaveLength(5);
  expect(parseCodexEvents("").length).toBe(0);
});

test("the last agent message is the turn result", () => {
  expect(codexResultText(parseCodexEvents(lines))).toBe("Reviewed the change.");
  expect(codexResultText(parseCodexEvents(JSON.stringify({ type: "turn.started" })))).toBe("");
});

test("tool evidence records one row per item with its final status", () => {
  const tools = codexTools(parseCodexEvents(lines));
  expect(tools).toEqual([
    { id: "item_1", name: "command_execution", status: "completed", input: { command: "pnpm test" }, output: "2 passed", error: null },
    { id: "item_2", name: "mcp__forge_root__ask_human", status: "running", input: { question: "Ship?" }, output: null, error: null },
    { id: "item_3", name: "command_execution", status: "error", input: { command: "false" }, output: "", error: "exit 3" },
    { id: "item_4", name: "file_change", status: "completed", input: { changes: [{ path: "src/a.ts", kind: "modify" }] }, output: null, error: null },
  ]);
});

test("a started tool item with no completion stays unsettled", () => {
  expect(codexUnsettledToolIds(parseCodexEvents(lines))).toEqual(["item_2"]);
});

test("usage subtracts the cache slices from input and reasoning from output", () => {
  const usage = codexUsage([{ id: "turn-1", model: "gpt-5.6-sol", events: parseCodexEvents(lines), updatedAt: 10 }], "codex-session", "worker");
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", cost: 0, subsidized: false, failed: false, tokens: { input: 300, output: 30, reasoning: 20, cache: { read: 600, write: 100 } } });
});

test("a turn without turn.completed reports no usage", () => {
  const events = parseCodexEvents(JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }));
  expect(codexUsage([{ id: "turn-1", model: "gpt-5.6-sol", events, updatedAt: 10 }], "codex-session", "worker")).toEqual([]);
});

test("each turn is priced with the model it was dispatched with", () => {
  const events = parseCodexEvents(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  const usage = codexUsage([{ id: "turn-1", model: "gpt-5.5", events, updatedAt: 10 }, { id: "turn-2", model: "gpt-6-astra", events, updatedAt: 20 }], "codex-session", "worker");
  expect(usage.map(entry => entry.model)).toEqual(["gpt-5.5", "gpt-6-astra"]);
});

test("an error item is rendered rather than dropped", () => {
  expect(renderCodexEvent(parseCodexEvents(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "context window exceeded" } }))[0]!)).toBe("error: context window exceeded\n");
});
