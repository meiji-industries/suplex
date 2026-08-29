import { describe, expect, test } from "vitest";

import { duplicateTaskDraft } from "../src/frontend/lib/duplicate-task-prefill.js";
import type { ApiTask } from "../src/frontend/lib/view-shared.js";

function task(overrides: Partial<ApiTask> = {}): ApiTask {
  return {
    projectId: "project-1",
    title: "Source task",
    description: "Source description",
    roleAgents: { planner: "planner-1", builder: "builder-1" },
    autoApprovePlan: true,
    deliveryTarget: "pull_request_ready",
    executionControls: { runProjectTests: false, visualEvidence: "required", supplementalReview: true },
    ...overrides,
  } as ApiTask;
}

describe("duplicateTaskDraft", () => {
  test("copies task settings and adds the next title suffix", () => {
    const draft = duplicateTaskDraft(task(), new Set(["Source task"]));

    expect(draft).toEqual({
      projectId: "project-1",
      title: "Source task (2)",
      description: "Source description",
      roleAgents: { planner: "planner-1", builder: "builder-1" },
      autoApprovePlan: true,
      deliveryTarget: "pull_request_ready",
      runProjectTests: false,
      visualEvidence: "required",
      supplementalReview: true,
      source: undefined,
    });
  });

  test("normalizes an existing suffix and skips used titles", () => {
    const draft = duplicateTaskDraft(task({ title: "Source task (2)" }), new Set(["Source task (2)"]));
    expect(draft.title).toBe("Source task (3)");
  });

  test("maps a pull request source", () => {
    const draft = duplicateTaskDraft(task({ source: { kind: "pull_request", number: 42, url: "https://github.com/acme/forge/pull/42", headBranch: "feature", baseBranch: "main" } }), new Set());
    expect(draft.source).toEqual({ kind: "pull_request", number: 42 });
  });

  test("maps a branch source", () => {
    const draft = duplicateTaskDraft(task({ source: { kind: "branch", branch: "feature" } }), new Set());
    expect(draft.source).toEqual({ kind: "branch", branch: "feature" });
  });
});
