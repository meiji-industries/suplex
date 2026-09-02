import { expect, test } from "vitest";

import { taskListGroups } from "../src/frontend/lib/task-list-groups.js";

const tasks = [
  { id: "done", phase: "done", blocked: false, updatedAt: "2026-08-29T12:00:00.000Z" },
  { id: "cancelled-old", phase: "cancelled", blocked: false, updatedAt: "2026-08-28T12:00:00.000Z" },
  { id: "cancelled-new", phase: "cancelled", blocked: false, updatedAt: "2026-08-30T12:00:00.000Z" },
  { id: "active", phase: "building", blocked: false, updatedAt: "2026-08-27T12:00:00.000Z" },
  { id: "ci-repairing", phase: "shipping", blocked: false, updatedAt: "2026-08-27T13:00:00.000Z" },
  { id: "ci-repair-needed", phase: "shipping", blocked: true, updatedAt: "2026-08-27T14:00:00.000Z" },
  { id: "backlog", phase: "backlog", blocked: false, updatedAt: "2026-08-26T12:00:00.000Z" },
] as const;

test("separates completed and cancelled task groups", () => {
  const groups = taskListGroups(tasks, "all");

  expect(groups.map((group) => group.id)).toEqual(["active", "backlog", "blocked", "completed", "cancelled"]);
  expect(groups.find((group) => group.id === "active")?.tasks.map((task) => task.id)).toEqual(["ci-repairing", "active"]);
  expect(groups.find((group) => group.id === "blocked")?.tasks.map((task) => task.id)).toEqual(["ci-repair-needed"]);
  expect(groups.find((group) => group.id === "completed")?.tasks.map((task) => task.id)).toEqual(["done"]);
  expect(groups.find((group) => group.id === "cancelled")?.tasks.map((task) => task.id)).toEqual(["cancelled-new", "cancelled-old"]);
});

test("hides an empty cancelled task group", () => {
  expect(taskListGroups(tasks.filter((task) => task.phase !== "cancelled"), "all").some((group) => group.id === "cancelled")).toBe(false);
});

test("returns in-progress and blocked groups for the active filter", () => {
  expect(taskListGroups(tasks, "active").map((group) => group.id)).toEqual(["active", "blocked"]);
});

test("returns only completed and cancelled groups for the archived filter", () => {
  expect(taskListGroups(tasks, "archived").map((group) => group.id)).toEqual(["completed", "cancelled"]);
});
