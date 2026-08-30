import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskRoleSelectors, taskRoleDisabled } from "../src/frontend/components/app/task-role-selectors.js";
import type { ApiAgent } from "../src/frontend/lib/view-shared.js";

function agent(role: ApiAgent["role"]): ApiAgent {
  return {
    id: `${role}-1`,
    name: role[0]!.toUpperCase() + role.slice(1),
    role,
    avatarSeed: role,
    profileId: `${role}-profile`,
    archivedAt: null,
    activeCount: 0,
    lastSeenAt: "2026-08-26T12:00:00.000Z",
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
  };
}

describe("task role selectors", () => {
  it("renders one selector for each task role", () => {
    const agents = (["planner", "reviewer", "builder", "integrator"] as const).map(agent);
    const assignments = Object.fromEntries(agents.map((candidate) => [candidate.role, candidate.id]));
    const html = renderToStaticMarkup(createElement(TaskRoleSelectors, { agents, assignments, deliveryTarget: "pull_request_draft", supplementalReview: true, busy: false, onChange: () => undefined }));

    expect(html).toContain('aria-label="Planner assignee: Planner"');
    expect(html).toContain('aria-label="Reviewer assignee: Reviewer"');
    expect(html).toContain('aria-label="Builder assignee: Builder"');
    expect(html).toContain('aria-label="Integrator assignee: Integrator"');
  });

  it("enables roles only when their workflow can use them", () => {
    expect(taskRoleDisabled("reviewer", "pull_request_draft", false)).toBe(true);
    expect(taskRoleDisabled("reviewer", "pull_request_draft", true)).toBe(false);
    expect(taskRoleDisabled("reviewer", "merged", false)).toBe(false);
    expect(taskRoleDisabled("integrator", "local_worktree", false)).toBe(true);
    expect(taskRoleDisabled("integrator", "remote_branch", false)).toBe(true);
    expect(taskRoleDisabled("integrator", "pull_request_draft", false)).toBe(false);
    expect(taskRoleDisabled("planner", "local_worktree", false)).toBe(false);
    expect(taskRoleDisabled("builder", "local_worktree", false)).toBe(false);
  });

  it("shows the agent name in the trigger when assigned, and the role label when not", () => {
    const agents = (["planner", "reviewer", "builder", "integrator"] as const).map((role) => ({
      ...agent(role),
      name: role === "planner" ? "Fable Planner" : role[0]!.toUpperCase() + role.slice(1),
    }));
    const props = { deliveryTarget: "pull_request_draft", supplementalReview: true, busy: false, onChange: () => undefined } as const;
    const assignedHtml = renderToStaticMarkup(createElement(TaskRoleSelectors, { agents, assignments: Object.fromEntries(agents.map((candidate) => [candidate.role, candidate.id])), ...props }));
    expect(assignedHtml).toContain(">Fable Planner<");

    const unassignedHtml = renderToStaticMarkup(createElement(TaskRoleSelectors, { agents, assignments: {}, ...props }));
    expect(unassignedHtml).toContain("Planner");
    expect(unassignedHtml).toContain("Reviewer");
    expect(unassignedHtml).toContain("Builder");
    expect(unassignedHtml).toContain("Integrator");
    expect(unassignedHtml).not.toContain("Fable Planner");
  });
});
