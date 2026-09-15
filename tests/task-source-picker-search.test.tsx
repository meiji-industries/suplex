// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);

import { TaskSourcePicker } from "../src/frontend/features/tasks/task-source-picker.js";

function setText(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJson.mockResolvedValue({ available: true, sources: [
    { kind: "pull_request", number: 42, title: "Fix picker search", body: "", author: "octo", headBranch: "fix/search", baseBranch: "main", isDraft: false },
    { kind: "pull_request", number: 17, title: "Improve task creation", body: "", author: "hubot", headBranch: "feature/tasks", baseBranch: "main", isDraft: false },
  ] });
});

afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); vi.unstubAllGlobals(); });

test("task source search accepts keyboard input without menu typeahead taking focus", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  act(() => { root.render(<TaskSourcePicker projectId="project-1" onSelect={onSelect} onClear={() => undefined} />); });

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();

  const search = document.querySelector<HTMLInputElement>('[aria-label="Search task sources"]')!;
  search.focus();
  for (const key of ["4", " ", "Home"]) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
    await act(async () => { search.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(search);
  }

  await act(async () => { setText(search, "42"); });
  expect(document.body.textContent).toContain("#42 Fix picker search");
  expect(document.body.textContent).not.toContain("#17 Improve task creation");

  await act(async () => { setText(search, ""); });
  expect(document.body.textContent).toContain("#42 Fix picker search");
  expect(document.body.textContent).toContain("#17 Improve task creation");

  await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })); });
  await flush();
  expect(document.querySelector('[aria-label="Search task sources"]')).toBeNull();

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  const reopenedSearch = document.querySelector<HTMLInputElement>('[aria-label="Search task sources"]')!;
  reopenedSearch.focus();
  await act(async () => { setText(reopenedSearch, "42"); });
  await act(async () => { reopenedSearch.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })); });
  await flush();
  const firstRow = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(document.activeElement).toBe(firstRow);
  await act(async () => { firstRow.click(); });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "pull_request", number: 42 }), { kind: "pull_request", number: 42 });
  root.unmount();
});
