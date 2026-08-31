import { expect, test } from "vitest";

import { taskListGroups } from "../src/frontend/lib/task-list-groups.js";

const tasks = [
  { id: "done", phase: "done", updatedAt: "2026-08-29T12:00:00.000Z" },
  { id: "cancelled-old", phase: "cancelled", updatedAt: "2026-08-28T12:00:00.000Z" },
  { id: "cancelled-new", phase: "cancelled", updatedAt: "2026-08-30T12:00:00.000Z" },
  { id: "active", phase: "development", updatedAt: "2026-08-27T12:00:00.000Z" },
  { id: "backlog", phase: "backlog", updatedAt: "2026-08-26T12:00:00.000Z" },
] as const;

test("separates completed and cancelled task groups", () => {
  const groups = taskListGroups(tasks, "all");

  expect(groups.map((group) => group.id)).toEqual(["active", "backlog", "completed", "cancelled"]);
  expect(groups.find((group) => group.id === "completed")?.tasks.map((task) => task.id)).toEqual(["done"]);
  expect(groups.find((group) => group.id === "cancelled")?.tasks.map((task) => task.id)).toEqual(["cancelled-new", "cancelled-old"]);
});

test("hides an empty cancelled task group", () => {
  expect(taskListGroups(tasks.filter((task) => task.phase !== "cancelled"), "all").some((group) => group.id === "cancelled")).toBe(false);
});

test("returns only the active group for the active filter", () => {
  expect(taskListGroups(tasks, "active").map((group) => group.id)).toEqual(["active"]);
});
