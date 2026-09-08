import { describe, expect, it } from "vitest";

import { recentTasks, showRecentTasks } from "../src/frontend/features/tasks/recent-tasks.js";

describe("recentTasks", () => {
  it("returns the ten newest tasks first", () => {
    const tasks = [1, 12, 2, 11, 3, 10, 4, 9, 5, 8, 6, 7].map((id) => ({ id: String(id), status: "backlog" as const, updatedAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z` }));

    expect(recentTasks(tasks).map((task) => task.id)).toEqual(["12", "11", "10", "9", "8", "7", "6", "5", "4", "3"]);
  });

  it("omits cancelled tasks before limiting the list", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => index + 1).map((id) => ({ id: String(id), status: id === 12 ? "cancelled" as const : "backlog" as const, updatedAt: `2026-08-13T00:00:${String(id).padStart(2, "0")}.000Z` }));

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
