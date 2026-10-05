/** @vitest-environment happy-dom */
import { QueryClient, QueryClientProvider, focusManager, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TaskListTask } from "../src/frontend/contracts/task-responses.js";
import { TaskDataProvider, useTaskData } from "../src/frontend/features/tasks/task-data.js";

const scope = vi.hoisted(() => ({ companyId: "company-a" }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ user: { id: "user-a" }, currentCompany: { id: scope.companyId } }) }));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void { this.onclose?.(new CloseEvent("close")); }
  emit(value: unknown): void { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

function row(id: string, title = id, updatedAt = "2026-09-08T00:00:00.000Z"): TaskListTask {
  return {
    id, companyId: "company-a", projectId: "project", issueKey: null, title, status: "backlog", configuration: { repository: "owner/repo", branch: id },
    pullRequest: null, humanQuestion: null, blockedBy: [], dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt, statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
  };
}

let rows: TaskListTask[] | undefined;
function Capture() {
  rows = useTaskData().data;
  return null;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let listed: TaskListTask[];
let fetch: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
const lists = () => fetch.mock.calls.filter(([url]) => url.includes("/tasks?")).length;
const sockets = () => FakeWebSocket.instances;
const render = () => act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><Capture /></TaskDataProvider></QueryClientProvider>));
const emit = (socket: FakeWebSocket | undefined, message: unknown) => act(async () => socket?.emit(message));
const titles = () => rows?.map(task => task.title);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  notifyManager.setScheduler(queueMicrotask);
  focusManager.setFocused(true);
  scope.companyId = "company-a";
  FakeWebSocket.instances = [];
  rows = undefined;
  listed = [row("a"), row("b")];
  fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ tasks: url.includes("/tasks?") ? listed : [] })));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  window.history.replaceState({}, "", "/tasks");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); container.remove();
  focusManager.setFocused(undefined);
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

test("a snapshot stops the 3 second poll, and changes replace, order, and remove tasks", async () => {
  await render();
  expect(lists()).toBe(1);
  expect(sockets()).toHaveLength(1);
  expect(sockets()[0]?.url).toContain("/api/companies/company-a/sync");

  await emit(sockets()[0], { type: "snapshot", tasks: [row("a"), row("b"), row("c")] });
  expect(titles()).toEqual(["a", "b", "c"]);
  const unchanged = rows?.[0];
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(lists()).toBe(1);

  await emit(sockets()[0], { type: "changes", tasks: [row("c", "Renamed", "2026-09-09T00:00:00.000Z"), row("d")], removedTaskIds: ["b"] });
  expect(titles()).toEqual(["Renamed", "a", "d"]);
  expect(rows?.[1]).toBe(unchanged);

  // A heartbeat changes nothing.
  const before = rows;
  await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [] });
  expect(rows).toBe(before);

  // The slow read repairs a missed frame.
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(lists()).toBe(2);
  expect(titles()).toEqual(["a", "b"]);
});

test("a closed or silent socket polls again and connects again", async () => {
  await render();
  await emit(sockets()[0], { type: "snapshot", tasks: listed });
  await act(async () => sockets()[0]?.close());
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(lists()).toBe(2);
  expect(sockets()).toHaveLength(2);

  await emit(sockets()[1], { type: "snapshot", tasks: listed });
  const reads = lists();
  await act(async () => vi.advanceTimersByTimeAsync(44_000));
  expect([lists(), sockets().length]).toEqual([reads, 2]);
  // The server sends a frame every 15 seconds. This socket sent none for 45 seconds.
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(sockets()).toHaveLength(3);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(lists()).toBeGreaterThan(reads);
});

test("without a socket the list loads and polls over HTTP", async () => {
  vi.stubGlobal("WebSocket", undefined);
  await render();
  expect(titles()).toEqual(["a", "b"]);
  listed = [row("a", "Changed")];
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(titles()).toEqual(["Changed"]);
});

test("a list read in flight does not replace a pushed state", async () => {
  let release: ((response: Response) => void) | undefined;
  fetch.mockImplementation((url: string) => url.includes("/tasks?") ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(new Response('{"tasks":[]}')));
  await render();
  await emit(sockets()[0], { type: "snapshot", tasks: [row("a", "Pushed")] });
  await act(async () => release?.(new Response(JSON.stringify({ tasks: [row("a", "Old")] }))));
  expect(titles()).toEqual(["Pushed"]);
});

test("a company change closes the socket and ignores its late frames", async () => {
  await render();
  const first = sockets()[0];
  scope.companyId = "company-b";
  listed = [];
  await render();
  expect(sockets()).toHaveLength(2);
  expect(sockets()[1]?.url).toContain("/api/companies/company-b/sync");
  await emit(first, { type: "snapshot", tasks: [row("a", "Company A")] });
  expect(titles()).toEqual([]);
});
