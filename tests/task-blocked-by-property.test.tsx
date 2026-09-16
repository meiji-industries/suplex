// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../src/tasks/contracts.js";

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

const self = { id: "task-self", projectId: "project-1", title: "This task", status: "active", archivedAt: null };
const active = { id: "task-active", projectId: "project-1", title: "Active prerequisite", status: "active", archivedAt: null };
const backlog = { id: "task-backlog", projectId: "project-1", title: "Backlog task", status: "backlog", archivedAt: null };
const delivered = { id: "task-delivered", projectId: "project-1", title: "Delivered task", status: "delivered", archivedAt: null };
const otherProject = { id: "task-other-project", projectId: "project-2", title: "Other project", status: "active", archivedAt: null };

const activeTask: Pick<Task, "id" | "companyId" | "projectId" | "status" | "blockedBy"> = { id: "task-self", companyId: "company-1", projectId: "project-1", status: "active", blockedBy: null };

function mount(task = activeTask, save = vi.fn<(blockedByTaskId: string | null) => Promise<void>>().mockResolvedValue(undefined)) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root, save, render: async () => { await act(async () => { root.render(<dl><TaskBlockedByProperty task={task} save={save} /></dl>); }); } };
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
    if (url === "/api/companies/company-1/tasks") return { tasks: [self, active, backlog, delivered, otherProject] };
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

test("None opens the picker and selecting a task saves its id", async () => {
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
  expect(view.save).toHaveBeenCalledWith("task-active");
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
});

test("the current reference opens the picker, links to its task, and saves a replacement", async () => {
  const view = mount({ ...activeTask, blockedBy: { id: "task-first", title: "First prerequisite", status: "backlog" } });
  await view.render();
  await act(async () => { button(view.container, "First prerequisite").click(); });
  await flush();
  expect(view.container.querySelector('[aria-label="Search tasks"]')).not.toBeNull();
  expect(view.container.querySelector('a[href="/tasks/task-first?company=company-1"]')?.textContent).toContain("First prerequisite");
  expect(view.container.textContent).not.toContain("This task");
  await act(async () => { button(view.container, "Backlog task").click(); await Promise.resolve(); });
  expect(view.save).toHaveBeenCalledWith("task-backlog");
});

test("Clear in the picker clears the current Blocked by reference", async () => {
  const view = mount({ ...activeTask, blockedBy: { id: "task-first", title: "First prerequisite", status: "backlog" } });
  await view.render();
  await act(async () => { button(view.container, "First prerequisite").click(); });
  await flush();
  await act(async () => { button(view.container, "Clear").click(); await Promise.resolve(); });
  expect(view.save).toHaveBeenCalledWith(null);
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
});

test("closing the picker leaves the current reference unchanged", async () => {
  const view = mount({ ...activeTask, blockedBy: { id: "task-first", title: "First prerequisite", status: "backlog" } });
  await view.render();
  await act(async () => { button(view.container, "First prerequisite").click(); });
  await flush();
  await act(async () => { button(view.container, "Close").click(); });
  expect(view.save).not.toHaveBeenCalled();
  expect(view.container.querySelector('[aria-label="Search tasks"]')).toBeNull();
  expect(view.container.textContent).toContain("First prerequisite");
});

test("a failed save shows the error message", async () => {
  const view = mount(activeTask, vi.fn().mockRejectedValue(new Error("Reference is not available")));
  await view.render();
  await act(async () => { button(view.container, "None").click(); });
  await flush();
  await act(async () => { button(view.container, "Active prerequisite").click(); await Promise.resolve(); });
  expect(view.save).toHaveBeenCalledWith("task-active");
  expect(view.container.textContent).toContain("Reference is not available");
});
