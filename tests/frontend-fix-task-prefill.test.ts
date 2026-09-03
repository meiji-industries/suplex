import { describe, expect, test } from "vitest";

import { findForgeProject, fixTaskDraft, type TaskDiagnostics } from "../src/frontend/lib/fix-task-prefill.js";
import type { ApiProject, ApiTask } from "../src/frontend/lib/view-shared.js";

function project(name: string, repository: string | undefined): ApiProject {
  return { id: `${name}-${repository}`, companyId: "company-1", name, repository } as ApiProject;
}

function task(overrides: Partial<ApiTask> = {}): ApiTask {
  return {
    id: "task-1",
    issueKey: null,
    title: "Waiting for a codex agent slot",
    description: "The task appeared to be waiting for capacity.",
    workflowId: "workflow-1",
    phase: "failed",
    owner: "human",
    revision: 3,
    pendingAction: "The interactive role result does not satisfy its advertised schema",
    projection: { status: "current", projectedRevision: 3, authoritativeRevision: 3 },
    lastHandlerError: { command: "start_planning", reason: "The interactive role result does not satisfy its advertised schema", at: "2026-08-30T14:16:37.486Z" },
    agentInvocations: [{ id: "agent-1", role: "planner", status: "failed", agentName: "Fable Planner", model: "claude-fable-5", failureCode: "invalid-output-schema", failureSummary: "The interactive role result does not satisfy its advertised schema" }],
    capacity: null,
    ...overrides,
  } as ApiTask;
}

const diagnostics: TaskDiagnostics = {
  workflow: { status: "RUNNING", lastWorkflowTaskFailure: null, pendingWorkflowTaskAgeSeconds: null, buildId: null, currentBuildId: null },
  executions: [{ id: "agent-1", kind: "agent", status: "failed", pid: null, terminal: true }],
  capacityRequests: [],
  leases: [],
};

describe("findForgeProject", () => {
  test("requires both the Forge name and canonical repository identity", () => {
    const expected = project("forge", "meiji-industries/forge");
    expect(findForgeProject([project("forge", "someone-else/forge"), project("Forge mirror", "meiji-industries/forge"), expected])).toBe(expected);
    expect(findForgeProject([project("forge", "someone-else/forge")])).toBeUndefined();
  });

  test("matches the configured name and repository without case sensitivity", () => {
    expect(findForgeProject([project(" Forge ", "MEIJI-INDUSTRIES/FORGE")])?.name).toBe(" Forge ");
  });
});

describe("fixTaskDraft", () => {
  test("prefers the observed failure over the source task's hypothesis", () => {
    const draft = fixTaskDraft(task(), diagnostics, "https://forge.test/tasks/task-1?company=company-1", "2026-08-30T15:00:00.000Z");

    expect(draft.title).toBe("Fix Forge task failure: invalid-output-schema");
    expect(draft.description).toContain("https://forge.test/tasks/task-1?company=company-1");
    expect(draft.description).toContain("- Failed invocation: planner · Fable Planner · claude-fable-5 · failed · invalid-output-schema");
    expect(draft.description).toContain("- Workflow status: RUNNING");
    expect(draft.description).toContain("- Capacity requests: none");
    expect(draft.description).toContain("Prefer simplifying or removing unnecessary logic and special cases.");
  });

  test("still produces an actionable draft when deeper diagnostics are unavailable", () => {
    const draft = fixTaskDraft(task({ phase: "planning", lastHandlerError: null, agentInvocations: [], pendingAction: "The Planner writes the plan" }), undefined, "https://forge.test/tasks/task-1", "2026-08-30T15:00:00.000Z");
    expect(draft.title).toBe("Fix Forge behavior observed in Waiting for a codex agent slot");
    expect(draft.description).toContain("Diagnostics endpoint was unavailable");
  });
});
