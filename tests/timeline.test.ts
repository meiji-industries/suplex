import { expect, test } from "vitest";

import { clampTimelineRange, trimTimelineRange, summarizeAgentTime, type TimelineTask } from "../src/frontend/views/timeline.js";

function at(day: number, hour: number, minute = 0): string {
  return new Date(2026, 7, day, hour, minute).toISOString();
}

function invocation(id: string, role: "root" | "worker", startedAt: string, finishedAt: string | null, agentId: string, agentName: string, avatarSeed: string): TimelineTask["activity"][number] {
  return { id, role, status: finishedAt ? "completed" : "running", attempt: 1, startedAt, finishedAt, agentId, agentName, avatarSeed };
}

test("agent time is split by local day and summed per ticket", () => {
  const tasks: TimelineTask[] = [
    {
      id: "ticket-a", projectId: "project-a", issueKey: "ADAM-1", title: "First ticket",
      activity: [invocation("planner-a", "root", at(10, 23, 30), at(11, 0, 30), "planner-agent", "Planner agent", "a".repeat(32)), invocation("builder-a", "worker", at(11, 0), at(11, 1), "builder-agent", "Builder agent", "b".repeat(32))],
    },
    {
      id: "ticket-b", projectId: "project-a", issueKey: null, title: "Second ticket",
      activity: [invocation("planner-b", "root", at(11, 0, 15), at(11, 0, 45), "planner-agent", "Planner agent", "a".repeat(32)), invocation("builder-b", "worker", at(11, 1, 45), null, "builder-agent", "Builder agent", "b".repeat(32))],
    },
  ];
  const summary = summarizeAgentTime(tasks, [{ id: "project-a", name: "Forge" }], { start: new Date(2026, 7, 10).getTime(), end: new Date(2026, 7, 12).getTime() }, new Date(2026, 7, 11, 2).getTime());

  expect(summary.durationMs).toBe(165 * 60_000);
  expect(summary.ticketTotals.map(({ key, durationMs }) => ({ key, durationMs }))).toEqual([
    { key: "ticket-a", durationMs: 120 * 60_000 },
    { key: "ticket-b", durationMs: 45 * 60_000 },
  ]);
  expect(summary.ticketTotals.map(({ key, issueKey }) => ({ key, issueKey }))).toEqual([{ key: "ticket-a", issueKey: "ADAM-1" }, { key: "ticket-b", issueKey: null }]);
  expect(summary.dayTotals.map(({ key, durationMs, invocationCount }) => ({ key, durationMs, invocationCount }))).toEqual([
    { key: "2026-08-11", durationMs: 135 * 60_000, invocationCount: 4 },
    { key: "2026-08-10", durationMs: 30 * 60_000, invocationCount: 1 },
  ]);
  expect(summary.lanes.find((lane) => lane.key === "planner-agent")).toMatchObject({ name: "Planner agent", trackCount: 2, durationMs: 90 * 60_000 });
});

test("agent time is grouped by project without changing flat totals", () => {
  const tasks: TimelineTask[] = [
    { id: "ticket-a", projectId: "project-a", issueKey: "FORGE-1", title: "Forge ticket", activity: [invocation("builder-a", "worker", at(10, 9), at(10, 11), "builder-agent", "Builder agent", "a".repeat(32))] },
    { id: "ticket-b", projectId: "project-b", issueKey: "HERDR-1", title: "Herdr ticket", activity: [invocation("planner-b", "root", at(10, 10), at(10, 11), "planner-agent", "Planner agent", "b".repeat(32))] },
    { id: "ticket-c", projectId: "project-unknown", issueKey: null, title: "Unknown ticket", activity: [invocation("builder-c", "worker", at(10, 10, 30), at(10, 11), "builder-agent", "Builder agent", "a".repeat(32))] },
  ];
  const summary = summarizeAgentTime(tasks, [{ id: "project-a", name: "Forge" }, { id: "project-b", name: "Herdr" }], { start: new Date(2026, 7, 10).getTime(), end: new Date(2026, 7, 11).getTime() }, new Date(2026, 7, 11).getTime());

  expect(summary.projectGroups.map(({ projectName, durationMs }) => ({ projectName, durationMs }))).toEqual([
    { projectName: "Forge", durationMs: 120 * 60_000 },
    { projectName: "Herdr", durationMs: 60 * 60_000 },
    { projectName: "Unknown project", durationMs: 30 * 60_000 },
  ]);
  expect(summary.projectGroups.map((group) => group.ticketTotals.map((total) => total.key))).toEqual([["ticket-a"], ["ticket-b"], ["ticket-c"]]);
  for (const group of summary.projectGroups) expect(group.dayTotals.reduce((total, day) => total + day.durationMs, 0)).toBe(group.durationMs);
  expect(summary.projectGroups.reduce((total, group) => total + group.durationMs, 0)).toBe(summary.durationMs);
  expect(summary.ticketTotals.map(({ key, durationMs }) => ({ key, durationMs }))).toEqual([
    { key: "ticket-a", durationMs: 120 * 60_000 },
    { key: "ticket-b", durationMs: 60 * 60_000 },
    { key: "ticket-c", durationMs: 30 * 60_000 },
  ]);
  expect(summary.dayTotals.map(({ key, durationMs }) => ({ key, durationMs }))).toEqual([{ key: "2026-08-10", durationMs: 210 * 60_000 }]);
});

test("timeline selections stay inside the source window and keep a usable width", () => {
  expect(clampTimelineRange({ start: 90, end: 100 }, { start: 0, end: 100 }, 20)).toEqual({ start: 80, end: 100 });
  expect(clampTimelineRange({ start: 80, end: 20 }, { start: 0, end: 100 }, 20)).toEqual({ start: 20, end: 80 });
  expect(clampTimelineRange({ start: -10, end: 120 }, { start: 0, end: 100 }, 20)).toEqual({ start: 0, end: 100 });
});

test("timeline trims empty edges and future time without removing gaps between events", () => {
  expect(trimTimelineRange({ start: 0, end: 100 }, [{ start: 20, end: 30 }, { start: 60, end: 70 }], 80)).toEqual({ start: 20, end: 70 });
  expect(trimTimelineRange({ start: 0, end: 100 }, [{ start: 20, end: 95 }], 80)).toEqual({ start: 20, end: 80 });
  expect(trimTimelineRange({ start: 25, end: 65 }, [{ start: 20, end: 70 }], 80)).toEqual({ start: 25, end: 65 });
  expect(trimTimelineRange({ start: 0, end: 100 }, [], 80)).toEqual({ start: 0, end: 80 });
  expect(trimTimelineRange({ start: 90, end: 100 }, [], 80)).toEqual({ start: 80, end: 80 });
});
