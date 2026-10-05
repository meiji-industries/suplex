// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, focusManager, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Task } from "../src/frontend/contracts/tasks.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);
vi.mock("../src/frontend/shell/company-context.js", () => ({ useOptionalCompanyContext: () => undefined, useCompanyContext: () => ({ user: { id: "user" }, currentCompany: { id: "company-1" } }) }));
vi.mock("../src/frontend/components/app/developer-diff.js", () => ({ DeveloperDiff: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));

import { TaskWork, type TaskActivity } from "../src/frontend/features/tasks/task-work.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const task = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title: "Show the diff count", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "diff-count", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: { path: "/worktrees/diff-count", branch: "diff-count", baseSha: "a".repeat(40), headSha: "b".repeat(40), dirty: true }, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
  dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
} satisfies Task;

const activity = { sessions: [], turns: [], shellPaneId: null } satisfies TaskActivity;

function serve(summary: { available: boolean; files: number } | Error) {
  api.readJsonUnchecked.mockImplementation(async (url: string) => {
    if (typeof url !== "string") return {};
    if (url.endsWith("/diff/summary")) {
      if (summary instanceof Error) throw summary;
      return summary;
    }
    if (url.endsWith("/execution")) return { sessions: [] };
    if (url.endsWith("/timeline")) return { tasks: [], unavailableSessions: 0 };
    throw new Error(`Unexpected request: ${url}`);
  });
}

const cleanups: Array<() => void> = [];

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = { container, root, client, render: async (nextTask: Task = task) => { await act(async () => { root.render(<QueryClientProvider client={client}><TaskWork task={nextTask} activity={activity} onChange={() => {}} /></QueryClientProvider>); await Promise.resolve(); }); } };
  cleanups.push(() => { root.unmount(); client.clear(); container.remove(); });
  return view;
}

function diffsTab(container: HTMLElement) {
  const value = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]')).find(candidate => candidate.textContent?.startsWith("Diffs"));
  if (!value) throw new Error("Diffs tab trigger was not rendered");
  return value;
}

afterEach(async () => {
  await act(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  focusManager.setFocused(undefined);
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
  vi.useRealTimers();
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJsonUnchecked.mockReset();
  notifyManager.setScheduler(queueMicrotask);
  focusManager.setFocused(true);
});

test("the Diffs tab shows the changed-file count on any active tab without reading the patch", async () => {
  serve({ available: true, files: 2 });
  const view = mount();
  await view.render();
  expect(diffsTab(view.container).textContent).toBe("Diffs (2)");
  expect(view.container.querySelector('[data-task-work-tabs] [data-slot="tabs-trigger"]')?.textContent).toBe("Chat");
  expect(api.readJsonUnchecked).toHaveBeenCalledWith("/api/tasks/task-1/diff/summary", { signal: expect.any(AbortSignal) });
  expect(api.readJsonUnchecked.mock.calls.some(([url]) => url === "/api/tasks/task-1/diff")).toBe(false);
});

test("the Diffs tab shows no count when the worktree is not available", async () => {
  serve({ available: false, files: 0 });
  const view = mount();
  await view.render();
  expect(diffsTab(view.container).textContent).toBe("Diffs");
});

test("a failed summary read leaves the Diffs label without a count", async () => {
  serve(new Error("The worktree diff could not be read"));
  const view = mount();
  await view.render();
  expect(diffsTab(view.container).textContent).toBe("Diffs");
});

test("the conversation has unique child keys and resets its draft on task change", async () => {
  serve({ available: true, files: 2 });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = mount();
  try {
    await view.render();
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Coordinator"]');
    if (!field) throw new Error("Message Coordinator textarea was not rendered");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "Keep this draft");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await view.render();
    expect(field.value).toBe("Keep this draft");
    await view.render({ ...task, id: "task-2" });
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Coordinator"]')?.value).toBe("");
    expect(errors.mock.calls.filter(([message]) => typeof message === "string" && message.includes("Encountered two children with the same key"))).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});

test("full patches load only while Diffs is selected and task updates invalidate both diff reads", async () => {
  vi.useFakeTimers();
  serve({ available: true, files: 2 });
  const original = api.readJsonUnchecked.getMockImplementation();
  api.readJsonUnchecked.mockImplementation((url: string, options?: RequestInit) => url.endsWith("/diff") ? Promise.resolve({ available: true, patch: "Current patch", truncated: false }) : original?.(url, options));
  const view = mount();
  await view.render();
  const reads = (path: string) => api.readJsonUnchecked.mock.calls.filter(([url]) => url.endsWith(path)).length;
  expect(reads("/diff")).toBe(0);
  await act(async () => diffsTab(view.container).click());
  expect(reads("/diff")).toBe(1);
  expect(view.container.textContent).toContain("Current patch");
  await view.render({ ...task, updatedAt: "2026-09-08T00:01:00.000Z" });
  expect([reads("/diff/summary"), reads("/diff")]).toEqual([2, 2]);
  await act(async () => focusManager.setFocused(false));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect([reads("/diff/summary"), reads("/diff")]).toEqual([2, 2]);
  await act(async () => focusManager.setFocused(true));
  expect([reads("/diff/summary"), reads("/diff")]).toEqual([3, 3]);
  const chat = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-slot="tabs-trigger"]')).find(button => button.textContent === "Chat");
  await act(async () => chat?.click());
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(reads("/diff")).toBe(3);
  expect(reads("/diff/summary")).toBe(5);
});

test("a task update cancels a slow initial diff summary before showing its replacement", async () => {
  serve({ available: true, files: 2 });
  const original = api.readJsonUnchecked.getMockImplementation();
  const pending: Array<{ signal: AbortSignal | null | undefined; resolve: (value: { available: boolean; files: number }) => void }> = [];
  api.readJsonUnchecked.mockImplementation((url: string, options?: RequestInit) => url.endsWith("/diff/summary") ? new Promise(resolve => pending.push({ signal: options?.signal, resolve })) : original?.(url, options));
  const view = mount();
  await view.render();
  await view.render({ ...task, updatedAt: "2026-09-08T00:01:00.000Z" });
  expect(pending[0]?.signal?.aborted).toBe(true);
  await act(async () => pending[1]?.resolve({ available: true, files: 4 }));
  await act(async () => pending[0]?.resolve({ available: true, files: 1 }));
  expect(diffsTab(view.container).textContent).toBe("Diffs (4)");
});
