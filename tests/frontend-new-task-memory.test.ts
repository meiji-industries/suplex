import { expect, test } from "vitest";

import { newTaskMemoryDefaults, readNewTaskMemory, writeNewTaskMemory, type NewTaskMemory } from "../src/frontend/components/app/new-task-memory.js";

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
