import { expect, test } from "vitest";
import type { TaskActivityAction } from "../contracts/generated/TaskActivityAction.js";
import type { TaskActivityResponse } from "../contracts/generated/TaskActivityResponse.js";
import { actionText, activityRows } from "../features/tasks/task-activity-actions.js";

const forceStart = (queue?: TaskActivityAction["queue"]): TaskActivityAction => ({ id: "audit", action: "task_force_started", actorName: "Chris Bryson", createdAt: "2026-10-21T12:00:00.000Z", ...(queue ? { queue } : {}) });
const wait = (title: string) => ({ kind: "task" as const, id: title, title, status: "active" as const, deliveryTarget: "pull_request_draft" as const, reason: "prerequisite_running" as const, summary: "" });

test("a force start tells what held the task, and an older record tells only the action", () => {
  expect(actionText(forceStart({ projectConcurrencyLimited: true, planConcurrencyLimited: false, waitingOn: [] }))).toBe("started the task anyway. The project task limit was full.");
  expect(actionText(forceStart({ projectConcurrencyLimited: false, planConcurrencyLimited: true, waitingOn: [wait("Build the API")] }))).toBe("started the task anyway. The Free plan task limit was full. Build the API was not complete.");
  expect(actionText(forceStart({ projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [wait("One"), wait("Two")] }))).toBe("started the task anyway. 2 prerequisites were not complete.");
  expect(actionText(forceStart())).toBe("started the task anyway.");
});

test("actions go between the turns by time, and the turn order stays the same", () => {
  const turn = (id: string, promptedAt: string | null): TaskActivityResponse["turns"][number] => ({ id, sessionId: "session", prompt: "", status: promptedAt ? "completed" : "pending_prompt", promptedAt, completedAt: null, result: null, assignment: null });
  const action = (id: string, createdAt: string): TaskActivityAction => ({ ...forceStart(), id, createdAt });
  const rows = activityRows(
    [turn("first", "2026-10-21T12:00:00.000Z"), turn("second", "2026-10-21T12:10:00.000Z"), turn("pending", null)],
    [action("before", "2026-10-21T11:59:00.000Z"), action("between", "2026-10-21T12:05:00.000Z"), action("after", "2026-10-21T12:20:00.000Z")],
  );
  expect(rows.map(row => row.kind === "turn" ? row.turn.id : row.action.id)).toEqual(["before", "first", "between", "second", "pending", "after"]);
});
