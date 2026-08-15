import { describe, expect, it } from "vitest";

import { recentTasks, showRecentTasks } from "../src/frontend/components/app/recent-tasks.js";

describe("recentTasks", () => {
  it("returns the five newest tasks first", () => {
    const tasks = ["1", "6", "2", "5", "3", "4"].map((id) => ({ id, phase: "backlog", updatedAt: `2026-08-13T00:00:0${id}.000Z` }));

    expect(recentTasks(tasks).map((task) => task.id)).toEqual(["6", "5", "4", "3", "2"]);
  });

  it("omits cancelled tasks before limiting the list", () => {
    const tasks = ["1", "2", "3", "4", "5", "6"].map((id) => ({ id, phase: id === "6" ? "cancelled" : "backlog", updatedAt: `2026-08-13T00:00:0${id}.000Z` }));

    expect(recentTasks(tasks).map((task) => task.id)).toEqual(["5", "4", "3", "2", "1"]);
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
