// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Task } from "../contracts/tasks.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));
vi.mock("../lib/api.js", () => api);
vi.mock("../shell/company-context.js", () => ({ useOptionalCompanyContext: () => undefined, useCompanyContext: () => ({ user: { id: "user" }, currentCompany: { id: "company-1" } }) }));

import { TaskWork, type TaskActivity } from "../features/tasks/task-work.js";
import { timeUntil } from "../features/tasks/dispatch-notice.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title: "Show progress", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "progress", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
  dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
} satisfies Task;

const session = { id: "session-1", kind: "root", advisorRole: null, label: "Coordinator", profileId: "profile", generation: 1, nativeSessionId: null, paneId: null, current: true, replacement: null, harness: "claude-code" } as const;
const done = { id: "turn-1", sessionId: "session-1", prompt: "Start", status: "completed", promptedAt: "2026-09-08T00:00:00.000Z", completedAt: "2026-09-08T00:00:05.000Z", result: JSON.stringify({ text: "First reply" }), assignment: null } as const;
const note = { id: "turn-2", sessionId: "session-1", prompt: "Human note:\nPlease continue", promptedAt: "2026-09-08T00:01:00.000Z", completedAt: null, result: null, assignment: null } as const;

function activityWith(turn: TaskActivity["turns"][number]): TaskActivity {
  return { sessions: [session], turns: [done, turn], setup: { state: "none", exitStatus: null }, actions: [], shellPaneId: null } satisfies TaskActivity;
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
  await view.render({ sessions: [], turns: [], setup: { state: "none", exitStatus: null }, actions: [], shellPaneId: null });
  expect(view.container.textContent).not.toContain("resume this task");
  expect(view.container.textContent).toContain("Coordinator replies will appear here.");
});

test("the conversation shows each Worker assignment once, with the plan, criteria, and instruction", async () => {
  const worker = { ...session, id: "worker-1", kind: "worker", label: "Worker" } as const;
  const checker = { ...session, id: "worker-2", kind: "worker", label: "Worker" } as const;
  const delegation = { ...done, id: "turn-3", sessionId: "worker-1", prompt: "Assignment", result: JSON.stringify({ text: "Built it" }), assignment: { mode: "planned", purpose: "implementation", plan: "## Steps\n\n1. **Add** the field", acceptanceCriteria: ["The field shows"], instruction: "Run the tests" } } satisfies TaskActivity["turns"][number];
  const continuation = { ...done, id: "turn-4", sessionId: "worker-1", prompt: "Fix the lint error", result: JSON.stringify({ text: "Fixed" }), assignment: null } satisfies TaskActivity["turns"][number];
  const check = { ...done, id: "turn-5", sessionId: "worker-2", prompt: "Check", result: null, assignment: { mode: "direct", purpose: "verification", plan: null, acceptanceCriteria: [], instruction: "Run pnpm check" } } satisfies TaskActivity["turns"][number];
  const view = mount();
  await view.render({ sessions: [session, worker, checker], turns: [done, delegation, continuation, check], setup: { state: "none", exitStatus: null }, actions: [], shellPaneId: null });

  const assignments = Array.from(view.container.querySelectorAll<HTMLElement>("[data-worker-assignment]"));
  expect(assignments.map(item => item.dataset.workerAssignment)).toEqual(["implementation", "verification"]);
  const [planned, verification] = assignments;
  expect(planned?.querySelector("header")?.textContent).toBe("CoordinatorAssignment for Worker");
  expect(planned?.querySelector('[aria-label="Plan"] h2')?.textContent).toBe("Steps");
  expect(planned?.querySelector('[aria-label="Plan"] strong')?.textContent).toBe("Add");
  expect(planned?.querySelector('[aria-label="Acceptance criteria"] li')?.textContent).toBe("The field shows");
  expect(planned?.querySelector('[aria-label="Instructions"]')?.textContent).toContain("Run the tests");
  expect(verification?.querySelector("header")?.textContent).toBe("CoordinatorAssignment for WorkerDirect buildCheck only");
  expect(verification?.querySelector('[aria-label="Plan"]')).toBeNull();
  // The plan precedes the Worker reply, and the continuation does not repeat it.
  const text = view.container.textContent ?? "";
  expect(text.indexOf("Steps")).toBeLessThan(text.indexOf("Built it"));
  expect(text.indexOf("Built it")).toBeLessThan(text.indexOf("Fixed"));
  expect(text.split("Steps").length).toBe(2);
});

test("the conversation shows a paired agent's note under the agent's name", async () => {
  const view = mount();
  await view.render(activityWith({ ...note, prompt: "Agent note (agent_1):\nSkip the tests", status: "completed", noteAgentName: "Hermes" }));
  const article = Array.from(view.container.querySelectorAll("article")).find(element => element.textContent?.includes("Skip the tests"));
  expect(article?.querySelector("header")?.textContent).toBe("HermesSent to Coordinator");
});

test("the Chat and Activity tabs show why the host has not dispatched the turn, with the next wake", async () => {
  const view = mount();
  const failure = { kind: "dispatch", agent: "coordinator", text: "Suplex could not start the Coordinator. OpenCode is not connected. Suplex tries again.", observedAt: "2026-09-08T00:01:00.000Z", nextWakeAt: null } as const;
  await view.render({ ...activityWith({ ...note, status: "pending_prompt" }), dispatchNotice: failure });
  const notices = () => Array.from(view.container.querySelectorAll<HTMLElement>("[data-dispatch-notice]"));
  // The notice follows the pending spinner in Chat; the inactive Activity panel is not rendered.
  const pending = view.container.querySelector("[data-task-turn-pending]");
  expect(notices()).toHaveLength(1);
  expect(pending?.nextElementSibling).toBe(notices()[0]!);
  expect(notices()[0]?.dataset.dispatchNotice).toBe("dispatch");
  expect(notices()[0]?.textContent).toBe(failure.text);
  expect(notices()[0]?.querySelector("time")).toBeNull();

  const nextWakeAt = new Date(Date.now() + 125_000).toISOString();
  const waiting = { kind: "idle_wait", agent: "coordinator", text: "The Coordinator is idle. Suplex waits 4 minutes between idle Coordinator wakes.", observedAt: "2026-09-08T00:02:00.000Z", nextWakeAt } as const;
  await view.render({ ...activityWith({ ...done, id: "turn-2" }), dispatchNotice: waiting });
  expect(view.container.querySelector("[data-task-turn-pending]")).toBeNull();
  expect(notices()[0]?.dataset.dispatchNotice).toBe("idle_wait");
  expect(notices()[0]?.textContent).toContain(waiting.text);
  const time = notices()[0]?.querySelector("time");
  expect(time?.getAttribute("dateTime")).toBe(nextWakeAt);
  expect(time?.textContent).toMatch(/^in 2m 0[45]s$/);

  await act(async () => { view.container.querySelector<HTMLElement>('[role="tab"]:nth-child(2)')?.click(); await Promise.resolve(); });
  const activityPanel = view.container.querySelector('[aria-label="Task activity"]');
  expect(activityPanel?.querySelector("[data-dispatch-notice]")?.textContent).toContain(waiting.text);

  await view.render(activityWith({ ...done, id: "turn-2" }));
  expect(notices()).toHaveLength(0);
});

test("timeUntil counts down to the next wake", () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  expect(timeUntil("2026-09-08T00:00:42.000Z", now)).toBe("in 42s");
  expect(timeUntil("2026-09-08T00:08:05.000Z", now)).toBe("in 8m 05s");
  expect(timeUntil("2026-09-07T23:59:00.000Z", now)).toBe("now");
});

test("each turn label shows the full local date and time on hover", async () => {
  const working = { ...note, status: "prompted", result: JSON.stringify({ text: "Partial reply" }) } satisfies TaskActivity["turns"][number];
  const queued = { ...note, id: "turn-3", status: "pending_prompt", promptedAt: null } satisfies TaskActivity["turns"][number];
  const view = mount();
  await view.render({ sessions: [session], turns: [done, working, queued], setup: { state: "none", exitStatus: null }, actions: [], shellPaneId: null });
  const expectTimes = (scope: Element, labels: string[]) => {
    const times = Array.from(scope.querySelectorAll("time"));
    expect(times.map(time => [time.dateTime, time.title, time.textContent])).toEqual([
      [done.completedAt, new Date(done.completedAt).toLocaleString(), labels[0]],
      [working.promptedAt, new Date(working.promptedAt).toLocaleString(), labels[1]],
    ]);
  };

  const conversation = view.container.querySelector('[aria-label="Conversation"]')!;
  expectTimes(conversation, ["Turn took 5s", "In progress"]);
  expect(Array.from(conversation.querySelectorAll("article header")).map(header => header.textContent)).toContain("CoordinatorTurn took 5s");

  const activityTab = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-slot="tabs-trigger"]')).find(button => button.textContent?.startsWith("Activity"));
  await act(async () => activityTab?.click());
  const rows = view.container.querySelector('[aria-label="Task activity"]')!;
  expectTimes(rows, ["Turn took 5s", "In progress"]);
  expect(Array.from(rows.children).slice(0, 3).map(row => row.textContent)).toEqual(["CoordinatorTurn took 5s", "CoordinatorIn progress", "CoordinatorQueued"]);
});
