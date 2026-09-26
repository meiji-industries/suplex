// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useTaskChecks } from "../src/frontend/features/tasks/lib/task-checks.js";
import { readJsonUnchecked } from "../src/frontend/lib/api.js";

vi.mock("../src/frontend/lib/api.js", () => ({ readJsonUnchecked: vi.fn() }));

const settled = { available: true, pullRequestState: "ready", runs: [{ name: "build", status: "successful", url: null }] };
const pending = { available: true, pullRequestState: "ready", runs: [{ name: "build", status: "pending", url: null }] };
const roots: Root[] = [];
const values = new Map<string, ReturnType<typeof useTaskChecks>>();

function Consumer({ name, taskId = "task", refreshKey = "open:head" }: { name: string; taskId?: string | null; refreshKey?: string }) {
  values.set(name, useTaskChecks(taskId, refreshKey));
  return null;
}

async function render(name: string, taskId: string | null = "task", refreshKey = "open:head") {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () => { root.render(<Consumer name={name} taskId={taskId} refreshKey={refreshKey} />); });
  return { root, node, update: async (nextTaskId: string | null, nextKey = refreshKey) => act(async () => { root.render(<Consumer name={name} taskId={nextTaskId} refreshKey={nextKey} />); }) };
}

async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => { vi.useFakeTimers(); vi.mocked(readJsonUnchecked).mockReset(); values.clear(); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.useRealTimers();
});

test("mounted consumers share one read and pending checks refresh after 15 seconds", async () => {
  vi.mocked(readJsonUnchecked).mockResolvedValue(pending);
  await render("first");
  await render("second");
  expect(readJsonUnchecked).toHaveBeenCalledTimes(1);
  expect(values.get("second")?.checks?.runs[0]?.status).toBe("pending");
  await advance(14_999);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
});

test("settled checks refresh after 60 seconds and requests never overlap", async () => {
  let resolve: (value: unknown) => void = () => undefined;
  vi.mocked(readJsonUnchecked).mockResolvedValueOnce(settled).mockImplementation(() => new Promise(done => { resolve = done; }));
  await render("first");
  await advance(59_999);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
  await advance(120_000);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(settled); });
  await advance(60_000);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(3);
});

test("hidden documents pause reads and becoming visible refreshes promptly", async () => {
  vi.mocked(readJsonUnchecked).mockResolvedValue(pending);
  await render("first");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  await advance(60_000);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
});

test("key changes during a read refresh after it settles, and old task results do not reach a new task", async () => {
  let resolveOld: (value: unknown) => void = () => undefined;
  vi.mocked(readJsonUnchecked).mockImplementationOnce(() => new Promise(done => { resolveOld = done; })).mockResolvedValue(settled);
  const view = await render("first");
  await view.update("task", "open:new-head");
  await view.update("other", "open:other-head");
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
  await act(async () => { resolveOld(pending); });
  expect(values.get("first")?.checks?.runs[0]?.status).toBe("successful");
  await advance(60_000);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(3);
});

test("a changed pull request head during a read starts one follow-up read", async () => {
  let resolveOld: (value: unknown) => void = () => undefined;
  vi.mocked(readJsonUnchecked).mockImplementationOnce(() => new Promise(done => { resolveOld = done; })).mockResolvedValue(settled);
  const view = await render("first");
  await view.update("task", "open:new-head");
  expect(readJsonUnchecked).toHaveBeenCalledTimes(1);
  await act(async () => { resolveOld(pending); });
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
  expect(values.get("first")?.checks?.runs[0]?.status).toBe("successful");
});

test("a merged response for an old pull request never appears under the new identity", async () => {
  let resolveOld: (value: unknown) => void = () => undefined;
  let resolveNew: (value: unknown) => void = () => undefined;
  vi.mocked(readJsonUnchecked)
    .mockImplementationOnce(() => new Promise(done => { resolveOld = done; }))
    .mockImplementationOnce(() => new Promise(done => { resolveNew = done; }));
  const view = await render("first", "task", "7:open:old-head");
  await view.update("task", "8:open:new-head");
  expect(values.get("first")?.checks).toBeNull();
  await act(async () => { resolveOld({ ...settled, pullRequestState: "merged" }); });
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
  expect(values.get("first")?.checks).toBeNull();
  await act(async () => { resolveNew(settled); });
  expect(values.get("first")?.checks?.pullRequestState).toBe("ready");
});

test("a completed old observation clears when pull request identity changes", async () => {
  let resolveNew: (value: unknown) => void = () => undefined;
  vi.mocked(readJsonUnchecked)
    .mockResolvedValueOnce({ ...settled, pullRequestState: "merged" })
    .mockImplementationOnce(() => new Promise(done => { resolveNew = done; }));
  const view = await render("first", "task", "7:merged:old-head");
  expect(values.get("first")?.checks?.pullRequestState).toBe("merged");
  await view.update("task", "8:open:new-head");
  expect(values.get("first")?.checks).toBeNull();
  await act(async () => { resolveNew(settled); });
  expect(values.get("first")?.checks?.pullRequestState).toBe("ready");
});

test("a late response from the last subscriber does not overwrite a fresh remount", async () => {
  let resolveOld: (value: unknown) => void = () => undefined;
  vi.mocked(readJsonUnchecked).mockImplementationOnce(() => new Promise(done => { resolveOld = done; })).mockResolvedValue(settled);
  const first = await render("first");
  await act(async () => { first.root.unmount(); });
  await render("second");
  expect(values.get("second")?.checks?.runs[0]?.status).toBe("successful");
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
  await act(async () => { resolveOld(pending); });
  expect(values.get("second")?.checks?.runs[0]?.status).toBe("successful");
  await advance(60_000);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(3);
});

test("provider errors recover and unrelated rerenders do not force requests", async () => {
  vi.mocked(readJsonUnchecked).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(settled);
  const view = await render("first");
  expect(values.get("first")?.error).toBe("offline");
  await view.update("task", "open:head");
  expect(readJsonUnchecked).toHaveBeenCalledTimes(1);
  await advance(15_000);
  expect(values.get("first")?.error).toBe("");
  expect(values.get("first")?.checks?.runs[0]?.status).toBe("successful");
  await act(async () => { view.root.unmount(); });
  await advance(120_000);
  expect(readJsonUnchecked).toHaveBeenCalledTimes(2);
});
