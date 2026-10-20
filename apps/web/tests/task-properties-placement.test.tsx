// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Task } from "../contracts/tasks.js";

vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), readJsonUnchecked: () => new Promise(() => undefined) }));
vi.mock("../features/analytics/lib/analytics.js", () => ({ useTaskCosts: () => new Map() }));
vi.mock("../features/tasks/lib/task-queries.js", () => ({ useTaskActivity: () => ({ data: undefined, error: null, refresh: vi.fn() }) }));
vi.mock("../features/tasks/task-work.js", () => ({ TaskWork: () => null }));
vi.mock("../features/tasks/task-agent.js", () => ({ TaskAgent: () => null }));
vi.mock("../features/tasks/workflow-history.js", () => ({ WorkflowHistory: () => null, WorkflowStatus: () => null }));
vi.mock("../features/tasks/task-chat/live-pane-dock.js", () => ({ LivePaneDock: () => null }));
vi.mock("../features/tasks/pull-request-card.js", () => ({ TaskPullRequestCard: () => null }));

import { TaskDetailsPage } from "../features/tasks/task-details.js";
import type { TaskHealth } from "../features/tasks/task-health.js";

const issue = { kind: "github", repository: "client/repo", number: 420, id: "500", key: "#420", title: "Linked issue", url: "https://github.com/client/repo/issues/420" };
const taskBlocker = { id: "task-first", title: "First prerequisite", status: "backlog" };
const pullRequestBlocker = { id: "pr-7", kind: "pull_request", number: 7, state: "open", title: "Base change", url: "https://github.com/client/repo/pull/7", status: "active" };

function task(overrides: Partial<Record<keyof Task, unknown>> = {}): Task {
  return {
    id: "task-self", companyId: "company-1", projectId: "project-1", issueKey: null, issue: null, title: "This task", description: "", status: "active",
    deliveryTarget: "local_worktree", workflow: "standard", configuration: { repository: "client/repo", branch: "feature/x", runProjectTests: false, visualEvidence: "off" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { admittedTurns: 0 }, images: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", archivedAt: null, ...overrides,
  } as unknown as Task;
}

let cleanup: (() => Promise<void>) | undefined;
beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** Renders the page and opens the Properties panel, then reports which properties sit in the main list and which sit in the panel. */
async function placement(value: Task) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => { await act(async () => { root.unmount(); }); container.remove(); };
  const render = async (next: Task) => { await act(async () => { root.render(<TaskDetailsPage task={next} project={undefined} onChange={() => undefined} />); }); };
  const labels = () => {
    const aside = container.querySelector('aside[aria-label="Task properties"]')!;
    const all = Array.from(aside.querySelectorAll("dt")).map(dt => dt.textContent);
    const panel = aside.querySelector("[data-task-workflow]")!.parentElement!.parentElement!;
    const inPanel = Array.from(panel.querySelectorAll("dt")).map(dt => dt.textContent);
    return { main: all.filter(label => !inPanel.includes(label)), panel: inPanel };
  };
  await render(value);
  const trigger = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Properties")!;
  await act(async () => { trigger.click(); });
  return { labels, render };
}

test("empty Blocked by and Issue render only in the Properties panel, before Workflow", async () => {
  const { labels } = await placement(task());
  const { main, panel } = labels();
  expect(main).not.toContain("Blocked by");
  expect(main).not.toContain("Issue");
  expect(panel.slice(0, 3)).toEqual(["Blocked by", "Issue", "Workflow"]);
});

test("set Blocked by and Issue render after Cost and Turns and before Project, and not in the panel", async () => {
  const { labels } = await placement(task({ blockedBy: [taskBlocker], issue }));
  const { main, panel } = labels();
  expect(main.slice(0, 4)).toEqual(["Status", "Blocked by", "Issue", "Project"]);
  expect(panel).not.toContain("Blocked by");
  expect(panel).not.toContain("Issue");
});

test("a pull request prerequisite alone places Blocked by in the main list and leaves an empty Issue in the panel", async () => {
  const { labels } = await placement(task({ blockedBy: [pullRequestBlocker] }));
  const { main, panel } = labels();
  expect(main.slice(0, 3)).toEqual(["Status", "Blocked by", "Project"]);
  expect(panel.slice(0, 2)).toEqual(["Issue", "Workflow"]);
});

test("a set Issue alone renders in the main list and leaves an empty Blocked by in the panel", async () => {
  const { labels } = await placement(task({ issue }));
  const { main, panel } = labels();
  expect(main.slice(0, 3)).toEqual(["Status", "Issue", "Project"]);
  expect(panel.slice(0, 2)).toEqual(["Blocked by", "Workflow"]);
});

test("each property moves when the current task data sets or clears its value", async () => {
  const { labels, render } = await placement(task());
  await render(task({ blockedBy: [taskBlocker], issue }));
  expect(labels().main.slice(0, 4)).toEqual(["Status", "Blocked by", "Issue", "Project"]);
  await render(task({ issue }));
  expect(labels().main.slice(0, 3)).toEqual(["Status", "Issue", "Project"]);
  expect(labels().panel[0]).toBe("Blocked by");
});

test("the header shows the task health in one badge row, and a healthy task shows none", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => { await act(async () => { root.unmount(); }); container.remove(); };
  const observedAt = new Date().toISOString();
  const health: TaskHealth = { providers: [{ provider: "codex", status: "not-connected", summary: "Codex is not signed in", observedAt }], retries: 2, lastProgressAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), usualTurnSeconds: 600 };
  const render = async (value: TaskHealth | undefined) => { await act(async () => { root.render(<TaskDetailsPage task={task()} project={undefined} onChange={() => undefined} health={value} />); }); };
  const header = () => container.querySelector("[data-task-detail-header]")!;
  await render(health);
  expect(Array.from(header().querySelectorAll('[data-slot="badge"]')).map(badge => [badge.textContent, badge.getAttribute("title")?.startsWith("Last progress") ? "Last progress" : badge.getAttribute("title")])).toEqual([
    ["Codex is not connected", "Codex is not signed in"], ["Retried 2 times", null], ["No progress for 3 h", "Last progress"],
  ]);
  await render({ providers: [{ ...health.providers[0]!, status: "connected" }], retries: 0, lastProgressAt: new Date().toISOString(), usualTurnSeconds: null });
  expect(header().querySelector("[data-task-health]")).toBeNull();
  await render(undefined);
  expect(header().querySelector("[data-task-health]")).toBeNull();
});
