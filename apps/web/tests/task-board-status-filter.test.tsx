/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://suplex.test/board?company=company-1" }
 */
import { act, createContext, useContext, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { ServerStateProvider } from "../shell/server-state.js";
import { TaskDataProvider } from "../features/tasks/task-data.js";

import type { Task } from "../contracts/tasks.js";

const api = vi.hoisted(() => ({ company: { id: "company-1", status: "active", plan: "pro" }, user: { id: "user-1", role: "admin" }, readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), ...api }));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ user: api.user, currentCompany: api.company }), useOptionalCompanyContext: () => ({ avatars: {} }) }));
vi.mock("../shell/application-frame.js", () => ({ ApplicationFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../shell/global-new-task-dialog.js", () => ({ requestNewTask: vi.fn(), useHasProjects: () => true }));
vi.mock("../features/analytics/lib/analytics.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), useTaskCosts: () => new Map() }));
vi.mock("../features/tasks/task-details.js", () => ({ TaskDetailsPage: ({ task }: { task: Task }) => <h2>{task.title}</h2> }));
vi.mock("../features/tasks/task-options.js", () => ({ TaskOptions: () => null }));
const sync = vi.hoisted(() => ({ emit: (_message: unknown): void => undefined }));
vi.mock("../features/tasks/lib/task-sync-api.js", () => ({ openTaskSync: (_companyId: string, onMessage: (message: unknown) => void) => { sync.emit = onMessage; return { close: () => undefined, watch: () => undefined }; } }));
vi.mock("../components/ui/select.js", () => {
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

import { TasksView } from "../features/tasks/tasks.js";

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
function task(id: string, title: string, status: Task["status"]): Task {
  return {
    id, companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title, description: "", status, deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: id, baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
    dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
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
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks: path.endsWith("/task-costs") ? [] : tasks });
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

test("Free with 3 running tasks shows the plan limit card at the top of Active, and Pro does not", async () => {
  const tasks = [task("task-1", "One", "active"), task("task-2", "Two", "active"), task("task-3", "Three", "waiting_human"), task("task-4", "Four", "queued"), task("task-5", "Five", "queued")];
  for (const queued of tasks.filter(task => task.status === "queued")) queued.queue.planConcurrencyLimited = true;
  tasks.push(
    { ...task("task-6", "Project-limited", "queued"), queue: { planConcurrencyLimited: true, projectConcurrencyLimited: true, waitingOn: [] } },
    { ...task("task-7", "Dependency-blocked", "queued"), queue: { planConcurrencyLimited: true, projectConcurrencyLimited: false, waitingOn: [{ kind: "task", id: "task-1", title: "One", status: "active", deliveryTarget: "pull_request_draft", reason: "prerequisite_running", summary: "One is running." }] } },
  );
  api.readJsonUnchecked.mockImplementation(async (path: string) => path === "/api/billing" ? { trialAvailable: true } : path.includes("/projects") ? { projects: [] } : { tasks: path.endsWith("/task-costs") ? [] : tasks });
  const render = async (plan: string): Promise<string | null | undefined> => {
    api.company.plan = plan;
    window.history.replaceState(null, "", "/board?company=company-1");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>); });
    await vi.waitFor(() => expect(container.querySelector('section[aria-label="Active"]')).not.toBeNull());
    await act(async () => {});
    const first = container.querySelector('section[aria-label="Active"] ul')?.firstElementChild;
    const text = first?.querySelector("[data-plan-limit-card]") ? first.textContent : null;
    const href = first?.querySelector("a")?.getAttribute("href");
    await act(async () => root.unmount());
    container.remove();
    return text && `${text} -> ${href}`;
  };
  try {
    expect(await render("free")).toBe("2 tasks are ready. 3 slots are full.Free runs 3 tasks at a time. Pro runs the full queue at the same time.Start all 2 with a free trialNo credit card is necessary. -> /billing?company=company-1");
    expect(await render("pro")).toBeNull();
    for (const queued of tasks.filter(task => task.id === "task-4" || task.id === "task-5")) queued.queue.planConcurrencyLimited = false;
    expect(await render("free")).toBeNull();
  } finally { api.company.plan = "pro"; }
});

test("board cards render the project avatar and preserve the repository fallback", async () => {
  const tasks = [task("task-1", "Repair the poller", "active"), { ...task("task-2", "Repair the fallback", "backlog"), projectId: "missing-project" }];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [{ id: "project-1", name: "Suplex" }] } : { tasks: path.endsWith("/task-costs") ? [] : tasks });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>); });
    const projectCard = Array.from(container.querySelectorAll("a")).find(card => card.textContent?.includes("Repair the poller"));
    expect(projectCard?.querySelector('[data-slot="avatar"][data-size="xs"]')).not.toBeNull();
    expect(container.textContent).toContain("Suplex");
    expect(container.textContent).toContain("meiji-industries/suplex");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("board cards label every Blocked by task and list rows omit it", async () => {
  const blocked = { ...task("task-3", "Ship the release", "backlog"), dependsOn: ["task-1", "task-2"], blockedBy: [{ id: "task-1", title: "Repair the poller", status: "active" as const }, { id: "task-2", title: "Plan the migration", status: "delivered" as const }] };
  const tasks = [task("task-1", "Repair the poller", "active"), blocked];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks: path.endsWith("/task-costs") ? [] : tasks });
  for (const mode of ["board", "list"] as const) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<ServerStateProvider><TaskDataProvider><TasksView mode={mode} /></TaskDataProvider></ServerStateProvider>); });
    expect(Array.from(container.querySelectorAll("[data-task-blocked-by]")).map(label => label.textContent)).toEqual(mode === "board" ? ["Blocked by Repair the poller · Active, Plan the migration · Delivered"] : []);
    await act(async () => { root.unmount(); container.remove(); });
  }
});

test("with the sync socket, the archived list reads again only when a task leaves or enters the active list", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/tasks?company=company-1");
  const active = [task("task-1", "Repair the poller", "active"), task("task-2", "Plan the migration", "backlog")];
  api.readJsonUnchecked.mockClear();
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks: path.endsWith("/task-costs") ? [] : path.includes("archived=true") ? [task("task-9", "Old work", "delivered")] : active });
  const archivedReads = () => api.readJsonUnchecked.mock.calls.filter(([path]) => String(path).includes("archived=true")).length;
  const emit = (message: unknown) => act(async () => sync.emit(message));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="list" /></TaskDataProvider></ServerStateProvider>));
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(tab => tab.textContent === "Archived")?.click());
    expect(container.textContent).toContain("Old work");
    expect(archivedReads()).toBe(1);
    await emit({ type: "snapshot", tasks: active, moves: [], costs: [] });
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(archivedReads()).toBe(1);
    await emit({ type: "changes", tasks: [{ ...active[0], title: "Renamed" }], removedTaskIds: [] });
    expect(archivedReads()).toBe(1);
    await emit({ type: "changes", tasks: [], removedTaskIds: ["task-2"] });
    expect(archivedReads()).toBe(2);
    await emit({ type: "changes", tasks: [active[1]], removedTaskIds: [] });
    expect(archivedReads()).toBe(3);
  } finally { await act(async () => root.unmount()); container.remove(); window.history.replaceState(null, "", "/board?company=company-1"); }
});

test("the open task page reads its task once and shows the pushed task", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/tasks/task-1?company=company-1");
  api.readJsonUnchecked.mockClear();
  api.readJsonUnchecked.mockImplementation(async (path: string) => path === "/api/tasks/task-1" ? task("task-1", "Read task", "active") : path.includes("/projects") ? { projects: [] } : { tasks: [] });
  const taskReads = () => api.readJsonUnchecked.mock.calls.filter(([path]) => path === "/api/tasks/task-1").length;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="list" /></TaskDataProvider></ServerStateProvider>));
    expect(container.querySelector("h2")?.textContent).toBe("Read task");
    await act(async () => sync.emit({ type: "snapshot", tasks: [], moves: [], costs: [] }));
    await act(async () => sync.emit({ type: "openTask", taskId: "task-1", task: { ...task("task-1", "Pushed task", "active"), updatedAt: "2026-09-09T00:00:00.000Z" } }));
    expect(container.querySelector("h2")?.textContent).toBe("Pushed task");
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(taskReads()).toBe(1);
  } finally { await act(async () => root.unmount()); container.remove(); window.history.replaceState(null, "", "/board?company=company-1"); }
});

test("board durations use the timeline span, tick for Active, freeze for Delivered, and omit other statuses", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:20.000Z"));
  window.history.replaceState(null, "", "/board?company=company-1");
  const tasks = [{ ...task("active", "Live task", "active"), pullRequest: { repository: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1", headSha: "a".repeat(40), state: "ready", mergedAt: null }, startedAt: "2026-09-08T00:00:00.000Z" }, { ...task("delivered", "Done task", "delivered"), startedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:15.000Z" }, task("backlog", "Future task", "backlog")];
  api.readJsonUnchecked.mockClear();
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.endsWith("/projects") ? { projects: [{ id: "project-1", name: "Suplex" }] } : { tasks: path.endsWith("/task-costs") ? [] : tasks });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>));
    const duration = (id: string) => container.querySelector(`a[href="/board/${id}"] [data-task-duration]`)?.textContent;
    expect(duration("active")).toBe("20s");
    expect(duration("delivered")).toBe("15s");
    expect(duration("backlog")).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(duration("active")).toBe("22s");
    expect(duration("delivered")).toBe("15s");
    expect(api.readJsonUnchecked.mock.calls.filter(([path]) => /\/(timeline|checks)$/.test(String(path)))).toEqual([]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

function dragEvent(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: () => undefined, effectAllowed: "", dropEffect: "" } });
  return event;
}

test("a dropped card sends one command for a permitted column and the server status moves it", async () => {
  window.history.replaceState(null, "", "/board?company=company-1&boardStatus=queued");
  const queued = task("task-1", "Ship after review", "queued");
  let release: (value: Task) => void = () => undefined;
  api.readJsonUnchecked.mockClear();
  api.readJsonUnchecked.mockImplementation((path: string) => path === "/api/tasks/task-1/force-start" ? new Promise<Task>(resolve => { release = resolve; }) : Promise.resolve(path.includes("/projects") ? { projects: [] } : { tasks: path.endsWith("/task-costs") ? [] : [queued, task("task-2", "Plan the migration", "backlog")] }));
  const commands = () => api.readJsonUnchecked.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([path]) => path);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const columns = () => Array.from(container.querySelectorAll("section")).map(section => section.getAttribute("aria-label"));
  const column = (label: string) => container.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
  try {
    await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>));
    expect(columns()).toEqual(["Queued"]);
    const card = () => container.querySelector<HTMLAnchorElement>('a[href="/board/task-1"]');
    await act(async () => { card()?.dispatchEvent(dragEvent("dragstart")); });
    // The filter keeps its value, and the permitted destinations show while you drag.
    expect(columns()).toEqual(["Backlog", "Queued", "Active"]);
    // The lifted copy follows the pointer, and the slot stays as a faint outline.
    const overlay = () => document.querySelector("[data-board-drag-overlay]");
    expect(overlay()?.textContent).toContain("Ship after review");
    expect(card()?.closest("li")?.className).toContain("opacity-30");
    expect(column("Active")?.textContent).toContain("Move the task here");
    expect(column("Backlog")?.textContent).not.toContain("Plan the migration");
    const over = (label: string) => { const event = dragEvent("dragover"); column(label)?.dispatchEvent(event); return event.defaultPrevented; };
    expect([over("Active"), over("Backlog"), over("Queued")]).toEqual([true, true, false]);
    await act(async () => { column("Queued")?.dispatchEvent(dragEvent("drop")); });
    expect(commands()).toEqual([]);
    await act(async () => { column("Active")?.dispatchEvent(dragEvent("drop")); });
    expect(commands()).toEqual(["/api/tasks/task-1/force-start"]);
    expect(columns()).toEqual(["Queued"]);
    expect(container.querySelector('li[aria-busy="true"]')?.textContent).toContain("Ship after review");
    // The card waits on the column until the board shows the new status.
    expect(overlay()).not.toBeNull();
    // A second move on a pending card sends nothing.
    await act(async () => { card()?.dispatchEvent(dragEvent("dragstart")); });
    await act(async () => { column("Backlog")?.dispatchEvent(dragEvent("drop")); });
    expect(commands()).toEqual(["/api/tasks/task-1/force-start"]);
    await act(async () => { card()?.dispatchEvent(dragEvent("dragend")); release({ ...queued, status: "active", updatedAt: "2026-09-09T00:00:00.000Z" }); });
    await act(async () => {});
    expect(container.querySelector('li[aria-busy="true"]')).toBeNull();
    expect(column("Queued")).toBeNull();
    expect(overlay()).toBeNull();
    expect(container.querySelector("li.opacity-30")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); window.history.replaceState(null, "", "/board?company=company-1"); }
});

test("only cards with a permitted move get the Task moves menu and drag", async () => {
  const tasks = [task("task-1", "Plan the migration", "backlog"), task("task-2", "Wait for you", "waiting_human"), { ...task("task-3", "Done work", "delivered"), statusChangedAt: new Date().toISOString() }, { ...task("task-4", "Old backlog", "backlog"), archivedAt: "2026-09-08T00:00:00.000Z" }];
  api.readJsonUnchecked.mockImplementation(async (path: string) => path.includes("/projects") ? { projects: [] } : { tasks: path.endsWith("/task-costs") ? [] : tasks });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>));
    const card = (id: string) => container.querySelector(`a[href="/board/${id}"]`)?.closest("li");
    expect(["task-1", "task-2", "task-3", "task-4"].map(id => [Boolean(card(id)?.querySelector('[aria-label="Task moves"]')), card(id)?.querySelector("a")?.getAttribute("draggable")])).toEqual([[true, null], [false, "false"], [false, "false"], [false, "false"]]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
