import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { TASK_BRIDGE_ENVIRONMENT_KEYS } from "../src/coordination/bridge-auth.js";
import { claudeDisplayAttached, claudeDisplayCommand, runClaudeDisplay } from "../src/runtimes/claude-code/display.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function runtimeDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "suplex-claude-display-"));
  directories.push(root);
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  return runtime;
}

async function waitForText(read: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (read().includes(text)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${text}`);
}

test("the display command clears bridge credentials and matches only its runtime directory", async () => {
  const first = await runtimeDirectory();
  const second = await runtimeDirectory();
  const display = claudeDisplayCommand(first);
  for (const key of TASK_BRIDGE_ENVIRONMENT_KEYS) expect(display.command).toContain(`'-u' '${key}'`);
  expect(display.command).not.toContain("claude --resume");
  expect(claudeDisplayAttached(first, [display.executable, ...display.args])).toBe(true);
  expect(claudeDisplayAttached(second, [display.executable, ...display.args])).toBe(false);
  expect(claudeDisplayAttached(first, [display.executable, ...display.args, "extra"])).toBe(false);
});

test("the display catches up legacy turns, follows later turns, and renders tools without duplicate text", async () => {
  const runtime = await runtimeDirectory();
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  await writeFile(join(runtime, "turn-1.jsonl"), [
    line({ type: "assistant", uuid: "shared-thinking", message: { id: "shared-message", role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } }),
    line({ type: "assistant", uuid: "shared-tool", message: { id: "shared-message", role: "assistant", content: [{ type: "tool_use", id: "shared-tool-id", name: "Glob", input: { pattern: "src/**" } }] } }),
    line({ type: "assistant", uuid: "legacy-a", message: { id: "legacy-message", role: "assistant", content: [{ type: "text", text: "Legacy answer" }, { type: "tool_use", id: "legacy-tool", name: "Read", input: { file_path: "/repo/id" } }] } }),
    line({ type: "user", uuid: "legacy-u", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "legacy-tool", content: "abc\u001b[31m" }] } }),
  ].join(""));
  await delay(5);
  await writeFile(join(runtime, "turn-2.jsonl"), line({ type: "result", subtype: "error_max_turns", is_error: true, result: "Second turn failed", session_id: "session" }));

  let output = "";
  const controller = new AbortController();
  const running = runClaudeDisplay(runtime, { output: { write: value => { output += String(value); return true; } }, pollIntervalMs: 5, signal: controller.signal });
  await waitForText(() => output, "Second turn failed");
  expect(output.indexOf("Legacy answer")).toBeLessThan(output.indexOf("Second turn failed"));
  expect(output).toContain("[Tool: Glob]\n[Tool input: Glob] {\"pattern\":\"src/**\"}");
  expect(output).toContain("[Tool: Read]\n[Tool input: Read] {\"file_path\":\"/repo/id\"}");
  expect(output).toContain("[Result: Read]\nabc");
  expect(output).not.toContain("[31m");
  expect(output).not.toContain("\u001b");

  const third = join(runtime, "turn-3.jsonl");
  await writeFile(third, [
    line({ type: "stream_event", event: { type: "message_start", message: { id: "stream-message" } } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Live " } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "stream-tool", name: "Bash", input: {} } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"pnpm" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: " test\"}" } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
    line({ type: "assistant", uuid: "stream-a", message: { id: "stream-message", role: "assistant", content: [{ type: "text", text: "Live answer" }, { type: "tool_use", id: "stream-tool", name: "Bash", input: { command: "pnpm test" } }] } }),
    line({ type: "user", uuid: "stream-u", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "stream-tool", content: [{ type: "text", text: "Tests passed" }] }] } }),
    line({ type: "result", subtype: "success", is_error: false, result: "Live answer", session_id: "session" }),
  ].join(""));
  await waitForText(() => output, "Tests passed");
  expect(output.match(/Live answer/g)).toHaveLength(1);
  expect(output.match(/\[Tool: Bash\]/g)).toHaveLength(1);
  expect(output).toContain("Live answer\n[Tool: Bash]");
  expect(output).toContain("[Tool input: Bash] {\"command\":\"pnpm test\"}");
  expect(output).toContain("[Result: Bash]\nTests passed");
  controller.abort();
  await running;
});

test("the display keeps partial JSON and UTF-8 across reads and recovers after oversized records", async () => {
  const runtime = await runtimeDirectory();
  const path = join(runtime, "turn-partial.jsonl");
  await writeFile(path, "");
  let output = "";
  const controller = new AbortController();
  const running = runClaudeDisplay(runtime, { output: { write: value => { output += String(value); return true; } }, pollIntervalMs: 5, signal: controller.signal });
  await waitForText(() => output, "No Claude output yet.");

  const event = Buffer.from(`${JSON.stringify({ type: "assistant", uuid: "utf8-a", message: { id: "utf8-message", role: "assistant", content: [{ type: "text", text: "split 🥔" }] } })}\n`);
  const split = event.indexOf(Buffer.from("🥔")) + 1;
  await appendFile(path, event.subarray(0, split));
  await delay(30);
  expect(output).not.toContain("split");
  await appendFile(path, event.subarray(split));
  await waitForText(() => output, "split 🥔");

  await appendFile(path, `${JSON.stringify({ type: "assistant", uuid: "oversized-a", message: { id: "oversized-message", role: "assistant", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] } })}\nnot json\n`);
  await appendFile(path, `${JSON.stringify({ type: "assistant", uuid: "recovered-a", message: { id: "recovered-message", role: "assistant", content: [{ type: "text", text: "Recovered" }] } })}\n`);
  await waitForText(() => output, "Recovered");
  expect(output).toContain("Suplex omitted a Claude record larger than 8 MiB.");
  expect(output).not.toContain("x".repeat(100));
  controller.abort();
  await running;
});

test("the display parses large valid tool results and truncates only their preview", async () => {
  const runtime = await runtimeDirectory();
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  await writeFile(join(runtime, "turn-large-result.jsonl"), [
    line({ type: "assistant", uuid: "large-tool", message: { id: "large-message", role: "assistant", content: [{ type: "tool_use", id: "large-read", name: "Read", input: { file_path: "/repo/large.log" } }] } }),
    line({ type: "user", uuid: "large-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "large-read", content: `result-start ${"z".repeat(300 * 1024)} result-end` }] } }),
    line({ type: "assistant", uuid: "after-large", message: { id: "after-large-message", role: "assistant", content: [{ type: "text", text: "After large result" }] } }),
  ].join(""));
  let output = "";
  const controller = new AbortController();
  const running = runClaudeDisplay(runtime, { output: { write: value => { output += String(value); return true; } }, pollIntervalMs: 5, signal: controller.signal });
  await waitForText(() => output, "After large result");
  expect(output).toContain("[Result: Read]\nresult-start");
  expect(output).toContain("[Output truncated]");
  expect(output).not.toContain("result-end");
  expect(output).not.toContain("Suplex omitted");
  controller.abort();
  await running;
});

test("the display renders documented server web search tool blocks", async () => {
  const runtime = await runtimeDirectory();
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  await writeFile(join(runtime, "turn-web-search.jsonl"), line({
    type: "assistant",
    uuid: "web-search-entry",
    message: {
      id: "web-search-message",
      role: "assistant",
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Claude Shannon birth date" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com/shannon", title: "Claude Shannon", encrypted_content: "opaque" }] },
      ],
    },
  }));
  let output = "";
  const controller = new AbortController();
  const running = runClaudeDisplay(runtime, { output: { write: value => { output += String(value); return true; } }, pollIntervalMs: 5, signal: controller.signal });
  await waitForText(() => output, "Claude Shannon");
  expect(output).toContain("[Tool: web_search]");
  expect(output).toContain("[Tool input: web_search] {\"query\":\"Claude Shannon birth date\"}");
  expect(output).toContain("[Result: web_search]");
  expect(output).toContain("https://example.com/shannon");
  controller.abort();
  await running;
});

test("the display drains an older large turn before it renders a newer turn", async () => {
  const runtime = await runtimeDirectory();
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const older = Array.from({ length: 900 }, (_, index) => line({ type: "assistant", uuid: `old-${index}`, message: { id: `old-message-${index}`, role: "assistant", content: [{ type: "text", text: `${"x".repeat(80)} ${index === 899 ? "OLD TAIL" : index}` }] } })).join("");
  await writeFile(join(runtime, "turn-old.jsonl"), older);
  await delay(5);
  await writeFile(join(runtime, "turn-new.jsonl"), line({ type: "assistant", uuid: "new", message: { id: "new-message", role: "assistant", content: [{ type: "text", text: "NEW REPLY" }] } }));
  let output = "";
  const controller = new AbortController();
  const running = runClaudeDisplay(runtime, { output: { write: value => { output += String(value); return true; } }, pollIntervalMs: 5, signal: controller.signal });
  await waitForText(() => output, "OLD TAIL");
  await waitForText(() => output, "NEW REPLY");
  expect(output.indexOf("OLD TAIL")).toBeLessThan(output.indexOf("NEW REPLY"));
  controller.abort();
  await running;
});
