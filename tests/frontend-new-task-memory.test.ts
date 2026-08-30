import { expect, test } from "vitest";

import { newTaskFormSettings, newTaskMemoryDefaults, readNewTaskMemory, resolveNewTaskProjectId, writeNewTaskMemory, type NewTaskMemory } from "../src/frontend/components/app/new-task-memory.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("round trips all new task settings", () => {
  const storage = memoryStorage();
  const memory: NewTaskMemory = { projectId: "project-1", deliveryTarget: "merged", autoApprovePlan: true, runProjectTests: false, visualEvidence: "required", supplementalReview: true, roleAgents: { planner: "planner-1", builder: "builder-1", reviewer: "reviewer-1", integrator: "integrator-1" } };

  writeNewTaskMemory(memory, storage);

  expect(readNewTaskMemory(storage)).toEqual(memory);
});

test("derives all form settings and remembered role agents", () => {
  const memory: NewTaskMemory = { projectId: "project-1", deliveryTarget: "merged", autoApprovePlan: true, runProjectTests: false, visualEvidence: "required", supplementalReview: true, roleAgents: { builder: "cheap-agent" } };

  expect(newTaskFormSettings(memory)).toEqual({ deliveryTarget: "merged", autoApprovePlan: true, runProjectTests: false, visualEvidence: "required", supplementalReview: true, roleAgents: { builder: "cheap-agent" } });
});

test("copies remembered role agents into a fresh object", () => {
  const memory: NewTaskMemory = { ...newTaskMemoryDefaults, roleAgents: { builder: "cheap-agent" } };

  expect(newTaskFormSettings(memory).roleAgents).not.toBe(memory.roleAgents);
});

test("derives empty role agents from new task defaults", () => {
  expect(newTaskFormSettings(newTaskMemoryDefaults).roleAgents).toEqual({});
});

test("returns defaults when the key is missing", () => {
  expect(readNewTaskMemory(memoryStorage())).toEqual(newTaskMemoryDefaults);
});

test("keeps valid fields and defaults invalid enum values", () => {
  const invalidJson = { getItem: () => "not-json" };
  const invalidValues = { getItem: () => JSON.stringify({ projectId: "project-2", deliveryTarget: "invalid", autoApprovePlan: true, runProjectTests: false, visualEvidence: "invalid", supplementalReview: true, roleAgents: { planner: "planner-2" } }) };

  expect(readNewTaskMemory(invalidJson)).toEqual(newTaskMemoryDefaults);
  expect(readNewTaskMemory(invalidValues)).toEqual({ ...newTaskMemoryDefaults, projectId: "project-2", autoApprovePlan: true, runProjectTests: false, supplementalReview: true, roleAgents: { planner: "planner-2" } });
});

test("returns defaults when storage throws", () => {
  expect(readNewTaskMemory({ getItem: () => { throw new Error("unavailable"); } })).toEqual(newTaskMemoryDefaults);
});

test("drops non-string role agent values", () => {
  const storage = { getItem: () => JSON.stringify({ ...newTaskMemoryDefaults, roleAgents: { planner: "planner-1", builder: 12, reviewer: null, integrator: false } }) };

  expect(readNewTaskMemory(storage).roleAgents).toEqual({ planner: "planner-1" });
});

test("resolves the remembered project id when it exists in the project list", () => {
  const projects = [{ id: "rtd" }, { id: "forge" }];

  expect(resolveNewTaskProjectId("forge", projects)).toBe("forge");
});

test("falls back to the first project when the remembered id is missing or unknown", () => {
  const projects = [{ id: "rtd" }, { id: "forge" }];

  expect(resolveNewTaskProjectId(undefined, projects)).toBe("rtd");
  expect(resolveNewTaskProjectId("", projects)).toBe("rtd");
  expect(resolveNewTaskProjectId("other-company-project", projects)).toBe("rtd");
});

test("returns an empty string when the project list is empty", () => {
  expect(resolveNewTaskProjectId("forge", [])).toBe("");
});
