// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const company = { id: "company-1", name: "Acme", issueCode: "ACME", status: "active" };
const fixture = vi.hoisted(() => ({ currentCompany: undefined as typeof company | undefined }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useOptionalCompanyContext: () => ({ currentCompany: fixture.currentCompany }) }));
vi.mock("../src/frontend/features/tasks/new-task-dialog.js", () => ({ NewTaskDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">New task opened</div> : null }));

import { GlobalNewTaskDialog } from "../src/frontend/shell/global-new-task-dialog.js";

afterEach(() => {
  fixture.currentCompany = undefined;
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
});

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => root.render(<StrictMode><GlobalNewTaskDialog /></StrictMode>));
  const dialogs = () => container.querySelectorAll('[role="dialog"]').length;
  return { root, render, dialogs };
}

test("Today opens the requested dialog once after the company loads", async () => {
  window.history.replaceState({}, "", "/today?new-task=1");
  const first = mount();
  await first.render();
  expect(first.dialogs()).toBe(0);
  expect(window.location.search).toContain("new-task=1");

  fixture.currentCompany = company;
  await first.render();
  expect(first.dialogs()).toBe(1);
  expect(`${window.location.pathname}${window.location.search}`).toBe("/today");
  await act(async () => first.root.unmount());

  const refreshed = mount();
  await refreshed.render();
  expect(refreshed.dialogs()).toBe(0);
  await act(async () => refreshed.root.unmount());
});

test("the Today fallback to the task list keeps the request", async () => {
  window.history.replaceState({}, "", "/today?new-task=1");
  const view = mount();
  await view.render();
  window.history.replaceState({}, "", "/tasks?new-task=1");

  fixture.currentCompany = company;
  await view.render();
  expect(view.dialogs()).toBe(1);
  expect(`${window.location.pathname}${window.location.search}`).toBe("/tasks");
  await act(async () => view.root.unmount());
});

test("Today without the request does not open the dialog", async () => {
  fixture.currentCompany = company;
  window.history.replaceState({}, "", "/today");
  const view = mount();
  await view.render();
  expect(view.dialogs()).toBe(0);
  await act(async () => view.root.unmount());
});
