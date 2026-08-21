import { expect, test } from "vitest";

import { clampTimelineRange, summarizeAgentTime, type TimelineTask } from "../src/frontend/views/timeline.js";

function at(day: number, hour: number, minute = 0): string {
  return new Date(2026, 7, day, hour, minute).toISOString();
}

function invocation(id: string, role: "planner" | "builder", startedAt: string, finishedAt: string | null, agentId: string, agentName: string, avatarSeed: string) {
  return { id, role, status: finishedAt ? "completed" : "running", attempt: 1, sessionPresent: true, sessionRef: id, startedAt, finishedAt, failureCode: null, failureSummary: null, evidenceArtifactId: null, agentId, agentName, avatarSeed };
}

test("agent time is split by local day and summed per ticket", () => {
  const tasks: TimelineTask[] = [
    {
      id: "ticket-a", projectId: "project-a", issueKey: "ADAM-1", title: "First ticket",
      agentInvocations: [invocation("planner-a", "planner", at(10, 23, 30), at(11, 0, 30), "planner-agent", "Planner agent", "a".repeat(32)), invocation("builder-a", "builder", at(11, 0), at(11, 1), "builder-agent", "Builder agent", "b".repeat(32))],
    },
    {
      id: "ticket-b", projectId: "project-a", issueKey: null, title: "Second ticket",
      agentInvocations: [invocation("planner-b", "planner", at(11, 0, 15), at(11, 0, 45), "planner-agent", "Planner agent", "a".repeat(32)), invocation("builder-b", "builder", at(11, 1, 45), null, "builder-agent", "Builder agent", "b".repeat(32))],
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

test("timeline selections stay inside the source window and keep a usable width", () => {
  expect(clampTimelineRange({ start: 90, end: 100 }, { start: 0, end: 100 }, 20)).toEqual({ start: 80, end: 100 });
  expect(clampTimelineRange({ start: 80, end: 20 }, { start: 0, end: 100 }, 20)).toEqual({ start: 20, end: 80 });
  expect(clampTimelineRange({ start: -10, end: 120 }, { start: 0, end: 100 }, 20)).toEqual({ start: 0, end: 100 });
});
