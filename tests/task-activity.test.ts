import { expect, test } from "vitest";

import { normalizeTaskActivityJsonl } from "../src/task-activity.js";

test("normalizes wrapped Codex JSONL activity and bounds command output", () => {
  const output = "x".repeat(2_100);
  const events = normalizeTaskActivityJsonl([
    JSON.stringify({ at: "2026-08-21T12:00:00.000Z", stream: "stdout", line: JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Inspecting the task" } }) }),
    JSON.stringify({ at: "2026-08-21T12:00:01.000Z", stream: "stdout", line: JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pnpm typecheck" } }) }),
    JSON.stringify({ at: "2026-08-21T12:00:02.000Z", stream: "stdout", line: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pnpm typecheck", aggregated_output: output, exit_code: 0 } }) }),
    JSON.stringify({ at: "2026-08-21T12:00:03.000Z", stream: "stdout", line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }) }),
  ]);
  expect(events).toMatchObject([{ kind: "thinking", text: "Inspecting the task" }, { kind: "command", text: "pnpm typecheck" }, { kind: "output", exitCode: 0 }, { kind: "message", text: "Done" }]);
  expect(events[2]!.text).toHaveLength(2_048);
});
