// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", () => api);

import { TaskSourcePicker } from "../src/frontend/features/tasks/task-source-picker.js";

function setText(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.readJsonUnchecked.mockResolvedValue({ available: true, sources: [
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

test("issue selection reads the configured Jira tracker and returns its association", async () => {
  api.readJsonUnchecked.mockImplementation(async (url: string) => {
    if (url.includes("/issues?query=")) return { issues: [{ kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42", usedBy: null }] };
    return { available: true, sources: [] };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  act(() => { root.render(<TaskSourcePicker projectId="project-1" onSelect={onSelect} onClear={() => undefined} />); });

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Issues")!.click(); });
  await flush();

  expect(api.readJsonUnchecked).toHaveBeenLastCalledWith("/api/projects/project-1/issues?query=");
  expect(document.body.textContent).toContain("APP-42 Fix the picker");
  await act(async () => { Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(row => row.textContent?.includes("APP-42"))!.click(); });
  expect(onSelect).toHaveBeenCalledWith({ kind: "issue", issue: { kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42" } });
  root.unmount();
});

test("newer issue searches replace slower earlier results", async () => {
  const requests: Array<{ query: string; response: ReturnType<typeof deferred<{ issues: Array<{ kind: "jira"; site: string; id: string; key: string; title: string; url: string }> }>> }> = [];
  api.readJsonUnchecked.mockImplementation((url: string) => {
    if (!url.includes("/issues?query=")) return Promise.resolve({ available: true, sources: [] });
    const response = deferred<{ issues: Array<{ kind: "jira"; site: string; id: string; key: string; title: string; url: string }> }>();
    requests.push({ query: new URL(url, "https://suplex.test").searchParams.get("query") ?? "", response });
    return response.promise;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(<TaskSourcePicker projectId="project-1" onSelect={() => undefined} onClear={() => undefined} />); });

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Issues")!.click(); });
  await flush();
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search task sources"]')!;
  await act(async () => { setText(search, "first"); });
  await act(async () => { setText(search, "second"); });

  const issue = (key: string, title: string) => ({ kind: "jira" as const, site: "https://client.atlassian.net", id: key, key: `APP-${key}`, title, url: `https://client.atlassian.net/browse/APP-${key}` });
  await act(async () => { requests.find(request => request.query === "second")!.response.resolve({ issues: [issue("2", "Second result")] }); });
  await act(async () => { requests.find(request => request.query === "first")!.response.resolve({ issues: [issue("1", "First result")] }); requests.find(request => request.query === "")!.response.resolve({ issues: [issue("0", "Initial result")] }); });

  expect(document.body.textContent).toContain("APP-2 Second result");
  expect(document.body.textContent).not.toContain("First result");
  expect(document.body.textContent).not.toContain("Initial result");
  root.unmount();
});

test("tab and project changes invalidate pending issue searches", async () => {
  const requests: Array<ReturnType<typeof deferred<{ issues: Array<{ kind: "jira"; site: string; id: string; key: string; title: string; url: string }> }>>> = [];
  api.readJsonUnchecked.mockImplementation((url: string) => {
    if (!url.includes("/issues?query=")) return Promise.resolve({ available: true, sources: [{ kind: "pull_request", number: 7, title: "Current pull request", body: "", author: "octo", headBranch: "feature", baseBranch: "main", isDraft: false }] });
    const response = deferred<{ issues: Array<{ kind: "jira"; site: string; id: string; key: string; title: string; url: string }> }>();
    requests.push(response);
    return response.promise;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (projectId: string) => <TaskSourcePicker projectId={projectId} onSelect={() => undefined} onClear={() => undefined} />;
  act(() => { root.render(render("project-1")); });

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Issues")!.click(); });
  await flush();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Pull requests")!.click(); });
  await flush();
  await act(async () => { requests[0]!.resolve({ issues: [{ kind: "jira", site: "https://client.atlassian.net", id: "1", key: "APP-1", title: "Stale tab result", url: "https://client.atlassian.net/browse/APP-1" }] }); });
  expect(document.body.textContent).toContain("#7 Current pull request");
  expect(document.body.textContent).not.toContain("Stale tab result");

  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Issues")!.click(); });
  await flush();
  await act(async () => { root.render(render("project-2")); });
  await act(async () => { requests[1]!.resolve({ issues: [{ kind: "jira", site: "https://client.atlassian.net", id: "2", key: "APP-2", title: "Stale project result", url: "https://client.atlassian.net/browse/APP-2" }] }); });
  expect(document.body.textContent).not.toContain("Stale project result");
  root.unmount();
});

test("issue results keep tracker matches that do not contain the query", async () => {
  api.readJsonUnchecked.mockImplementation(async (url: string) => url.includes("/issues?query=")
    ? { issues: [{ kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42" }] }
    : { available: true, sources: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(<TaskSourcePicker projectId="project-1" onSelect={() => undefined} onClear={() => undefined} />); });

  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Issues")!.click(); });
  await flush();
  await act(async () => { setText(document.querySelector<HTMLInputElement>('[aria-label="Search task sources"]')!, "words from the Jira description"); });
  await flush();

  expect(document.body.textContent).toContain("APP-42 Fix the picker");
  root.unmount();
});

test("a pull request that a task already uses is disabled", async () => {
  api.readJsonUnchecked.mockResolvedValue({ available: true, sources: [
    { kind: "pull_request", number: 42, title: "Fix picker search", body: "", author: "octo", headBranch: "fix/search", baseBranch: "main", isDraft: false, usedBy: { taskId: "task-7", title: "Search repair", status: "active" } },
  ] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  act(() => { root.render(<TaskSourcePicker projectId="project-1" onSelect={onSelect} onClear={() => undefined} />); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  expect(document.body.textContent).toContain("Open task: Search repair");
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(row.getAttribute("aria-disabled")).toBe("true");
  await act(async () => { row.click(); });
  expect(onSelect).not.toHaveBeenCalled();
  root.unmount();
});

test("an issue that a task already uses is disabled", async () => {
  api.readJsonUnchecked.mockImplementation(async (url: string) => url.includes("/issues?query=")
    ? { issues: [{ kind: "jira", site: "https://client.atlassian.net", id: "42", key: "APP-42", title: "Fix the picker", url: "https://client.atlassian.net/browse/APP-42", usedBy: { taskId: "task-7", title: "Search repair", status: "backlog" } }] }
    : { available: true, sources: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  act(() => { root.render(<TaskSourcePicker projectId="project-1" onSelect={onSelect} onClear={() => undefined} />); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="New from source"]')!.click(); });
  await flush();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Issues")!.click(); });
  await flush();
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(row.textContent).toContain("Open task: Search repair");
  expect(row.getAttribute("aria-disabled")).toBe("true");
  await act(async () => { row.click(); });
  expect(onSelect).not.toHaveBeenCalled();
  root.unmount();
});
