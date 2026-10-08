import { describe, expect, test } from "vitest";
import { taskElapsedDuration, taskTimelineDuration } from "../features/timeline/lib/task-timeline-duration.js";

describe("taskTimelineDuration", () => {
  test("formats zero and rounded seconds", () => {
    expect(taskTimelineDuration(0)).toBe("0s");
    expect(taskTimelineDuration(17_499)).toBe("17s");
    expect(taskTimelineDuration(17_500)).toBe("18s");
  });

  test("normalizes the seconds-to-minutes rounding boundary", () => {
    expect(taskTimelineDuration(59_499)).toBe("59s");
    expect(taskTimelineDuration(59_500)).toBe("1m");
  });

  test("formats rounded total minutes as hours and minutes", () => {
    expect(taskTimelineDuration(89 * 60_000)).toBe("1h 29m");
    expect(taskTimelineDuration(59 * 60_000 + 30_000)).toBe("1h");
    expect(taskTimelineDuration(119 * 60_000 + 30_000)).toBe("2h");
  });
});


test("elapsed duration uses the supplied clock for Active and the delivery timestamp for Delivered", () => {
  const startedAt = "2026-10-05T10:01:00.000Z";
  const task = { startedAt, status: "active" as const, statusChangedAt: "2026-10-05T10:05:00.000Z" };
  const now = Date.parse("2026-10-05T10:04:00.000Z");
  expect(taskElapsedDuration(task, now)).toBe(180_000);
  expect(taskElapsedDuration(task, now + 60_000)).toBe(240_000);
  const delivered = { ...task, status: "delivered" as const };
  expect(taskElapsedDuration(delivered, now)).toBe(240_000);
  expect(taskElapsedDuration(delivered, now + 120_000)).toBe(240_000);
  expect(taskElapsedDuration({ status: "active", statusChangedAt: task.statusChangedAt }, now)).toBeNull();
  expect(taskElapsedDuration(task, Date.parse(startedAt) - 1000)).toBe(0);
});
