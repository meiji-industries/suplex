/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider, focusManager, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { refreshTaskActivity, taskObservationKey, useTaskActivity, useTaskExecutionQuery, useTaskTimeline } from "../src/frontend/features/tasks/lib/task-queries.js";
import { TaskAgent } from "../src/frontend/features/tasks/task-agent.js";
import { getTask } from "../src/frontend/features/tasks/lib/task-api.js";
import { TaskSchema } from "../src/frontend/contracts/tasks.js";
import { TaskActivityTimeline } from "../src/frontend/features/tasks/task-activity-timeline.js";

const scope = vi.hoisted(() => ({ userId: "user-a", companyId: "company-a" }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useOptionalCompanyContext: () => undefined, useCompanyContext: () => ({ user: { id: scope.userId }, currentCompany: { id: scope.companyId } }) }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
  notifyManager.setScheduler(queueMicrotask);
  focusManager.setFocused(true);
  scope.userId = "user-a"; scope.companyId = "company-a";
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

const activity = (shellPaneId: string | null = null) => ({ sessions: [], turns: [], setup: { state: "none" as const, exitStatus: null }, shellPaneId });
function Activity({ id }: { id: string }) {
  const query = useTaskActivity(id);
  return <div>{query.data?.shellPaneId}{query.error?.message}</div>;
}
function Observations() {
  useTaskExecutionQuery("task");
  useTaskTimeline("task");
  return <Activity id="task" />;
}
const renderActivity = (id = "task") => root.render(<QueryClientProvider client={client}><Activity id={id} /></QueryClientProvider>);

test("activity polls every three seconds, execution and timeline every five, and hidden intervals pause", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/activity") ? activity() : url.endsWith("/timeline") ? { tasks: [], unavailableSessions: 0 } : { sessions: [] })));
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<QueryClientProvider client={client}><Observations /></QueryClientProvider>));
  const calls = (suffix: string) => fetch.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
  expect([calls("activity"), calls("execution"), calls("timeline")]).toEqual([1, 1, 1]);
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect([calls("activity"), calls("execution"), calls("timeline")]).toEqual([3, 2, 2]);
  await act(async () => focusManager.setFocused(false));
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect([calls("activity"), calls("execution"), calls("timeline")]).toEqual([3, 2, 2]);
  await act(async () => focusManager.setFocused(true));
  expect([calls("activity"), calls("execution"), calls("timeline")]).toEqual([4, 3, 3]);
});

test("slow activity reads do not overlap and unmount aborts them", async () => {
  let signal: AbortSignal | null | undefined;
  const fetch = vi.fn((_url: string, options: RequestInit) => { signal = options.signal; return new Promise<Response>(() => undefined); });
  vi.stubGlobal("fetch", fetch);
  await act(async () => renderActivity());
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
});

test.each(["task", "company", "user"])("a %s change cancels old reads and isolates late activity", async changed => {
  const pending: Array<{ signal: AbortSignal | null | undefined; resolve: (value: Response) => void }> = [];
  vi.stubGlobal("fetch", (_url: string, options: RequestInit) => new Promise<Response>(resolve => pending.push({ signal: options.signal, resolve })));
  await act(async () => renderActivity());
  if (changed === "company") scope.companyId = "company-b";
  if (changed === "user") scope.userId = "user-b";
  await act(async () => renderActivity(changed === "task" ? "new-task" : "task"));
  expect(pending[0]?.signal?.aborted).toBe(true);
  await act(async () => pending[1]?.resolve(new Response(JSON.stringify(activity("fresh")))));
  await act(async () => pending[0]?.resolve(new Response(JSON.stringify(activity("obsolete")))));
  expect(container.textContent).toBe("fresh");
});

test("an explicit activity refresh cancels an obsolete poll before publishing authoritative activity", async () => {
  const pending: Array<{ signal: AbortSignal | null | undefined; resolve: (value: Response) => void }> = [];
  vi.stubGlobal("fetch", (_url: string, options: RequestInit) => new Promise<Response>(resolve => pending.push({ signal: options.signal, resolve })));
  await act(async () => renderActivity());
  let refresh: ReturnType<typeof refreshTaskActivity> | undefined;
  await act(async () => { refresh = refreshTaskActivity(client, scope.userId, scope.companyId, "task"); });
  expect(pending[0]?.signal?.aborted).toBe(true);
  await act(async () => { pending[1]?.resolve(new Response(JSON.stringify(activity("fresh")))); await refresh; });
  await act(async () => pending[0]?.resolve(new Response(JSON.stringify(activity("old")))));
  expect(container.textContent).toBe("fresh");
  expect(client.getQueryData([...taskObservationKey(scope.userId, scope.companyId, "task"), "activity"])).toEqual(activity("fresh"));
});

test("activity errors clear after the next successful poll", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"Activity failed"}', { status: 500 })).mockImplementation(async () => new Response(JSON.stringify(activity("recovered"))));
  vi.stubGlobal("fetch", fetch);
  await act(async () => renderActivity());
  expect(container.textContent).toBe("Activity failed");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).toBe("recovered");
});

test("timeline freshness advances on identical successful reads, expires after ten seconds, and freezes on error", async () => {
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const body = { tasks: [{ id: "task", projectId: "project", issueKey: null, title: "Task", activity: [{ id: "execution", role: "root", advisorRole: null, label: "Coordinator", agentId: "agent", agentName: "Agent", avatarSeed: "agent", status: "running", attempt: 1, startedAt, finishedAt: null }] }], unavailableSessions: 0 };
  let failed = false;
  vi.stubGlobal("fetch", vi.fn(async () => failed ? new Response('{"error":"Timeline failed"}', { status: 500 }) : new Response(JSON.stringify(body))));
  await act(async () => root.render(<QueryClientProvider client={client}><TaskActivityTimeline taskId="task" createdAt="2026-09-27T11:00:00.000Z" /></QueryClientProvider>));
  const entry = () => container.querySelector('[data-task-timing="root"]');
  expect(entry()?.getAttribute("data-task-timing-active")).toBe("true");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(entry()?.getAttribute("data-task-timing-active")).toBe("true");
  await act(async () => focusManager.setFocused(false));
  await act(async () => vi.advanceTimersByTimeAsync(11_000));
  expect(entry()?.hasAttribute("data-task-timing-active")).toBe(false);
  expect(entry()?.getAttribute("aria-label")).toContain("Observation not available");
  const staleLabel = entry()?.getAttribute("aria-label");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(entry()?.getAttribute("aria-label")).toBe(staleLabel);
  failed = true;
  await act(async () => focusManager.setFocused(true));
  expect(container.textContent).toContain("Timeline is not available.");
  const failedLabel = entry()?.getAttribute("aria-label");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(entry()?.getAttribute("aria-label")).toBe(failedLabel);
  failed = false;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).not.toContain("Timeline is not available.");
  expect(entry()?.getAttribute("data-task-timing-active")).toBe("true");
});


test("timeline CI lane shows only check runs that began after the task was created", async () => {
  const createdAt = "2026-09-27T11:00:00.000Z";
  const timeline = { tasks: [{ id: "ci-task", projectId: "project", issueKey: null, title: "Task", activity: [{ id: "execution", role: "root", advisorRole: null, label: "Coordinator", agentId: "agent", agentName: "Agent", avatarSeed: "agent", status: "completed", attempt: 1, startedAt: "2026-09-27T11:10:00.000Z", finishedAt: "2026-09-27T11:20:00.000Z" }] }], unavailableSessions: 0 };
  const checks = { available: true, runs: [
    { name: "before", status: "successful", url: null, startedAt: "2026-09-27T10:59:59.000Z", completedAt: "2026-09-27T11:05:00.000Z" },
    { name: "after", status: "successful", url: null, startedAt: createdAt, completedAt: "2026-09-27T11:05:00.000Z" },
  ] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/checks") ? checks : timeline))));
  await act(async () => root.render(<QueryClientProvider client={client}><TaskActivityTimeline taskId="ci-task" createdAt={createdAt} checksKey="1:ready:sha" /></QueryClientProvider>));
  const runs = Array.from(container.querySelectorAll("[data-task-ci-check]"), run => run.textContent);
  expect(runs).toEqual(["after"]);
  expect(container.querySelector("[data-task-ci-lane]")?.textContent).toContain("Checks · 1× · 5m");
});


test("a successful agent save closes the dialog even if refreshing its activity fails", async () => {
  const raw: unknown = JSON.parse(readFileSync("tests/fixtures/task-response.json", "utf8"));
  const fixture = { ...TaskSchema.parse(raw), status: "active" };
  const saved = { ...fixture, title: "Saved task" };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/profiles"
    ? { profiles: [{ id: fixture.rootProfile.profileId, name: "Coordinator", role: "root", provider: "codex", model: "model", reasoningLevel: "high", serviceTier: "default", archivedAt: null }] }
    : url.endsWith("/select-agent") ? saved : fixture))));
  const task = await getTask(fixture.id);
  const onChange = vi.fn();
  const onActivityChange = vi.fn().mockResolvedValueOnce(activity()).mockRejectedValueOnce(new Error("Display refresh failed"));
  await act(async () => root.render(<TaskAgent task={task} role="root" onChange={onChange} onActivityChange={onActivityChange} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select Coordinator"]')?.click());
  const field = document.querySelector<HTMLTextAreaElement>(`#agent-direction-root-${task.id}`);
  if (!field) throw new Error("Agent direction was not rendered");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "Continue with the same agent");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(save?.disabled).toBe(false);
  await act(async () => save?.click());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(onChange).toHaveBeenLastCalledWith(saved);
  expect(onActivityChange).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Display refresh failed");
});
