import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { discoverOmpSession, parseOmpChunk } from "../src/omp-rollout.js";

const input = { sessionId: "session-1", forgeTurnId: "forge-turn-1", executionId: "execution-1", executionRole: "builder" as const, offset: 0 };

test("parses omp v18 blocks and preserves the Forge marker", () => {
  const transcript = [
    JSON.stringify({ type: "message", id: "turn-1", timestamp: "2026-08-28T12:00:00.000Z", role: "user", message: { content: [{ type: "text", text: "Do work [forge-turn:forge-turn-1]" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-28T12:00:01.000Z", role: "assistant", stopReason: "stop", message: { content: [{ type: "thinking", text: "think" }, { type: "text", text: "done" }, { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } }),
  ].join("\n") + "\n";
  const parsed = parseOmpChunk(input, transcript);
  expect(parsed.events.map((event) => event.kind)).toEqual(["turn_started", "message", "thinking_summary", "message", "command", "usage", "turn_finished"]);
  expect(parsed.events.find((event) => event.kind === "message" && event.data.role === "human")?.data.text).toContain("[forge-turn:forge-turn-1]");
  expect(new Set(parsed.events.map((event) => event.sourceOffset)).size).toBe(parsed.events.length);
  expect(parsed.events.map((event) => event.timestamp)).toContain("2026-08-28T12:00:01.000Z");
  expect(parsed.taskComplete).toBe(true);
});

test("marks an aborted omp turn as an error", () => {
  const parsed = parseOmpChunk(input, `${JSON.stringify({ type: "message", id: "turn-1", timestamp: "2026-08-28T12:00:00.000Z", role: "assistant", stopReason: "aborted", message: { content: [] } })}\n`, "", { activeTurnId: "turn-1" });
  expect(parsed.taskComplete).toBe(false);
  expect(parsed.events).toContainEqual(expect.objectContaining({ kind: "turn_finished", data: expect.objectContaining({ turnId: "turn-1", error: true }) }));
});

test("discovers v18 title-prefixed and legacy OMP session headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-omp-rollout-"));
  const cwd = join(root, "worktree");
  const titled = join(root, "titled.jsonl");
  const legacy = join(root, "legacy.jsonl");
  try {
    await Promise.all([
      writeFile(titled, `${JSON.stringify({ type: "title", v: 1, title: "" })}\n${JSON.stringify({ type: "session", id: "titled-session", cwd })}\n`),
      writeFile(legacy, `${JSON.stringify({ type: "session", id: "legacy-session", cwd })}\n`),
    ]);
    await expect(discoverOmpSession([titled], { cwd })).resolves.toMatchObject({ path: titled, sessionId: "titled-session" });
    await expect(discoverOmpSession([legacy], { cwd })).resolves.toMatchObject({ path: legacy, sessionId: "legacy-session" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
