import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { ClaudeLiveHistory } from "../src/runtimes/claude-code/live-history.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "suplex-claude-live-history-"));
  directories.push(root);
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  const turn = join(runtime, "turn-live.jsonl");
  const transcript = join(root, "transcript.jsonl");
  await writeFile(turn, "");
  await writeFile(transcript, "");
  return { runtime, turn, transcript, reader: new ClaudeLiveHistory(runtime) };
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

test("Claude live history replaces only the completed blocks of a shared native message", async () => {
  const value = await fixture();
  await appendFile(value.turn, [
    line({ type: "assistant", uuid: "thinking-entry", message: { id: "native-message", role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } }),
    line({ type: "stream_event", event: { type: "message_start", message: { id: "native-message" } } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-id", name: "Bash", input: {} } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"pnpm test\"}" } } }),
    line({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "Partial" } } }),
  ].join(""));

  const partial = await value.reader.read(value.transcript);
  expect(partial).toHaveLength(2);
  expect(partial[0]?.content[0]).toMatchObject({ type: "tool", name: "Bash", status: "running", input: { command: "pnpm test" } });
  expect(partial[1]?.content[0]).toMatchObject({ type: "text", text: "Partial" });

  await appendFile(value.turn, [
    line({ type: "assistant", uuid: "tool-entry", message: { id: "native-message", role: "assistant", content: [{ type: "tool_use", id: "tool-id", name: "Bash", input: { command: "pnpm test" } }] } }),
    line({ type: "user", uuid: "tool-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-id", content: "passed" }] } }),
  ].join(""));
  const toolCompleted = await value.reader.read(value.transcript);
  expect(toolCompleted.map(message => message.id)).toEqual(["tool-entry", partial[1]!.id]);
  expect(toolCompleted[0]?.content[0]).toMatchObject({ type: "tool", status: "completed", output: "passed" });

  await appendFile(value.turn, line({ type: "assistant", uuid: "text-entry", message: { id: "native-message", role: "assistant", content: [{ type: "text", text: "Final" }] } }));
  const completed = await value.reader.read(value.transcript);
  expect(completed.map(message => message.id)).toEqual(["tool-entry", "text-entry"]);
  expect(completed.flatMap(message => message.content).filter(part => part.type === "text").map(part => part.text)).toEqual(["Final"]);
});

test("a transcript completion suppresses the matching runtime draft before the runtime completion arrives", async () => {
  const value = await fixture();
  await appendFile(value.turn, [
    line({ type: "stream_event", event: { type: "message_start", message: { id: "native-message" } } }),
    line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial" } } }),
  ].join(""));
  expect((await value.reader.read(value.transcript))[0]?.content[0]).toMatchObject({ text: "Partial" });

  await appendFile(value.transcript, line({ type: "assistant", uuid: "final-entry", timestamp: "2026-09-15T12:00:00.000Z", message: { id: "native-message", role: "assistant", content: [{ type: "text", text: "Final" }] } }));
  const completed = await value.reader.read(value.transcript);
  expect(completed).toEqual([{ id: "final-entry", role: "assistant", createdAt: 1_789_473_600_000, content: [{ id: "final-entry:text:0", type: "text", text: "Final" }] }]);
});

test("Claude live history waits for a complete JSON line and caches unchanged files", async () => {
  const value = await fixture();
  const entry = line({ type: "assistant", uuid: "utf8-entry", message: { id: "utf8-message", role: "assistant", content: [{ type: "text", text: "split 🥔" }] } });
  const bytes = Buffer.from(entry);
  const split = bytes.indexOf(Buffer.from("🥔")) + 1;
  await appendFile(value.turn, bytes.subarray(0, split));
  expect(await value.reader.read(null)).toEqual([]);
  await appendFile(value.turn, bytes.subarray(split));
  const first = await value.reader.read(null);
  expect(first[0]?.content[0]).toMatchObject({ text: "split 🥔" });
  expect(await value.reader.read(null)).toBe(first);
});
