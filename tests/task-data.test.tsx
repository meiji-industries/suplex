/** @vitest-environment happy-dom */
import { QueryClient, QueryClientProvider, focusManager, notifyManager, useQueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TaskSchema, type Task } from "../src/frontend/contracts/tasks.js";
import { ServerStateProvider, useSignOut } from "../src/frontend/shell/server-state.js";
import { TaskDataProvider, taskListKey, updateTaskCache, useTaskAgents, useTaskData } from "../src/frontend/features/tasks/task-data.js";

const scope = vi.hoisted(() => ({ userId: "user-a" as string | undefined, companyId: "company-a" }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useCompanyContext: () => ({ user: scope.userId ? { id: scope.userId } : undefined, currentCompany: { id: scope.companyId } }) }));

function task(id: string, title = id) {
  const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" };
  const fixture: Task = {
    id, title, companyId: "company-a", projectId: "project", issueKey: null, issue: null, artifacts: [], description: "", status: "backlog", deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: id, baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [],
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
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
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ tasks: url.includes("task-agents") ? [] : [task("a"), task("b"), task("c"), task("d"), task("e")] })));
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
  expect(client.getQueryData(key)).toEqual([changed]);
  await updateTaskCache(client, "user-a", task("b"));
  await updateTaskCache(client, "user-a", { ...changed, archivedAt: new Date().toISOString() });
  expect(client.getQueryData(key)).toEqual([task("b")]);
  await updateTaskCache(client, "user-b", task("a"));
  expect(client.getQueryData(taskListKey("user-b", "company-a"))).toBeUndefined();
});

test("company and user changes isolate private data and cancel late responses", async () => {
  let release: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
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
    if (++batchCalls === 1) return new Response(JSON.stringify({ tasks: [{ taskId: "a", agents: [agent] }] }));
    return new Promise<Response>(resolve => { release = resolve; });
  }));
  const render = (ids: string[]) => root.render(<QueryClientProvider client={client}><Agents ids={ids} /></QueryClientProvider>);
  await act(async () => render(["a"]));
  expect(container.textContent).toContain("working");
  await act(async () => render(["a", "b"]));
  expect(container.textContent).toContain("working");
  await act(async () => release?.(new Response(JSON.stringify({ tasks: [{ taskId: "a", agents: [{ ...agent, status: "idle" }] }] }))));
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
    { taskId: "a", agents: [{ id: "agent-a", role: "root", paneId: null, status: "working", statusChangedAt: null }] },
    ...(includeB ? [{ taskId: "b", agents: [{ id: "agent-b", role: "worker", paneId: null, status: "retrying", statusChangedAt: null }] }] : []),
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
