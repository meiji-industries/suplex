/** @vitest-environment happy-dom */
import { QueryClient, QueryClientProvider, focusManager, notifyManager, useQueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TaskSchema, type Task } from "../contracts/tasks.js";
import { ServerStateProvider, useSignOut } from "../shell/server-state.js";
import { TaskDataProvider, taskCostsKey, taskListKey, updateTaskCache, useTaskAgents, useTaskCosts, useTaskData } from "../features/tasks/task-data.js";

const scope = vi.hoisted(() => ({ userId: "user-a" as string | undefined, companyId: "company-a" }));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ user: scope.userId ? { id: scope.userId } : undefined, currentCompany: { id: scope.companyId } }) }));
// These tests cover the HTTP reads. The sync socket has its tests in task-sync.test.tsx.
vi.mock("../features/tasks/lib/task-sync-api.js", () => ({ openTaskSync: () => ({ close: () => undefined, watch: () => undefined }) }));

function task(id: string, title = id) {
  const profile: Task["rootProfile"] = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" };
  const fixture: Task = {
    id, title, companyId: "company-a", projectId: "project", issueKey: null, issue: null, artifacts: [], description: "", status: "backlog", deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: id, baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [],
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
  };
  TaskSchema.parse(fixture);
  return fixture;
}

function Consumer({ agents = false }: { agents?: boolean }) {
  const list = useTaskData();
  return <div>{list.data?.map(task => task.title).join(",")}{agents ? <Agents ids={(list.data ?? []).map(task => task.id)} /> : null}</div>;
}
function Agents({ ids }: { ids: string[] }) {
  const batch = useTaskAgents(ids);
  return <span>{batch.data?.flatMap(task => task.agents.map(agent => agent.status)).join(",")}</span>;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  notifyManager.setScheduler(queueMicrotask);
  focusManager.setFocused(true);
  scope.userId = "user-a"; scope.companyId = "company-a";
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

test("staggered consumers share one list timer and one agent batch, and hidden intervals stop", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ tasks: (url.includes("task-agents") || url.includes("task-costs")) ? [] : [task("a"), task("b"), task("c"), task("d"), task("e")] })));
  vi.stubGlobal("fetch", fetch);
  const render = (second: boolean) => root.render(<QueryClientProvider client={client}><TaskDataProvider><Consumer agents />{second ? <Consumer /> : null}</TaskDataProvider></QueryClientProvider>);
  await act(async () => render(false));
  const lists = () => fetch.mock.calls.filter(([url]) => url.includes("/tasks?")).length;
  const batches = () => fetch.mock.calls.filter(([url]) => url.includes("/task-agents?")).length;
  expect([lists(), batches()]).toEqual([1, 1]);
  expect(new URL(fetch.mock.calls.find(([url]) => url.includes("task-agents"))![0], "http://suplex.test").searchParams.getAll("taskId")).toEqual(["a", "b", "c", "d", "e"]);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => render(true));
  expect(lists()).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect([lists(), batches()]).toEqual([3, 3]);
  await act(async () => focusManager.setFocused(false));
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect([lists(), batches()]).toEqual([3, 3]);
  await act(async () => focusManager.setFocused(true));
  expect([lists(), batches()]).toEqual([4, 4]);
  expect(fetch.mock.calls.some(([url]) => /\/tasks\/[^/]+\/agents/.test(url))).toBe(false);
});

test("a mutation response survives an older list response and updates, adds, and archives cached tasks", async () => {
  const before = task("a", "Before");
  const key = taskListKey("user-a", "company-a");
  client.setQueryData(key, [before]);
  let resolveOld: ((tasks: typeof before[]) => void) | undefined;
  const old = client.fetchQuery({ queryKey: key, queryFn: ({ signal }) => { void signal; return new Promise<typeof before[]>(resolve => { resolveOld = resolve; }); } }).catch(() => undefined);
  const changed = { ...before, title: "Saved" };
  await updateTaskCache(client, "user-a", changed);
  resolveOld?.([before]); await old;
  expect(client.getQueryData(key)).toMatchObject([{ id: "a", title: "Saved" }]);
  expect(client.getQueryData<{ description?: string }[]>(key)?.[0]).not.toHaveProperty("description");
  await updateTaskCache(client, "user-a", task("b"));
  await updateTaskCache(client, "user-a", { ...changed, archivedAt: new Date().toISOString() });
  expect(client.getQueryData(key)).toMatchObject([{ id: "b" }]);
  await updateTaskCache(client, "user-b", task("a"));
  expect(client.getQueryData(taskListKey("user-b", "company-a"))).toBeUndefined();
});

test("a command response does not replace a newer pushed state", async () => {
  const key = taskListKey("user-a", "company-a");
  const pushed = { ...task("a", "Pushed"), updatedAt: "2026-09-09T00:00:00.000Z" };
  client.setQueryData(key, [pushed]);
  await updateTaskCache(client, "user-a", task("a", "Older command"));
  expect(client.getQueryData(key)).toMatchObject([{ title: "Pushed" }]);
  await updateTaskCache(client, "user-a", { ...pushed, title: "Newer command", updatedAt: "2026-09-10T00:00:00.000Z" });
  expect(client.getQueryData(key)).toMatchObject([{ title: "Newer command" }]);
});

test("company and user changes isolate private data and cancel late responses", async () => {
  let release: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/task-costs") ? Promise.resolve(new Response(JSON.stringify({ tasks: [] }))) : new Promise<Response>(resolve => { release = resolve; })));
  let scopedClient: QueryClient | undefined;
  function ClientCapture() { scopedClient = useQueryClient(); return <Consumer />; }
  const render = () => root.render(<ServerStateProvider><TaskDataProvider><ClientCapture /></TaskDataProvider></ServerStateProvider>);
  await act(async () => render());
  const oldRelease = release;
  scope.companyId = "company-b";
  await act(async () => render());
  await act(async () => oldRelease?.(new Response(JSON.stringify({ tasks: [task("a", "Private A")] }))));
  expect(container.textContent).not.toContain("Private A");
  await act(async () => release?.(new Response(JSON.stringify({ tasks: [{ ...task("b", "Private B"), companyId: "company-b" }] }))));
  expect(container.textContent).toContain("Private B");
  const signedInClient = scopedClient;
  scope.userId = undefined;
  await act(async () => render());
  expect(container.textContent).not.toContain("Private B");
  expect(signedInClient?.getQueryCache().getAll()).toEqual([]);
  expect(scopedClient).not.toBe(signedInClient);
});

test("sign-out clears private queries before leaving the application", async () => {
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
  client.setQueryData(taskListKey("user-a", "company-a"), [task("private")]);
  function SignOut() { const signOut = useSignOut(); return <button onClick={() => void signOut()}>Sign out</button>; }
  await act(async () => root.render(<QueryClientProvider client={client}><SignOut /></QueryClientProvider>));
  await act(async () => container.querySelector("button")?.click());
  expect(fetch).toHaveBeenCalledWith("/api/auth/sign-out", { method: "POST" });
  expect(client.getQueryCache().getAll()).toEqual([]);
  expect(navigate).toHaveBeenCalledWith("/auth");
});

test("agent batches keep the previous result across an id change in the same scope and drop it across companies", async () => {
  const agent = { id: "agent-1", role: "root", paneId: null, status: "working", statusChangedAt: null };
  let release: ((response: Response) => void) | undefined;
  let batchCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/tasks?")) return new Response(JSON.stringify({ tasks: [task("a"), task("b")] }));
    if (!url.includes("/task-agents?")) throw new Error(`Unexpected request: ${url}`);
    if (++batchCalls === 1) return new Response(JSON.stringify({ tasks: [{ taskId: "a", setup: { state: "none", exitStatus: null }, agents: [agent] }] }));
    return new Promise<Response>(resolve => { release = resolve; });
  }));
  const render = (ids: string[]) => root.render(<QueryClientProvider client={client}><Agents ids={ids} /></QueryClientProvider>);
  await act(async () => render(["a"]));
  expect(container.textContent).toContain("working");
  await act(async () => render(["a", "b"]));
  expect(container.textContent).toContain("working");
  await act(async () => release?.(new Response(JSON.stringify({ tasks: [{ taskId: "a", setup: { state: "none", exitStatus: null }, agents: [{ ...agent, status: "idle" }] }] }))));
  expect(container.textContent).toContain("idle");
  expect(container.textContent).not.toContain("working");
  scope.companyId = "company-b";
  await act(async () => render(["a", "b"]));
  expect(container.textContent).not.toContain("idle");
  expect(container.textContent).not.toContain("working");
  await act(async () => release?.(new Response(JSON.stringify({ tasks: [] }))));
});

test("agent placeholders survive membership changes but clear on a user change", async () => {
  let release: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { release = resolve; }));
  const batch = (includeB: boolean) => new Response(JSON.stringify({ tasks: [
    { taskId: "a", setup: { state: "none", exitStatus: null }, agents: [{ id: "agent-a", role: "root", paneId: null, status: "working", statusChangedAt: null }] },
    ...(includeB ? [{ taskId: "b", setup: { state: "none", exitStatus: null }, agents: [{ id: "agent-b", role: "worker", paneId: null, status: "retrying", statusChangedAt: null }] }] : []),
  ] }));
  const render = (ids: string[]) => root.render(<QueryClientProvider client={client}><Agents ids={ids} /></QueryClientProvider>);
  await act(async () => render(["a"]));
  await act(async () => release?.(batch(false)));
  expect(container.textContent).toBe("working");
  await act(async () => render(["a", "b"]));
  expect(container.textContent).toBe("working");
  await act(async () => release?.(batch(true)));
  expect(container.textContent).toBe("working,retrying");
  scope.userId = "other";
  await act(async () => render(["a", "b"]));
  expect(container.textContent).toBe("");
});

test.each([
  { status: 500, expected: 2, label: "one retry" },
  { status: 401, expected: 1, label: "no retry" },
  { status: 403, expected: 1, label: "no retry" },
  { status: 404, expected: 1, label: "no retry" },
])("a $status list read gets $label", async ({ status, expected }) => {
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ error: "Read failed" }), { status }));
  vi.stubGlobal("fetch", fetch);
  let scopedClient: QueryClient | undefined;
  function ClientCapture() { scopedClient = useQueryClient(); return <Consumer />; }
  await act(async () => root.render(<ServerStateProvider><TaskDataProvider><ClientCapture /></TaskDataProvider></ServerStateProvider>));
  await act(async () => vi.advanceTimersByTimeAsync(2500));
  expect(fetch.mock.calls.filter(([url]) => url.includes("/tasks?"))).toHaveLength(expected);
  expect(scopedClient?.getQueryState(taskListKey("user-a", "company-a"))).toMatchObject({ status: "error", fetchStatus: "idle" });
});

function Costs() {
  const costs = useTaskCosts(scope.companyId);
  return <span>{[...costs.values()].map(task => `${task.id}:${task.cost}`).join(",")}</span>;
}

test("staggered cost consumers share one timer, stable map, and visibility refresh", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ tasks: url.endsWith("/task-costs") ? [{ id: "a", cost: 2, partial: false, subsidized: false, unpriced: false, totalTokens: 0 }] : [] })));
  vi.stubGlobal("fetch", fetch);
  let map: ReturnType<typeof useTaskCosts> | undefined;
  function Capture() { map = useTaskCosts(scope.companyId); return <Costs />; }
  const render = (second: boolean) => root.render(<QueryClientProvider client={client}><TaskDataProvider><Capture />{second ? <Costs /> : null}</TaskDataProvider></QueryClientProvider>);
  await act(async () => render(false));
  const reads = () => fetch.mock.calls.filter(([url]) => url.endsWith("/task-costs")).length;
  expect(reads()).toBe(1);
  expect(container.textContent).toBe("a:2");
  const firstMap = map;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await act(async () => render(true));
  expect(map).toBe(firstMap);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(reads()).toBe(2);
  await act(async () => focusManager.setFocused(false));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(reads()).toBe(2);
  await act(async () => focusManager.setFocused(true));
  expect(reads()).toBe(3);
});

test.each(["/admin", "/profile", "/companies/company-a/settings", "/projects", "/health", "/", "/templates", "/onboarding"])("%s does not poll costs", async path => {
  window.history.replaceState({}, "", path);
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ tasks: [] })));
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><Costs /></TaskDataProvider></QueryClientProvider>));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/task-costs"))).toHaveLength(0);
});

test("costs cancel across company changes and unmount, and late responses remain isolated", async () => {
  const pending: Array<{ signal: AbortSignal | null | undefined; resolve: (value: Response) => void }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => url.endsWith("/task-costs")
    ? new Promise<Response>(resolve => pending.push({ signal: options.signal, resolve }))
    : Promise.resolve(new Response(JSON.stringify({ tasks: [] })))));
  const render = (mounted = true) => root.render(<QueryClientProvider client={client}>{mounted ? <TaskDataProvider><Costs /></TaskDataProvider> : null}</QueryClientProvider>);
  await act(async () => render());
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(pending).toHaveLength(1);
  scope.companyId = "company-b";
  await act(async () => render());
  expect(pending[0]?.signal?.aborted).toBe(true);
  const response = (id: string) => new Response(JSON.stringify({ tasks: [{ id, cost: 3, partial: false, subsidized: false, unpriced: false, totalTokens: 0 }] }));
  await act(async () => pending[1]?.resolve(response("B")));
  await act(async () => pending[0]?.resolve(response("A")));
  expect(container.textContent).toBe("B:3");
  expect(client.getQueryData(taskCostsKey("user-a", "company-a"))).toBeUndefined();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  await act(async () => render(false));
  expect(pending[2]?.signal?.aborted).toBe(true);
});

test("costs disappear after an error and return on recovery", async () => {
  let failed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/task-costs")
    ? failed ? new Response('{"error":"No costs"}', { status: 500 }) : new Response(JSON.stringify({ tasks: [{ id: "a", cost: 1, partial: false, subsidized: false, unpriced: false, totalTokens: 0 }] }))
    : new Response('{"tasks":[]}')));
  await act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><Costs /></TaskDataProvider></QueryClientProvider>));
  expect(container.textContent).toBe("a:1");
  failed = true;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(container.textContent).toBe("");
  failed = false;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(container.textContent).toBe("a:1");
});


test("desktop account logout unlinks the account before clearing state and returning to login", async () => {
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
  client.setQueryData(taskListKey("user-a", "company-a"), [task("private")]);
  function Logout() { const logout = useSignOut("account"); return <button onClick={() => void logout()}>Log out</button>; }
  await act(async () => root.render(<QueryClientProvider client={client}><Logout /></QueryClientProvider>));
  await act(async () => container.querySelector("button")?.click());
  expect(fetch).toHaveBeenCalledWith("/api/account/logout", expect.objectContaining({ method: "POST" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.getQueryCache().getAll()).toEqual([]);
  expect(navigate).toHaveBeenCalledWith("/");
});

test("failed account logout preserves the current view and reports failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })));
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
  client.setQueryData(taskListKey("user-a", "company-a"), [task("private")]);
  let logout: (() => Promise<void>) | undefined;
  function Logout() { logout = useSignOut("account"); return null; }
  await act(async () => root.render(<QueryClientProvider client={client}><Logout /></QueryClientProvider>));
  await expect(logout?.()).rejects.toThrow();
  expect(navigate).not.toHaveBeenCalled();
  expect(client.getQueryCache().getAll()).not.toEqual([]);
});
