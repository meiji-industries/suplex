import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "vitest";

import { CodexRolloutLineSchema, discoverRollout, parseRolloutChunk, timelineEventId } from "../src/codex-rollout.js";

function lines(name: string): unknown[] {
  return readFileSync(resolve(process.cwd(), "tests/fixtures/codex-rollout", name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("interactive rollout fixtures parse and malformed rows are rejected", () => {
  for (const fixture of ["fresh-turn.jsonl", "multi-turn-steering.jsonl", "error-completion.jsonl"]) {
    for (const line of lines(fixture)) expect(CodexRolloutLineSchema.safeParse(line).success).toBe(true);
  }
  const malformed = readFileSync(resolve(process.cwd(), "tests/fixtures/codex-rollout/malformed-line.jsonl"), "utf8").trim();
  expect(() => JSON.parse(malformed)).toThrow();
});

test("legacy user_message fixture still emits a human message", () => {
  const input = {
    sessionId: "session",
    forgeTurnId: "turn",
    executionId: "execution",
    executionRole: "planner" as const,
    offset: 0,
  };
  const legacy = readFileSync(
    resolve(process.cwd(), "tests/fixtures/codex-rollout/fresh-turn.jsonl"),
    "utf8",
  );

  expect(parseRolloutChunk(input, legacy).events).toContainEqual(
    expect.objectContaining({
      kind: "message",
      data: expect.objectContaining({ role: "human", text: "Legacy prompt." }),
    }),
  );
});

test("parser frames partial lines and emits allowlisted events only", () => {
  const input = { sessionId: "session", forgeTurnId: "turn", executionId: "execution", executionRole: "planner" as const, offset: 0 };
  const first = parseRolloutChunk(input, '{"timestamp":"2026-08-23T18:55:47.196Z","type":"event_msg","payload":{"type":"task_started","turn_id":"codex"}}\n{"timestamp":"2026-');
  expect(first.events).toMatchObject([{ kind: "turn_started", data: { turnId: "codex" } }]);
  const second = parseRolloutChunk({ ...input, offset: first.offset }, '08-23T18:55:48.000Z","type":"event_msg","payload":{"type":"agent_message","message":"safe"}}\n', first.remainder);
  expect(second.events).toMatchObject([{ kind: "message", data: { role: "agent", text: "safe" } }]);
  expect(timelineEventId("session", second.offset)).toMatch(/^timeline_[a-f0-9]{64}$/);
});

test("response_item user prompts bind a completion-chain turn", () => {
  const input = {
    sessionId: "session",
    forgeTurnId: "turn",
    executionId: "execution",
    executionRole: "planner" as const,
    offset: 0,
  };
  const marker = "[forge-turn:turn]";
  const rollout = [
    {
      timestamp: "2026-08-24T10:52:08.000Z",
      ordinal: 8,
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_example",
        role: "user",
        content: [
          { type: "input_text", text: `${marker}\n\nForge completion contract` },
        ],
      },
    },
    {
      timestamp: "2026-08-24T10:52:09.000Z",
      ordinal: 9,
      type: "event_msg",
      payload: { type: "task_started", turn_id: "codex-turn" },
    },
    {
      timestamp: "2026-08-24T10:52:10.000Z",
      ordinal: 10,
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "codex-turn", duration_ms: 1 },
    },
  ];

  const parsed = parseRolloutChunk(
    input,
    `${rollout.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  expect(parsed.events).toMatchObject([
    { kind: "message", data: { role: "human", text: expect.stringContaining(marker) } },
    { kind: "turn_started", data: { turnId: "codex-turn" } },
    { kind: "turn_finished", data: { turnId: "codex-turn" } },
  ]);
});

test("custom tool calls retain safe commands and correlate their output previews", () => {
  const input = { sessionId: "session", forgeTurnId: "turn", executionId: "execution", executionRole: "planner" as const, offset: 0 };
  const rollout = [
    { timestamp: "2026-08-24T10:52:08.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call-exec", name: "exec", status: "completed", input: 'const r = await tools.exec_command({"cmd":"printf \\"token=secret\\""});' } },
    { timestamp: "2026-08-24T10:52:09.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-exec", output: [{ type: "input_text", text: "one\ntwo\nthree\nfour\ntoken=secret" }] } },
    { timestamp: "2026-08-24T10:52:10.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call-patch", name: "exec", input: 'const patch = "*** Begin Patch\\n*** Update File: src/a.ts";' } },
  ];
  const parsed = parseRolloutChunk(input, `${rollout.map((line) => JSON.stringify(line)).join("\n")}\n`);
  expect(parsed.events).toContainEqual(expect.objectContaining({ kind: "command", data: expect.objectContaining({ id: "call-exec", text: 'printf "[REDACTED]' }) }));
  expect(parsed.events).toContainEqual(expect.objectContaining({ kind: "tool_call", data: expect.objectContaining({ id: "call-exec", output: "one\ntwo\nthree\nfour\n[REDACTED]" }) }));
  expect(parsed.events).toContainEqual(expect.objectContaining({ kind: "command", data: expect.objectContaining({ id: "call-patch", text: "Apply patch" }) }));
});

test("tool output previews are clipped", () => {
  const input = { sessionId: "session", forgeTurnId: "turn", executionId: "execution", executionRole: "planner" as const, offset: 0 };
  const row = { timestamp: "2026-08-24T10:52:08.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [{ type: "input_text", text: "x".repeat(700) }] } };
  expect((parseRolloutChunk(input, `${JSON.stringify(row)}\n`).events[0]!.data.output as string).length).toBe(600);
});

test("marker discovery chooses the newest rollout when a retry reused its turn ID", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "forge-rollout-"));
  const cwd = resolve(root, "worktree");
  const marker = "[forge-turn:turn]";
  const row = (sessionId: string, suffix: string) => `${JSON.stringify({ timestamp: "2026-08-24T00:00:00.000Z", type: "session_meta", payload: { session_id: sessionId, cwd, originator: "codex-tui", cli_version: "0.149.1" } })}\n${suffix}`;
  try {
    await mkdir(cwd);
    const older = resolve(root, "older.jsonl");
    const newer = resolve(root, "newer.jsonl");
    await writeFile(older, row("older", marker));
    await writeFile(newer, row("newer", marker));
    await utimes(older, new Date(0), new Date(1_000));
    await utimes(newer, new Date(0), new Date(2_000));
    await expect(discoverRollout([older, newer], { cwd, marker })).resolves.toMatchObject({ sessionId: "newer", path: newer });
  } finally { await rm(root, { recursive: true, force: true }); }
});
