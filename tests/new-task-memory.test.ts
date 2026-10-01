import { afterEach, expect, test, vi } from "vitest";
import { readNewTaskMemory } from "../src/frontend/features/tasks/new-task-memory.js";

function stubStorage(stored?: object) {
  vi.stubGlobal("localStorage", { getItem: () => stored ? JSON.stringify(stored) : null, setItem: vi.fn() });
}

afterEach(() => { vi.unstubAllGlobals(); });

test("empty memory invents no start mode or delivery target", () => {
  stubStorage();
  const memory = readNewTaskMemory();
  expect(memory.startImmediately).toBeUndefined();
  expect(memory.deliveryTarget).toBeUndefined();
});

test("stored choices are restored as remembered", () => {
  stubStorage({ projectId: "project", startImmediately: false, deliveryTarget: "pull_request_draft", runProjectTests: false, visualEvidence: "capture" });
  expect(readNewTaskMemory()).toEqual({ projectId: "project", startImmediately: false, deliveryTarget: "pull_request_draft", runProjectTests: false, visualEvidence: "capture" });
});
