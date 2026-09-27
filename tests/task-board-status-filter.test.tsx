/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://suplex.test/board?company=company-1" }
 */
import { act, createContext, useContext, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { ServerStateProvider } from "../src/frontend/shell/server-state.js";
import { TaskDataProvider } from "../src/frontend/features/tasks/task-data.js";

import type { Task } from "../src/frontend/contracts/tasks.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../src/frontend/lib/api.js", () => api);
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ user: { id: "user-1" }, currentCompany: { id: "company-1", status: "active" } }) }));
vi.mock("../src/frontend/shell/application-frame.js", () => ({ ApplicationFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/frontend/shell/global-new-task-dialog.js", () => ({ requestNewTask: vi.fn() }));
vi.mock("../src/frontend/features/analytics/lib/analytics.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), useTaskCosts: () => new Map() }));
vi.mock("../src/frontend/features/tasks/task-details.js", () => ({ TaskDetailsPage: () => null }));
vi.mock("../src/frontend/features/tasks/task-options.js", () => ({ TaskOptions: () => null }));
vi.mock("../src/frontend/components/ui/select.js", () => {
  const context = createContext<{ value?: string | undefined; onValueChange?: ((value: string) => void) | undefined; label: { current: string } }>({ label: { current: "" } });
  return {
    Select: ({ value, onValueChange, children }: { value?: string | undefined; onValueChange?: (value: string) => void; children: ReactNode }) => {
      const label = useRef("");
      return <context.Provider value={{ value, onValueChange, label }}>{children}</context.Provider>;
    },
    SelectTrigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => {
      const { label } = useContext(context);
      label.current = props["aria-label"] ?? "";
      return <div {...props}>{children}</div>;
    },
    SelectValue: ({ children }: { children?: ReactNode | ((value: string) => ReactNode) }) => {
      const { value } = useContext(context);
      return typeof children === "function" ? children(value ?? "") : children;
    },
    SelectContent: ({ children }: { children: ReactNode }) => children,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange, label } = useContext(context);
      return <button type="button" data-select={label.current} data-value={value} onClick={() => onValueChange?.(value)}>{children}</button>;
    },
  };
});

import { TasksView } from "../src/frontend/features/tasks/tasks.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
function task(id: string, title: string, status: Task["status"]): Task {
  return {
    id, companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title, description: "", status, deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: id, baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
    dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
  };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
});
afterEach(async () => {
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
  vi.useRealTimers();
  vi.restoreAllMocks();
  await act(async () => { document.body.replaceChildren(); });
});

test.each(["visible", "hidden"] as const)("a %s initial load fetches once, hidden intervals stop, and visible intervals resume", async initialVisibility => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue(initialVisibility);
  api.readJsonUnchecked.mockClear();
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [] } : { tasks: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="list" /></TaskDataProvider></ServerStateProvider>));
    const projectReads = () => api.readJsonUnchecked.mock.calls.filter(([path]) => path.endsWith("/projects")).length;
    expect(projectReads()).toBe(1);
    visibility.mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(projectReads()).toBe(1);
    visibility.mockReturnValue("visible");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(projectReads()).toBe(2);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("the board keeps queued and backlog tasks in separate columns and filters", async () => {
  const tasks = [task("task-1", "Repair the poller", "active"), task("task-2", "Plan the migration", "backlog"), task("task-3", "Ship after review", "queued")];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>); });

  const trigger = () => container.querySelector<HTMLElement>('[aria-label="Filter by status"]');
  const iconThenLabel = () => [trigger()?.firstElementChild?.tagName.toLowerCase(), trigger()?.textContent];
  const columns = () => Array.from(container.querySelectorAll("section")).map(section => section.getAttribute("aria-label"));
  expect(iconThenLabel()).toEqual(["svg", "All statuses"]);
  expect(columns()).toEqual(["Backlog", "Queued", "Active"]);
  expect(container.textContent).toContain("Plan the migration");

  const option = container.querySelector<HTMLButtonElement>('[data-select="Filter by status"][data-value="active"]');
  expect(option).not.toBeNull();
  await act(async () => { option?.click(); });

  expect(columns()).toEqual(["Active"]);
  expect(iconThenLabel()).toEqual(["svg", "Active"]);
  expect(container.textContent).toContain("Repair the poller");
  expect(container.textContent).not.toContain("Plan the migration");

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-select="Filter by status"][data-value="all"]')?.click(); });
  expect(columns()).toEqual(["Backlog", "Queued", "Active"]);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-select="Filter by status"][data-value="queued"]')?.click(); });
  expect(columns()).toEqual(["Queued"]);
  expect(container.textContent).toContain("Ship after review");
  expect(container.textContent).not.toContain("Plan the migration");
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-select="Filter by status"][data-value="all"]')?.click(); });
  const backlogTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(tab => tab.textContent === "Backlog");
  await act(async () => { backlogTab?.click(); });
  expect(columns()).toEqual(["Backlog"]);
  expect(container.textContent).not.toContain("Ship after review");
  await act(async () => root.unmount());
});

test("board cards label every Blocked by task and list rows omit it", async () => {
  const blocked = { ...task("task-3", "Ship the release", "backlog"), dependsOn: ["task-1", "task-2"], blockedBy: [{ id: "task-1", title: "Repair the poller", status: "active" as const }, { id: "task-2", title: "Plan the migration", status: "delivered" as const }] };
  const tasks = [task("task-1", "Repair the poller", "active"), blocked];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks });
  for (const mode of ["board", "list"] as const) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<ServerStateProvider><TaskDataProvider><TasksView mode={mode} /></TaskDataProvider></ServerStateProvider>); });
    expect(Array.from(container.querySelectorAll("[data-task-blocked-by]")).map(label => label.textContent)).toEqual(mode === "board" ? ["Blocked by Repair the poller · Active, Plan the migration · Delivered"] : []);
    await act(async () => { root.unmount(); container.remove(); });
  }
});
