import { afterEach, expect, test, vi } from "vitest";
import { readNewTaskMemory } from "../src/frontend/features/tasks/new-task-memory.js";

function stubStorage(stored?: object) {
  vi.stubGlobal("localStorage", { getItem: () => stored ? JSON.stringify(stored) : null, setItem: vi.fn() });
}

afterEach(() => { vi.unstubAllGlobals(); });

test("empty memory invents no settings", () => {
  stubStorage();
  expect(readNewTaskMemory()).toEqual({});
});

test("stored choices are restored, and older start mode and delivery target are dropped", () => {
  stubStorage({ projectId: "project", startImmediately: false, deliveryTarget: "pull_request_draft", runProjectTests: false, visualEvidence: "capture" });
  expect(readNewTaskMemory()).toEqual({ projectId: "project", runProjectTests: false, visualEvidence: "capture" });
});
