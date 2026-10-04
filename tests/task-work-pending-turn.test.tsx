// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Task } from "../src/frontend/contracts/tasks.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);
vi.mock("../src/frontend/shell/company-context.js", () => ({ useOptionalCompanyContext: () => undefined, useCompanyContext: () => ({ user: { id: "user" }, currentCompany: { id: "company-1" } }) }));

import { TaskWork, type TaskActivity } from "../src/frontend/features/tasks/task-work.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title: "Show progress", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "progress", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
  dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
} satisfies Task;

const session = { id: "session-1", kind: "root", advisorRole: null, label: "Coordinator", profileId: "profile", generation: 1, nativeSessionId: null, paneId: null, current: true, replacement: null, harness: "claude-code" } as const;
const done = { id: "turn-1", sessionId: "session-1", prompt: "Start", status: "completed", promptedAt: "2026-09-08T00:00:00.000Z", completedAt: "2026-09-08T00:00:05.000Z", result: JSON.stringify({ text: "First reply" }) } as const;
const note = { id: "turn-2", sessionId: "session-1", prompt: "Human note:\nPlease continue", promptedAt: "2026-09-08T00:01:00.000Z", completedAt: null, result: null } as const;

function activityWith(turn: TaskActivity["turns"][number]): TaskActivity {
  return { sessions: [session], turns: [done, turn], shellPaneId: null } satisfies TaskActivity;
}

const cleanups: Array<() => void> = [];

function mount(taskInput: Task = task) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => { root.unmount(); client.clear(); container.remove(); });
  return { container, render: async (activity: TaskActivity) => { await act(async () => { root.render(<QueryClientProvider client={client}><TaskWork task={taskInput} activity={activity} onChange={() => {}} /></QueryClientProvider>); await Promise.resolve(); }); } };
}

afterEach(async () => {
  await act(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJsonUnchecked.mockReset();
  api.readJsonUnchecked.mockImplementation(async (url: string) => url.endsWith("/execution") ? { sessions: [] } : url.endsWith("/timeline") ? { tasks: [], unavailableSessions: 0 } : url.endsWith("/diff/summary") ? { available: false, files: 0 } : Promise.reject(new Error(`Unexpected request: ${url}`)));
  notifyManager.setScheduler(queueMicrotask);
});

test("the conversation shows a busy row while the Coordinator turn is queued or working, and removes it when the turn ends", async () => {
  const view = mount();
  const pending = () => view.container.querySelector<HTMLElement>("[data-task-turn-pending]");

  await view.render(activityWith({ ...note, status: "pending_prompt" }));
  expect(pending()?.getAttribute("aria-busy")).toBe("true");
  expect(pending()?.querySelector("header")?.textContent).toBe("CoordinatorQueued");
  expect(pending()?.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(view.container.textContent).toContain("First reply");
  expect(view.container.textContent).toContain("Please continue");

  await view.render(activityWith({ ...note, status: "prompted" }));
  expect(pending()?.getAttribute("data-task-turn-pending")).toBe("prompted");
  expect(pending()?.querySelector("header")?.textContent).toBe("CoordinatorWorking");
  expect(pending()?.querySelector('[data-slot="spinner"]')).not.toBeNull();

  await view.render(activityWith({ ...note, status: "completed", completedAt: "2026-09-08T00:01:07.000Z", result: JSON.stringify({ text: "Second reply" }) }));
  expect(pending()).toBeNull();
  expect(view.container.textContent).toContain("Second reply");
  expect(view.container.textContent).toContain("Turn took 7s");
});

test("a delivered task with no messages shows the default hint", async () => {
  const view = mount({ ...task, status: "delivered" });
  await view.render({ sessions: [], turns: [], shellPaneId: null });
  expect(view.container.textContent).not.toContain("resume this task");
  expect(view.container.textContent).toContain("Coordinator replies will appear here.");
});
