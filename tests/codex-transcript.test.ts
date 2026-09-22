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

test("a native started command with null exit code remains visible and unsettled", () => {
  const events = parseCodexEvents(JSON.stringify({ type: "item.started", item: { id: "item_31", type: "command_execution", command: "make test-local", aggregated_output: "37%", exit_code: null, status: "in_progress" } }));
  expect(events[0]).toMatchObject({ type: "item.started", item: { id: "item_31", type: "command_execution" } });
  expect(codexUnsettledToolIds(events)).toEqual(["item_31"]);
  expect(codexTools(events)).toMatchObject([{ name: "command_execution", status: "running", output: "37%", error: null }]);
  expect(renderCodexEvent(events[0]!)).toBe("$ make test-local\n");
});

test("usage subtracts the cache slices from input and reasoning from output", () => {
  const usage = codexUsage([{ id: "turn-1", model: "gpt-5.6-sol", events: parseCodexEvents(lines), updatedAt: 10 }], "codex-session", "worker");
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ provider: "openai", model: "gpt-5.6-sol", cost: 0, subsidized: false, failed: false, tokens: { input: 300, output: 30, reasoning: 20, cache: { read: 600, write: 100 } } });
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

test("usage counts cumulative native thread totals once across shuffled turns", () => {
  const turn = (id: string, thread: string, input: number, updatedAt: number, completed = true, usage = true) => ({
    id, model: "gpt-5.6-sol", updatedAt,
    events: parseCodexEvents([
      JSON.stringify({ type: "thread.started", thread_id: thread }),
      completed ? JSON.stringify({ type: "turn.completed", ...(usage ? { usage: { input_tokens: input, output_tokens: input / 10 } } : {}) }) : "",
    ].filter(Boolean).join("\n")),
  });
  const turns = [
    turn("a-later", "thread-a", 300, 30),
    turn("b-first", "thread-b", 50, 15),
    turn("a-first", "thread-a", 100, 10),
    turn("a-incomplete", "thread-a", 0, 35, false),
    turn("a-no-usage", "thread-a", 0, 40, true, false),
    turn("a-last", "thread-a", 350, 50),
  ];

  const usage = codexUsage(turns, "session", "worker");

  expect(usage.map(entry => [entry.turnId, entry.tokens.input, entry.tokens.output])).toEqual([
    ["a-first", 100, 10], ["b-first", 50, 5], ["a-later", 200, 20],
    ["a-last", 50, 5],
  ]);
});

test("a decreasing native counter does not recount the thread", () => {
  const events = (input: number) => parseCodexEvents([
    JSON.stringify({ type: "thread.started", thread_id: "thread-a" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, output_tokens: input / 10 } }),
  ].join("\n"));
  expect(() => codexUsage([
    { id: "first", model: "gpt-5.6-sol", events: events(100), updatedAt: 10 },
    { id: "reset", model: "gpt-5.6-sol", events: events(20), updatedAt: 20 },
  ], "session", "worker")).toThrow("Codex cumulative usage decreased within native thread thread-a");
});

test("a decrease in one raw field does not price increases in the other fields", () => {
  const events = (input: number, cached: number) => parseCodexEvents([
    JSON.stringify({ type: "thread.started", thread_id: "thread-a" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 20 } }),
  ].join("\n"));
  expect(() => codexUsage([
    { id: "first", model: "gpt-5.6-sol", events: events(100, 80), updatedAt: 10 },
    { id: "ambiguous", model: "gpt-5.6-sol", events: events(200, 0), updatedAt: 20 },
  ], "session", "worker")).toThrow("Codex cumulative usage decreased within native thread thread-a");
});

test("a model change across a missing snapshot leaves only that interval unpriced", () => {
  const events = (model: string, input?: number) => ({
    model, events: parseCodexEvents([
      JSON.stringify({ type: "thread.started", thread_id: "thread-a" }),
      input === undefined ? JSON.stringify({ type: "turn.started" }) : JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, output_tokens: input / 10 } }),
    ].join("\n")),
  });
  const usage = codexUsage([
    { id: "first", ...events("model-a", 100), updatedAt: 10 },
    { id: "gap", ...events("model-b"), updatedAt: 20 },
    { id: "ambiguous", ...events("model-c", 200), updatedAt: 30 },
    { id: "later", ...events("model-c", 250), updatedAt: 40 },
  ], "session", "worker");
  expect(usage.map(entry => [entry.turnId, entry.model, entry.tokens.input])).toEqual([
    ["first", "model-a", 100], ["ambiguous", "unknown", 100], ["later", "model-c", 50],
  ]);
  const sameModel = codexUsage([
    { id: "first", ...events("model-a", 100), updatedAt: 10 },
    { id: "gap", ...events("model-b"), updatedAt: 20 },
    { id: "next", ...events("model-b", 200), updatedAt: 30 },
  ], "session", "worker");
  expect(sameModel[1]?.model).toBe("model-b");
});

test("native message order wins over changed file timestamps and raw counters are subtracted first", () => {
  const events = (input: number, cached: number, output: number, reasoning: number) => parseCodexEvents([
    JSON.stringify({ type: "thread.started", thread_id: "thread-a" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } }),
  ].join("\n"));
  const usage = codexUsage([
    { id: "msg_0002", model: "gpt-5.6-sol", events: events(300, 250, 60, 20), updatedAt: 10 },
    { id: "msg_0001", model: "gpt-5.6-sol", events: events(100, 80, 20, 5), updatedAt: 20 },
  ], "session", "worker");
  expect(usage.map(entry => [entry.turnId, entry.tokens])).toMatchObject([
    ["msg_0001", { input: 20, output: 15, reasoning: 5, cache: { read: 80 } }],
    ["msg_0002", { input: 30, output: 25, reasoning: 15, cache: { read: 170 } }],
  ]);
});

test("an error item is rendered rather than dropped", () => {
  expect(renderCodexEvent(parseCodexEvents(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "context window exceeded" } }))[0]!)).toBe("error: context window exceeded\n");
});
