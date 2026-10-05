import { describe, expect, test } from "vitest";
import { formatTurnDuration, turnLabel, type TaskActivity } from "../src/frontend/features/tasks/task-work.js";

const completedTurn = {
  id: "turn", sessionId: "session", prompt: "Prompt", status: "completed", promptedAt: "2026-09-21T10:00:00.000Z", completedAt: "2026-09-21T10:05:23.000Z", result: null, assignment: null,
} satisfies TaskActivity["turns"][number];

describe("formatTurnDuration", () => {
  test.each([
    [0, "0s"],
    [42_000, "42s"],
    [59_500, "1m 00s"],
    [303_000, "5m 03s"],
    [323_000, "5m 23s"],
    [3_903_000, "1h 05m 03s"],
  ])("formats %i milliseconds as %s", (milliseconds, expected) => {
    expect(formatTurnDuration(milliseconds)).toBe(expected);
  });
});

test("uses a duration label only for a completed turn with valid timestamps", () => {
  expect(turnLabel(completedTurn)).toBe("Turn took 5m 23s");
  expect(turnLabel({ ...completedTurn, promptedAt: null })).toBe("Turn ended");
  expect(turnLabel({ ...completedTurn, status: "prompted" })).toBe("In progress");
});
