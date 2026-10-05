import { describe, expect, test } from "vitest";
import { taskTimelineSpan } from "../src/frontend/features/tasks/lib/task-timeline-span.js";
import { taskTimelineDuration } from "../src/frontend/features/timeline/lib/task-timeline-duration.js";

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


test("elapsed span includes CI, ignores older and skipped checks, and uses the supplied clock for live activity", () => {
  const createdAt = "2026-10-05T10:00:00.000Z";
  const startedAt = "2026-10-05T10:01:00.000Z";
  const activity = [{ id: "turn", role: "root" as const, agentId: "root", agentName: "Coordinator", avatarSeed: "root", status: "running" as const, attempt: 1, startedAt, finishedAt: null }];
  const now = Date.parse("2026-10-05T10:04:00.000Z");
  expect(taskTimelineSpan(activity, [], createdAt, now).duration).toBe(180_000);
  const completed = [{ ...activity[0]!, status: "completed" as const, finishedAt: "2026-10-05T10:02:00.000Z" }];
  const runs = [
    { name: "CI", status: "successful" as const, url: null, startedAt: "2026-10-05T10:02:00.000Z", completedAt: "2026-10-05T10:05:00.000Z" },
    { name: "Old CI", status: "pending" as const, url: null, startedAt: "2026-10-05T09:00:00.000Z" },
    { name: "Skipped", status: "successful" as const, conclusion: "SKIPPED", url: null, startedAt, completedAt: "2026-10-05T11:00:00.000Z" },
  ];
  expect(taskTimelineSpan(completed, runs, createdAt, now).duration).toBe(240_000);
  expect(taskTimelineSpan(completed, runs, createdAt, now + 60_000).duration).toBe(240_000);
  expect(taskTimelineSpan([], [], createdAt, now).duration).toBe(0);
});
