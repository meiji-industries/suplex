// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../src/frontend/contracts/tasks.js";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), readJson: api.readJson }));

vi.mock("../src/frontend/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Context = React.createContext({ onOpenChange: (_open: boolean): void => undefined });
  return {
    Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) => open ? <Context.Provider value={{ onOpenChange }}>{children}</Context.Provider> : null,
    DialogContent: ({ children, showCloseButton = true }: { children: React.ReactNode; showCloseButton?: boolean }) => {
      const { onOpenChange } = React.useContext(Context);
      return <div>{children}{showCloseButton ? <button type="button" aria-label="Close" onClick={() => onOpenChange(false)}>Close</button> : null}</div>;
    },
    DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  };
});

import { TaskBlockedByProperty } from "../src/frontend/features/tasks/task-details.js";

const self = { id: "task-self", projectId: "project-1", title: "This task", status: "active", archivedAt: null, queue: { state: "running" } };
const active = { id: "task-active", projectId: "project-1", title: "Active prerequisite", status: "active", archivedAt: null, queue: { state: "running" } };
const backlog = { id: "task-backlog", projectId: "project-1", title: "Backlog task", status: "backlog", archivedAt: null, queue: { state: "backlog" } };
const queued = { id: "task-queued", projectId: "project-1", title: "Queued task", status: "queued", archivedAt: null, queue: { waitingOn: [] } };
const delivered = { id: "task-delivered", projectId: "project-1", title: "Delivered task", status: "delivered", archivedAt: null, queue: { state: "delivered" } };
const otherProject = { id: "task-other-project", projectId: "project-2", title: "Other project", status: "active", archivedAt: null, queue: { state: "running" } };

const activeTask: Pick<Task, "id" | "companyId" | "projectId" | "status" | "blockedBy"> = { id: "task-self", companyId: "company-1", projectId: "project-1", status: "active", blockedBy: [] };
const first = { id: "task-first", title: "First prerequisite", status: "backlog" as const };
const second = { id: "task-second", title: "Second prerequisite", status: "delivered" as const };

const saved = { id: "task-self", blockedBy: [] } as unknown as Task;

/** Every save goes through the canonical dependency route with the complete prerequisite set. */
function mount(task = activeTask) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn<(task: Task) => void>();
  const saves = () => api.readJson.mock.calls.filter(([url]) => url === "/api/tasks/task-self/dependencies").map(([, init]) => { expect(init.method).toBe("PUT"); return JSON.parse(init.body).dependsOn as string[]; });
  return { container, root, onChange, saves, render: async () => { await act(async () => { root.render(<dl><TaskBlockedByProperty task={task} onChange={onChange} /></dl>); }); } };
}

function button(container: HTMLElement, name: string) {
  const value = Array.from(container.querySelectorAll("button")).find(candidate => candidate.getAttribute("aria-label") === name || candidate.textContent?.includes(name));
  if (!value) throw new Error(`Button not found: ${name}`);
  return value;
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJson.mockReset();
  api.readJson.mockImplementation(async (url: string) => {
    if (url === "/api/tasks/task-self/dependencies") return saved;
    if (url === "/api/companies/company-1/tasks") return { tasks: [self, active, backlog, queued, delivered, otherProject, { ...first, projectId: "project-1", archivedAt: null, queue: { state: "backlog" } }] };
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

test("None opens the picker and selecting a task saves it as the only prerequisite", async () => {
  const view = mount();
  await view.render();
  await act(async () => { button(view.container, "None").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search tasks"]')).not.toBeNull();
  expect(view.container.textContent).toContain("Active prerequisite");
  expect(view.container.textContent).toContain("Backlog task");
  expect(view.container.textContent).not.toContain("Delivered task");
  expect(view.container.textContent).not.toContain("Other project");
  expect(view.container.textContent).not.toContain("This task");
  await act(async () => { button(view.container, "Active prerequisite").click(); await Promise.resolve(); });
  expect(view.saves()).toEqual([["task-active"]]);
  expect(view.onChange).toHaveBeenCalledWith(saved);
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
});

test("every prerequisite links to its task with its status", async () => {
  const queuedPrerequisite = { id: "task-queued", title: "Queued prerequisite", status: "queued" as const };
  const view = mount({ ...activeTask, blockedBy: [first, queuedPrerequisite, second] });
  await view.render();
  expect(view.container.querySelector('a[href="/tasks/task-first?company=company-1"]')?.getAttribute("title")).toBe("First prerequisite · Backlog");
  expect(view.container.querySelector('a[href="/tasks/task-queued?company=company-1"]')?.getAttribute("title")).toBe("Queued prerequisite · Queued");
  expect(view.container.querySelector('a[href="/tasks/task-second?company=company-1"]')?.getAttribute("title")).toBe("Second prerequisite · Delivered");
  expect(view.container.textContent).not.toContain("None");
});

test("the picker renders queued and manual backlog tasks with distinct icons", async () => {
  const view = mount();
  await view.render();
  await act(async () => { button(view.container, "None").click(); });
  await flush();
  const queuedButton = button(view.container, "Queued task");
  const backlogButton = button(view.container, "Backlog task");
  expect(queuedButton.innerHTML).toContain("text-sky-500");
  expect(backlogButton.innerHTML).toContain("text-muted-foreground");
});

test("Add saves the current prerequisites and the selected task, and hides tasks already listed", async () => {
  const view = mount({ ...activeTask, blockedBy: [first, second] });
  await view.render();
  await act(async () => { button(view.container, "Add Blocked by task").click(); });
  await flush();
  const picker = view.container.querySelector('[aria-label="Search tasks"]')!.parentElement!;
  expect(picker.textContent).not.toContain("First prerequisite");
  expect(picker.textContent).not.toContain("This task");
  await act(async () => { button(view.container, "Backlog task").click(); await Promise.resolve(); });
  expect(view.saves()).toEqual([["task-first", "task-second", "task-backlog"]]);
});

test("removing one prerequisite saves the others", async () => {
  const view = mount({ ...activeTask, blockedBy: [first, second] });
  await view.render();
  await act(async () => { button(view.container, "Remove First prerequisite from Blocked by").click(); await Promise.resolve(); });
  expect(view.saves()).toEqual([["task-second"]]);
});

test("closing the picker leaves the prerequisites unchanged", async () => {
  const view = mount({ ...activeTask, blockedBy: [first] });
  await view.render();
  await act(async () => { button(view.container, "Add Blocked by task").click(); });
  await flush();
  await act(async () => { button(view.container, "Close").click(); });
  expect(view.saves()).toEqual([]);
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
  expect(view.container.textContent).toContain("First prerequisite");
});

test("a failed save shows the error message", async () => {
  const view = mount();
  const listed = api.readJson.getMockImplementation()!;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => { if (url === "/api/tasks/task-self/dependencies") throw new Error("The dependency creates a cycle"); return listed(url, init); });
  await view.render();
  await act(async () => { button(view.container, "None").click(); });
  await flush();
  await act(async () => { button(view.container, "Active prerequisite").click(); await Promise.resolve(); });
  await flush();
  expect(view.saves()).toEqual([["task-active"]]);
  expect(view.onChange).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("The dependency creates a cycle");
});
