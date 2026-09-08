import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeExecution, claudeMessageEntries, claudeUnsettledToolIds, claudeUsage, findClaudeTranscript, parseJsonLines, readClaudeTranscript } from "../src/runtimes/claude-code/transcript.js";
import type { ModelPricing } from "../src/profiles/model-pricing.js";

const usage = { input_tokens: 9, output_tokens: 82, cache_read_input_tokens: 5, cache_creation_input_tokens: 6053, output_tokens_details: { thinking_tokens: 74 } };
const lines = [
  { type: "queue-operation", operation: "enqueue" },
  { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-09-07T15:37:02.162Z", message: { role: "user", content: "Read the id file" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-09-07T15:37:24.252Z", message: { model: "claude-haiku-4-5-20251001", id: "msg_1", role: "assistant", content: [{ type: "thinking", thinking: "" }], usage } },
  { type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: "2026-09-07T15:37:24.300Z", message: { model: "claude-haiku-4-5-20251001", id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/id" } }, { type: "tool_use", id: "toolu_2", name: "TodoWrite", input: { todos: [{ content: "Inspect", status: "completed", activeForm: "Inspecting" }, { content: "Reply", status: "in_progress", activeForm: "Replying" }] } }], usage } },
  { type: "user", uuid: "u2", parentUuid: "a2", timestamp: "2026-09-07T15:37:24.400Z", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "1\tabc\n" }, { tool_use_id: "toolu_2", type: "tool_result", content: [{ type: "text", text: "Todos have been modified" }] }] } },
  { type: "assistant", uuid: "a3", parentUuid: "u2", timestamp: "2026-09-07T15:37:25.252Z", message: { model: "claude-haiku-4-5-20251001", id: "msg_2", role: "assistant", content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "false" } }], usage: { ...usage, input_tokens: 8 } } },
  { type: "user", uuid: "u3", parentUuid: "a3", timestamp: "2026-09-07T15:37:26.000Z", message: { role: "user", content: [{ tool_use_id: "toolu_3", type: "tool_result", content: "exit 1", is_error: true }] } },
  { type: "assistant", uuid: "a4", parentUuid: "u3", timestamp: "2026-09-07T15:37:27.000Z", isSidechain: true, message: { model: "claude-haiku-4-5-20251001", id: "msg_side", role: "assistant", content: [{ type: "text", text: "subagent" }], usage } },
  { type: "assistant", uuid: "a5", parentUuid: "u3", timestamp: "2026-09-07T15:37:28.000Z", isApiErrorMessage: true, message: { model: "claude-haiku-4-5-20251001", role: "assistant", content: [{ type: "text", text: "API Error" }] } },
];
const text = `${lines.map(line => JSON.stringify(line)).join("\n")}\n{"type":"assistant","truncated`;

test("execution reads tool results, plans, and unsettled tools from a transcript", () => {
  const entries = claudeMessageEntries(parseJsonLines(text));
  expect(entries.map(entry => entry.uuid)).toEqual(["u1", "a1", "a2", "u2", "a3", "u3", "a5"]);
  const execution = claudeExecution(entries);
  expect(execution.tools).toEqual([
    { id: "toolu_1", name: "Read", status: "completed", input: { file_path: "/repo/id" }, output: "1\tabc\n", error: null },
    expect.objectContaining({ id: "toolu_2", name: "TodoWrite", status: "completed", output: "Todos have been modified" }),
    { id: "toolu_3", name: "Bash", status: "error", input: { command: "false" }, output: null, error: "exit 1" },
  ]);
  expect(execution.plan).toEqual([{ content: "Inspect", status: "completed" }, { content: "Reply", status: "in_progress" }]);
  expect(claudeUnsettledToolIds(entries)).toEqual([]);
  expect(claudeUnsettledToolIds(entries.slice(0, 5))).toEqual(["toolu_3"]);
});

test("usage records one entry per API response, keyed by the prompt that started the turn", () => {
  const pricing = new Map<string, ModelPricing>([["anthropic/claude-haiku-4-5-20251001", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }]]);
  const usage = claudeUsage(claudeMessageEntries(parseJsonLines(text)), "11111111-2222-4333-8444-555555555555", "worker", pricing);
  expect(usage.map(entry => [entry.messageId, entry.turnId, entry.failed])).toEqual([["a1", "u1", false], ["a3", "u1", false], ["a5", "u1", true]]);
  expect(usage[0]).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20251001", role: "worker", steps: 1, subsidized: true, tokens: { input: 9, output: 82, reasoning: 74, cache: { read: 5, write: 6053 } }, startedAt: Date.parse("2026-09-07T15:37:24.252Z"), completedAt: Date.parse("2026-09-07T15:37:24.252Z") });
  expect(usage[0]?.cost).toBeCloseTo((9 * 1 + (82 + 74) * 5 + 5 * 0.1 + 6053 * 1.25) / 1_000_000);
  expect(claudeUsage(claudeMessageEntries(parseJsonLines(text)), "s", "root")[0]).toMatchObject({ cost: 0, subsidized: false });
});

test("transcripts are located by session id across Claude projects", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "forge-claude-config-"));
  try {
    expect(await findClaudeTranscript("missing", configDirectory)).toBeNull();
    await mkdir(join(configDirectory, "projects", "-repo-a"), { recursive: true });
    await mkdir(join(configDirectory, "projects", "-repo-b"), { recursive: true });
    await writeFile(join(configDirectory, "projects", "-repo-b", "abc.jsonl"), text);
    expect(await findClaudeTranscript("abc", configDirectory)).toBe(join(configDirectory, "projects", "-repo-b", "abc.jsonl"));
    expect((await readClaudeTranscript("abc", configDirectory)).at(-1)?.uuid).toBe("a5");
    await expect(readClaudeTranscript("missing", configDirectory)).rejects.toThrow("not available");
  } finally { await rm(configDirectory, { recursive: true, force: true }); }
});
