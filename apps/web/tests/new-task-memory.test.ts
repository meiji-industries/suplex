import { afterEach, expect, test, vi } from "vitest";
import { readNewTaskMemory, rememberedWorkflow } from "../features/tasks/new-task-memory.js";
import type { ApiWorkflow } from "../shell/view-shared.js";

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

test("the selected workflow record is restored", () => {
  stubStorage({ projectId: "project", workflowId: "workflow_custom" });
  expect(readNewTaskMemory()).toEqual({ projectId: "project", workflowId: "workflow_custom" });
});

test("older repair memory drops its forced fields and its engine-only workflow key", () => {
  stubStorage({ projectId: "project", workflow: "refine_pull_request", advisorProfileIds: { reviewer: "profile" }, runProjectTests: false, visualEvidence: "capture" });
  expect(readNewTaskMemory()).toEqual({ projectId: "project", visualEvidence: "capture" });
});

test("a remembered workflow restores only while it is live and admitted for the repository", () => {
  const live = { id: "workflow_custom", engine: "standard", archivedAt: null } as ApiWorkflow;
  const archived = { id: "workflow_old", engine: "standard", archivedAt: "2026-01-01T00:00:00Z" } as ApiWorkflow;
  const repair = { id: "workflow_repair", engine: "refine_pull_request", archivedAt: null } as ApiWorkflow;
  const records = [live, archived, repair];
  expect(rememberedWorkflow(records, "workflow_custom", "github")).toBe(live);
  expect(rememberedWorkflow(records, "workflow_old", "github")).toBeUndefined();
  expect(rememberedWorkflow(records, "workflow_missing", "github")).toBeUndefined();
  expect(rememberedWorkflow(records, undefined, "github")).toBeUndefined();
  expect(rememberedWorkflow(records, "workflow_repair", "github")).toBe(repair);
  expect(rememberedWorkflow(records, "workflow_repair", "bitbucket")).toBeUndefined();
});
