import { expect, test } from "vitest";

import type { TaskAnalytics } from "../contracts/analytics.js";
import type { TaskUsage } from "../contracts/usage.js";
import { buildActivity } from "../features/analytics/lib/activity.js";

function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return { sessionId: "session", messageId: "message", turnId: "turn", role: "root", provider: "opencode", model: "model", startedAt: 0, completedAt: 1, failed: false, summary: false, steps: 1, cost: 1, subsidized: false, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message", ...overrides };
}

function task(entries: TaskUsage[]): TaskAnalytics {
  return { id: "task", title: "Task", issueKey: null, projectId: "project", status: "delivered", deliveryTarget: "pull_request_draft", archived: false, createdAt: "2026-01-01T00:00:00.000Z", usage: entries, sessions: 1, observedSessions: 1, staleSessions: 0, observedAt: null, observationStartedAt: null, questions: 0, observedWaitMs: 0, deliveryMs: null };
}

function localTime(day: number, hour = 12): number { return new Date(2026, 5, day, hour).getTime(); }
function cell(data: ReturnType<typeof buildActivity>, date: string) { return data.weeks.flatMap(week => week.cells).find(item => item.date === date); }

test("buckets usage by local calendar day", () => {
  const data = buildActivity([task([usage({ startedAt: localTime(10, 23) }), usage({ messageId: "next", startedAt: localTime(11, 0) })])], "tokens", new Date(2026, 5, 11, 12));
  expect(cell(data, "2026-06-10")?.value).toBe(1);
  expect(cell(data, "2026-06-11")?.value).toBe(1);
});

test("aligns Sunday-start weeks and ends values at today", () => {
  const today = new Date(2026, 5, 10, 12);
  const data = buildActivity([], "tokens", today);
  expect(data.weeks).toHaveLength(54);
  expect(data.weeks.every(week => week.cells)).toBe(true);
  expect(data.weeks[0]?.cells[0]?.date).toBe("2025-06-01");
  expect(cell(data, "2026-06-11")).toMatchObject({ future: true, value: null, level: null });
  expect(data.stats.days).toBe(375);
});

test("calculates streaks, averages, and four levels", () => {
  const now = new Date(2026, 5, 10, 12);
  const data = buildActivity([task([
    usage({ startedAt: localTime(6), tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    usage({ messageId: "two", startedAt: localTime(7), tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    usage({ messageId: "three", startedAt: localTime(9), tokens: { input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    usage({ messageId: "four", startedAt: localTime(10), tokens: { input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ])], "tokens", now);
  expect(data.stats).toMatchObject({ total: 10, longestStreak: 2, averagePerDay: 10 / 375, averagePerWeek: 10 / 54 });
  expect([6, 7, 9, 10].map(day => cell(data, `2026-06-${String(day).padStart(2, "0")}`)?.level)).toEqual([1, 2, 3, 4]);
});

test("uses quartiles and drops a leading month label before the next month", () => {
  const now = new Date(2026, 8, 28, 12);
  const data = buildActivity([task([
    usage({ startedAt: new Date(2026, 8, 20, 12).getTime(), tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    usage({ messageId: "two", startedAt: new Date(2026, 8, 21, 12).getTime(), tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    usage({ messageId: "three", startedAt: new Date(2026, 8, 22, 12).getTime(), tokens: { input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    usage({ messageId: "outlier", startedAt: new Date(2026, 8, 23, 12).getTime(), tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ])], "tokens", now);
  expect(data.weeks[0]?.cells[0]?.date).toBe("2025-09-21");
  expect(data.monthLabels.find(label => label.week === 0)).toBeUndefined();
  expect(data.monthLabels.find(label => label.week === 1)).toMatchObject({ label: "Oct" });
  expect([20, 21, 22, 23].map(day => cell(data, `2026-09-${day}`)?.level)).toEqual([1, 2, 3, 4]);
});

test("deduplicates turns and excludes unpriced spend", () => {
  const now = new Date(2026, 5, 10, 12);
  const entries = [usage({ startedAt: localTime(10), cost: 5 }), usage({ messageId: "unpriced", startedAt: localTime(10), cost: 0, tokens: { input: 20, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), usage({ messageId: "same-turn", startedAt: localTime(10), cost: 2 })];
  expect(cell(buildActivity([task(entries)], "spend", now), "2026-06-10")?.value).toBe(7);
  expect(cell(buildActivity([task(entries)], "turns", now), "2026-06-10")?.value).toBe(1);
});
