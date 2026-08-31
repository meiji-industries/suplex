import { describe, expect, it } from "vitest";

import { recentTasks, showRecentTasks } from "../src/frontend/components/app/recent-tasks.js";
import { liveTaskPanes, runtimeStatusLabel } from "../src/frontend/components/app/runtime-presentation.js";
import type { ApiAgentRuntime } from "../src/frontend/lib/view-shared.js";

describe("recentTasks", () => {
  it("returns the ten newest tasks first", () => {
    const tasks = [1, 12, 2, 11, 3, 10, 4, 9, 5, 8, 6, 7].map((id) => ({ id: String(id), phase: "backlog", updatedAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z` }));

    expect(recentTasks(tasks).map((task) => task.id)).toEqual(["12", "11", "10", "9", "8", "7", "6", "5", "4", "3"]);
  });

  it("omits cancelled tasks before limiting the list", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => index + 1).map((id) => ({ id: String(id), phase: id === 12 ? "cancelled" : "backlog", updatedAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z` }));

    expect(recentTasks(tasks).map((task) => task.id)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"]);
  });

  it("hides only in settings", () => {
    expect(showRecentTasks("/tasks")).toBe(true);
    expect(showRecentTasks("/board")).toBe(true);
    expect(showRecentTasks("/projects")).toBe(true);
    expect(showRecentTasks("/profile")).toBe(false);
    expect(showRecentTasks("/admin/profiles")).toBe(false);
    expect(showRecentTasks("/companies/company-a/settings")).toBe(false);
  });
});

it("renders only observed active panes, including idle panes, and excludes terminal panes", () => {
  const runtime = [
    { agentId: "planner", taskId: "task-a", role: "planner", paneId: "pane-idle", liveStatus: "active", diagnosis: "resting", detail: "" },
    { agentId: "builder", taskId: "task-a", role: "builder", paneId: "pane-working", liveStatus: "active", diagnosis: "working", detail: "" },
    { agentId: "reviewer", taskId: "task-a", role: "reviewer", paneId: "pane-done", liveStatus: "terminal", diagnosis: "resting", detail: "" },
    { agentId: "reviewer", taskId: "task-a", role: "reviewer", paneId: "pane-cancelled", liveStatus: "terminal", diagnosis: "resting", detail: "" },
    { agentId: "integrator", taskId: "task-a", role: "integrator", paneId: "pane-missing", liveStatus: "missing", diagnosis: "unknown", detail: "" },
    { agentId: "planner", taskId: "task-b", role: "planner", paneId: "pane-other-task", liveStatus: "active", diagnosis: "blocked", detail: "" },
  ] satisfies ApiAgentRuntime[];

  expect(liveTaskPanes("task-a", runtime).map((pane) => `${pane.role} · ${runtimeStatusLabel(pane)}`)).toEqual(["planner · Idle", "builder · Working"]);
});
