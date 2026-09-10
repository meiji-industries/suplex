// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Task } from "../src/tasks/contracts.js";
import { TaskBlockedByProperty } from "../src/frontend/features/tasks/task-details.js";

const activeTask: Pick<Task, "companyId" | "status" | "blockedBy"> = { companyId: "company-1", status: "active", blockedBy: null };

function mount(task = activeTask, save = vi.fn<(blockedByTaskId: string | null) => Promise<void>>().mockResolvedValue(undefined)) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root, save, render: async () => { await act(async () => { root.render(<dl><TaskBlockedByProperty task={task} save={save} /></dl>); }); } };
}

function button(container: HTMLElement, name: string) {
  const value = Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent === name);
  if (!value) throw new Error(`Button not found: ${name}`);
  return value;
}

function input(container: HTMLElement) {
  const value = container.querySelector<HTMLInputElement>('input[aria-label="Blocked by reference task ID"]');
  if (!value) throw new Error("Blocked by reference input was not rendered");
  return value;
}

function setText(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

test("an active task can set a Blocked by reference", async () => {
  const view = mount();
  await view.render();
  await act(async () => { button(view.container, "Add Blocked by reference").click(); });
  const field = input(view.container);
  await act(async () => { setText(field, "task-prerequisite"); field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(view.save).toHaveBeenCalledWith("task-prerequisite");
});

test("Change reference begins with the current reference and saves a replacement", async () => {
  const view = mount({ ...activeTask, blockedBy: { id: "task-first", title: "First prerequisite", status: "backlog" } });
  await view.render();
  await act(async () => { button(view.container, "Change reference").click(); });
  const field = input(view.container);
  expect(field.value).toBe("task-first");
  await act(async () => { setText(field, "task-second"); field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(view.save).toHaveBeenCalledWith("task-second");
});

test("Clear reference clears the current Blocked by reference", async () => {
  const view = mount({ ...activeTask, blockedBy: { id: "task-first", title: "First prerequisite", status: "backlog" } });
  await view.render();
  await act(async () => { button(view.container, "Clear reference").click(); await Promise.resolve(); });
  expect(view.save).toHaveBeenCalledWith(null);
});

test("Cancel leaves the current reference unchanged", async () => {
  const view = mount({ ...activeTask, blockedBy: { id: "task-first", title: "First prerequisite", status: "backlog" } });
  await view.render();
  await act(async () => { button(view.container, "Change reference").click(); });
  await act(async () => { button(view.container, "Cancel").click(); });
  expect(view.save).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("First prerequisite");
});

test("a failed save keeps the Blocked by reference value visible", async () => {
  const view = mount(activeTask, vi.fn().mockRejectedValue(new Error("Reference is not available")));
  await view.render();
  await act(async () => { button(view.container, "Add Blocked by reference").click(); });
  const field = input(view.container);
  await act(async () => { setText(field, "task-missing"); field.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(input(view.container).value).toBe("task-missing");
  expect(view.container.textContent).toContain("Reference is not available");
});
