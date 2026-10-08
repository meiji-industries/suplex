/** @vitest-environment happy-dom */
import { QueryClient, QueryClientProvider, focusManager, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoveResponse } from "../contracts/generated/MoveResponse.js";
import type { TaskListTask } from "../contracts/task-responses.js";
import type { Task } from "../contracts/tasks.js";
import { MoveRunView } from "../features/moves/move-run.js";
import { useShellRuns } from "../features/moves/lib/move-runs.js";
import { useProjects } from "../features/projects/lib/projects.js";
import { useTaskChecks } from "../features/tasks/lib/task-checks.js";
import { useTask, useTaskActivity, useTaskDiff, useTaskDiffSummary, useTaskExecutionQuery, useTaskTimeline } from "../features/tasks/lib/task-queries.js";
import { TaskActivityTimeline } from "../features/tasks/task-activity-timeline.js";
import { TaskDataProvider, updateTaskCache, useTaskAgents, useTaskCosts, useTaskData } from "../features/tasks/task-data.js";

const scope = vi.hoisted(() => ({ companyId: "company-a" }));
vi.mock("../shell/company-context.js", () => { const context = () => ({ user: { id: "user-a" }, currentCompany: { id: scope.companyId }, avatars: {} }); return { useCompanyContext: context, useOptionalCompanyContext: context }; });
vi.mock("../features/tasks/task-chat/live-pane-terminal.js", () => ({ PaneTerminal: () => <p>Terminal</p> }));
vi.mock("../features/moves/run-transcript.js", () => ({ RunTranscript: () => <p>Transcript</p> }));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void { this.readyState = 1; this.onopen?.(); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.onclose?.(new CloseEvent("close")); }
  emit(value: unknown): void { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

function row(id: string, title = id, updatedAt = "2026-09-08T00:00:00.000Z"): TaskListTask {
  return {
    id, companyId: "company-a", projectId: "project", issueKey: null, title, status: "backlog", configuration: { repository: "owner/repo", branch: id },
    pullRequest: null, humanQuestion: null, blockedBy: [], queue: { planConcurrencyLimited: false, projectConcurrencyLimited: false, waitingOn: [] }, dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt, statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null,
  };
}

let rows: TaskListTask[] | undefined;
let runs: string[] = [];
let projects: string[] | undefined;
let projectRows: ReturnType<typeof useProjects>["data"];
function Capture() {
  rows = useTaskData().data;
  return null;
}
function CaptureLists() {
  runs = useShellRuns(scope.companyId).map(({ move, run }) => `${move.name}:${run.live ? "live" : "ended"}`);
  projectRows = useProjects(scope.companyId).data;
  projects = projectRows?.map(project => project.name);
  return <Capture />;
}
const project = (name: string) => ({ id: name, name });
function move(name: string, live: boolean) {
  return { id: name, name, projectId: "project", lastRun: { id: `${name}-run`, runner: "script", live, startedAt: "2026-09-08T00:00:00.000Z" } };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let listed: TaskListTask[];
let fetch: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
const reads = (part: string) => fetch.mock.calls.filter(([url]) => url.includes(part)).length;
const lists = () => reads("/tasks?");
let projectNames: string[];
const sockets = () => FakeWebSocket.instances;
const render = (all = false) => act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider>{all ? <CaptureLists /> : <Capture />}</TaskDataProvider></QueryClientProvider>));
const emit = (socket: FakeWebSocket | undefined, message: unknown) => act(async () => socket?.emit(message));
const titles = () => rows?.map(task => task.title);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  notifyManager.setScheduler(queueMicrotask);
  focusManager.setFocused(true);
  scope.companyId = "company-a";
  FakeWebSocket.instances = [];
  rows = undefined; runs = []; projects = undefined; projectRows = undefined;
  listed = [row("a"), row("b")];
  projectNames = ["Repository"];
  fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ tasks: url.includes("/tasks?") ? listed : [], moves: [move("Polled", false)], projects: projectNames.map(project) })));
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

  await emit(sockets()[0], { type: "snapshot", tasks: [row("a"), row("b"), row("c")], moves: [] });
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

test("moves and projects arrive whole in the frames", async () => {
  await render(true);
  expect(runs).toEqual(["Polled:ended"]);
  expect(projects).toEqual(["Repository"]);
  expect([reads("/moves"), reads("/projects")]).toEqual([1, 1]);

  // A snapshot can follow a time without the socket, so it has every move and project.
  await emit(sockets()[0], { type: "snapshot", tasks: listed, moves: [move("Deploy", true)], costs: [], projects: [project("Pushed")] });
  expect([runs, projects]).toEqual([["Deploy:live"], ["Pushed"]]);
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect([reads("/moves"), reads("/projects")]).toEqual([1, 1]);

  // A frame without projects keeps them.
  const [beforeRows, beforeProjects] = [rows, projectRows];
  await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [], moves: [move("Deploy", false)] });
  expect(runs).toEqual(["Deploy:ended"]);
  expect(rows).toBe(beforeRows);
  expect(projectRows).toBe(beforeProjects);

  await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [], projects: [project("Pushed"), project("Added")] });
  expect(projects).toEqual(["Pushed", "Added"]);
  expect(projectRows?.[0]).toBe(beforeProjects?.[0]);
  expect([reads("/moves"), reads("/projects")]).toEqual([1, 1]);
});

test("a closed or silent socket polls again and connects again", async () => {
  await render();
  await emit(sockets()[0], { type: "snapshot", tasks: listed, moves: [] });
  await act(async () => sockets()[0]?.close());
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(lists()).toBe(2);
  expect(sockets()).toHaveLength(2);

  await emit(sockets()[1], { type: "snapshot", tasks: listed, moves: [] });
  const reads = lists();
  await act(async () => vi.advanceTimersByTimeAsync(44_000));
  expect([lists(), sockets().length]).toEqual([reads, 2]);
  // The server sends a frame every 15 seconds. This socket sent none for 45 seconds.
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(sockets()).toHaveLength(3);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(lists()).toBeGreaterThan(reads);
});

test("without a socket the lists load and poll over HTTP", async () => {
  vi.stubGlobal("WebSocket", undefined);
  await render(true);
  expect([titles(), projects]).toEqual([["a", "b"], ["Repository"]]);
  listed = [row("a", "Changed")];
  projectNames = ["Renamed"];
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect([titles(), projects]).toEqual([["Changed"], ["Renamed"]]);
  expect([lists(), reads("/projects")]).toEqual([2, 2]);
});

test("a list read in flight does not replace a pushed state", async () => {
  const pending: Array<() => void> = [];
  fetch.mockImplementation((url: string) => url.includes("/tasks?") || url.endsWith("/projects") ? new Promise<Response>(resolve => pending.push(() => resolve(new Response(JSON.stringify({ tasks: [row("a", "Old")], projects: [project("Old")] }))))) : Promise.resolve(new Response('{"tasks":[],"moves":[]}')));
  await render(true);
  await emit(sockets()[0], { type: "snapshot", tasks: [row("a", "Pushed")], moves: [], costs: [], projects: [project("Pushed")] });
  expect(pending).toHaveLength(2);
  await act(async () => { for (const release of pending) release(); });
  expect([titles(), projects]).toEqual([["Pushed"], ["Pushed"]]);
});

let agentRows: unknown;
function ListAgents() {
  agentRows = useTaskAgents((useTaskData().data ?? []).map(task => task.id)).data;
  return <Capture />;
}

test("a company change closes the socket, sends no stale watch, and ignores late frames", async () => {
  const renderAgents = () => act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><ListAgents /></TaskDataProvider></QueryClientProvider>));
  await renderAgents();
  const first = sockets()[0];
  await act(async () => first?.open());
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(first?.sent).toEqual([{ type: "watch", agentTaskIds: ["a", "b"], openTaskId: null }]);
  scope.companyId = "company-b";
  listed = [row("c")];
  await renderAgents();
  expect(sockets()).toHaveLength(2);
  expect(sockets()[1]?.url).toContain("/api/companies/company-b/sync");
  await act(async () => sockets()[1]?.open());
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(sockets()[1]?.sent).toEqual([{ type: "watch", agentTaskIds: ["c"], openTaskId: null }]);
  expect(first?.sent).toHaveLength(1);
  await emit(first, { type: "snapshot", tasks: [row("a", "Company A")], moves: [], costs: [] });
  await emit(first, { type: "agents", tasks: [{ taskId: "c", setup: { state: "none", exitStatus: null }, agents: [agent("working")] }] });
  expect(titles()).toEqual(["c"]);
  expect(agentRows).toEqual([]);
});

function Watch({ agents, open }: { agents: string[]; open?: string }) {
  useTaskAgents(agents);
  useTask(open);
  return null;
}
const watch = (agentTaskIds: string[], openTaskId: string | null = "a") => ({ type: "watch", agentTaskIds, openTaskId });

test("components declare what they show, and the merged watch goes out once per change and again after a reconnect", async () => {
  const page = (first: string[], second?: string[], open?: string) => act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><Watch agents={first} {...(open ? { open } : {})} />{second ? <Watch agents={second} /> : null}</TaskDataProvider></QueryClientProvider>));
  await page(["b", "a"], ["c", "a"], "a");
  await act(async () => sockets()[0]?.open());
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(sockets()[0]?.sent).toEqual([watch(["a", "b", "c"])]);
  // The same declarations send nothing. A burst of changes sends one frame.
  await page(["a", "b"], ["a", "c"], "a");
  await page(["a"], ["d"], "a");
  await page(["a"], ["e"], "a");
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(sockets()[0]?.sent).toEqual([watch(["a", "b", "c"]), watch(["a", "e"])]);
  // A new connection receives the current watch again.
  await act(async () => sockets()[0]?.close());
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => sockets()[1]?.open());
  expect(sockets()[1]?.sent).toEqual([watch(["a", "e"])]);
  // Without declarations, the server watches nothing.
  await page([]);
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(sockets()[1]?.sent).toEqual([watch(["a", "e"]), watch([], null)]);
});

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
function detail(title: string, updatedAt = "2026-09-08T00:00:00.000Z", changes: Partial<Task> = {}): Task {
  return {
    id: "a", title, companyId: "company-a", projectId: "project", issueKey: null, issue: null, artifacts: [], description: "", status: "active", deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "a", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [], dependsOn: [],
    createdAt: "2026-09-08T00:00:00.000Z", updatedAt, statusChangedAt: "2026-09-08T00:00:00.000Z", queuePriority: 0, archivedAt: null, ...changes,
  };
}
function agent(status: string) { return { id: "agent-1", role: "root", advisorRole: null, label: "Coordinator", paneId: null, status, statusChangedAt: null }; }
const cost = (value: number) => ({ id: "a", cost: value, partial: false, subsidized: false, unpriced: false });
const activity = (shellPaneId: string) => ({ sessions: [], turns: [], setup: { state: "none" as const, exitStatus: null }, shellPaneId });
const pullRequest = (headSha: string) => ({ repository: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1", headSha, state: "open", mergedAt: null }) satisfies Task["pullRequest"];

let served: { task: Task; agent: string; shell: string; cost: number };
function body(url: string): unknown {
  if (url.endsWith("/api/tasks/a")) return served.task;
  if (url.includes("/task-agents?")) return { tasks: [{ taskId: "a", setup: { state: "none", exitStatus: null }, agents: [agent(served.agent)] }] };
  if (url.endsWith("/task-costs")) return { tasks: [cost(served.cost)] };
  if (url.endsWith("/activity")) return activity(served.shell);
  if (url.endsWith("/execution")) return { sessions: [] };
  if (url.endsWith("/timeline")) return { tasks: [], unavailableSessions: 0 };
  if (url.endsWith("/diff/summary")) return { available: true, files: 1 };
  if (url.endsWith("/diff")) return { available: true, patch: "" };
  if (url.endsWith("/checks")) return { available: true, runs: [] };
  return { tasks: url.includes("/tasks?") ? listed : [], moves: [], projects: [] };
}
const respond = (url: string) => new Response(JSON.stringify(body(url)));
const read = (suffix: string) => fetch.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
const pageReads = () => ["/api/tasks/a", "/task-agents?taskId=a", "/activity", "/execution", "/timeline", "/task-costs"].map(read);

let seen: { title?: string | undefined; agent?: string | undefined; shell?: string | null | undefined; unavailable?: number | undefined; cost?: number | null | undefined } = {};
function TaskPage() {
  const task = useTask("a").data;
  const agents = useTaskAgents(["a"]).data;
  const shell = useTaskActivity("a").data?.shellPaneId;
  useTaskExecutionQuery("a");
  const unavailable = useTaskTimeline("a").data?.unavailableSessions;
  const costs = useTaskCosts("company-a");
  seen = { title: task?.title, agent: agents?.[0]?.agents[0]?.status, shell, unavailable, cost: costs.get("a")?.cost };
  return task ? <Work task={task} /> : null;
}
function Work({ task }: { task: Task }) {
  useTaskDiffSummary(task);
  useTaskDiff(task.id);
  useTaskChecks(task.pullRequest ? task.id : null, task.pullRequest && `${task.pullRequest.number}:${task.pullRequest.state}:${task.pullRequest.headSha}`);
  return null;
}
async function renderPage(read: (url: string) => Promise<Response> = async url => respond(url)): Promise<void> {
  served = { task: detail("Read"), agent: "working", shell: "read", cost: 1 };
  seen = {};
  fetch.mockImplementation(read);
  await act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><TaskPage /></TaskDataProvider></QueryClientProvider>));
}

test("agent, open task, and cost frames reach the components and stop their polls", async () => {
  await renderPage();
  expect(pageReads()).toEqual([1, 1, 1, 1, 1, 1]);
  expect(seen).toEqual({ title: "Read", agent: "working", shell: "read", unavailable: 0, cost: 1 });
  await act(async () => sockets()[0]?.open());
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(sockets()[0]?.sent).toEqual([watch(["a"])]);

  await emit(sockets()[0], { type: "snapshot", tasks: listed, moves: [], costs: [cost(2)] });
  await emit(sockets()[0], { type: "agents", tasks: [{ taskId: "a", setup: { state: "none", exitStatus: null }, agents: [agent("idle")] }] });
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: detail("Pushed", "2026-09-09T00:00:00.000Z"), activity: activity("pushed"), execution: { sessions: [] }, timeline: { tasks: [], unavailableSessions: 2 } });
  expect(seen).toEqual({ title: "Pushed", agent: "idle", shell: "pushed", unavailable: 2, cost: 2 });
  await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [], costs: [cost(3)] });
  expect(seen.cost).toBe(3);

  // The server sends a heartbeat every 15 seconds.
  for (let beat = 0; beat < 3; beat++) {
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [] });
  }
  await act(async () => vi.advanceTimersByTimeAsync(14_000));
  expect(pageReads()).toEqual([1, 1, 1, 1, 1, 1]);
  // The slow read repairs a missed frame.
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(pageReads()).toEqual([2, 2, 2, 2, 2, 2]);
});

test("without a WebSocket every request polls as before", async () => {
  vi.stubGlobal("WebSocket", undefined);
  await renderPage();
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(pageReads()).toEqual([1, 1, 1, 1, 1, 1]);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(pageReads()).toEqual([2, 2, 2, 1, 1, 1]);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(pageReads()).toEqual([2, 2, 2, 2, 2, 1]);
  await act(async () => vi.advanceTimersByTimeAsync(25_000));
  expect(pageReads()).toEqual([11, 11, 11, 7, 7, 2]);
  expect([read("/diff/summary"), read("/diff")]).toEqual([7, 7]);
});

test("a read in flight does not replace a pushed value", async () => {
  const pending: Array<() => void> = [];
  const slow = ["/api/tasks/a", "/task-agents?taskId=a", "/activity", "/task-costs"];
  await renderPage(url => slow.some(suffix => url.endsWith(suffix)) ? new Promise<Response>(resolve => pending.push(() => resolve(respond(url)))) : Promise.resolve(respond(url)));
  const socket = sockets()[0];
  await emit(socket, { type: "snapshot", tasks: listed, moves: [], costs: [cost(2)] });
  await emit(socket, { type: "agents", tasks: [{ taskId: "a", setup: { state: "none", exitStatus: null }, agents: [agent("idle")] }] });
  await emit(socket, { type: "openTask", taskId: "a", task: detail("Pushed"), activity: activity("pushed") });
  expect(pending).toHaveLength(4);
  await act(async () => { for (const release of pending) release(); });
  expect(seen).toMatchObject({ title: "Pushed", agent: "idle", shell: "pushed", cost: 2 });
});

test("a command response and a pushed task resolve by updatedAt", async () => {
  await renderPage();
  await emit(sockets()[0], { type: "snapshot", tasks: listed, moves: [], costs: [] });
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: detail("Pushed", "2026-09-09T00:00:00.000Z") });
  await act(async () => updateTaskCache(client, "user-a", detail("Older command", "2026-09-08T12:00:00.000Z")));
  expect(seen.title).toBe("Pushed");
  await act(async () => updateTaskCache(client, "user-a", detail("Newer command", "2026-09-10T00:00:00.000Z")));
  expect(seen.title).toBe("Newer command");
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: detail("Older push", "2026-09-09T00:00:00.000Z") });
  expect(seen.title).toBe("Newer command");
});

test("a pushed change of the task or of the agents' work reads the diff again, and a pull request change reads the checks again", async () => {
  await renderPage();
  await act(async () => sockets()[0]?.open());
  await emit(sockets()[0], { type: "snapshot", tasks: listed, moves: [], costs: [] });
  // The first frame after a watch repeats what the page read over HTTP.
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: served.task, activity: activity("read"), execution: { sessions: [] }, timeline: { tasks: [], unavailableSessions: 0 } });
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(read("/diff/summary")).toBe(1);

  await emit(sockets()[0], { type: "openTask", taskId: "a", execution: { sessions: [{ id: "session" }] } });
  expect(read("/diff/summary")).toBe(2);
  // A new worktree head keeps updatedAt. It follows a read less than 5 seconds ago, so it waits.
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: detail("Read", undefined, { worktree: { path: "/worktrees/a", branch: "a", baseSha: "a".repeat(40), headSha: "b".repeat(40), dirty: false } }) });
  expect(read("/diff/summary")).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(read("/diff/summary")).toBe(3);

  expect(read("/checks")).toBe(0);
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: detail("Read", undefined, { pullRequest: pullRequest("c".repeat(40)) }) });
  expect(read("/checks")).toBe(1);
  await emit(sockets()[0], { type: "openTask", taskId: "a", task: detail("Read", undefined, { pullRequest: pullRequest("d".repeat(40)) }) });
  expect(read("/checks")).toBe(2);
});

test("a burst of pushed changes reads the diff at most once in 5 seconds and once after the last change", async () => {
  await renderPage();
  await act(async () => sockets()[0]?.open());
  await emit(sockets()[0], { type: "snapshot", tasks: listed, moves: [], costs: [], projects: [] });
  const diffs = () => [read("/diff/summary"), read("/diff")];
  expect(diffs()).toEqual([1, 1]);
  // One change each second for 10 seconds, of the task or of the agents' work.
  const counts: number[] = [];
  for (let step = 1; step <= 10; step++) {
    await emit(sockets()[0], step % 2 ? { type: "openTask", taskId: "a", task: detail(`Step ${step}`) } : { type: "openTask", taskId: "a", execution: { sessions: [{ id: `session-${step}` }] } });
    counts.push(read("/diff/summary"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
  }
  expect(counts).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
  expect(diffs()).toEqual([4, 4]);
  // Without changes, only the 60 second repair reads the diff.
  await act(async () => vi.advanceTimersByTimeAsync(45_000));
  expect(diffs()).toEqual([4, 4]);
});

test("the run page follows the pushed last run of its move and polls an earlier run", async () => {
  const run = (id: string, live: boolean) => ({ id, moveId: "deploy", moveName: "Deploy", runner: "script" as const, prompt: "", inputs: {}, excludedPullRequests: [], outcomes: [], startedBy: null, startedById: null, startedAt: "2026-09-08T00:00:00.000Z", live });
  const deploy = (live: boolean) => ({ id: "deploy", companyId: "company-a", projectId: "project", name: "Deploy", prompt: "", runner: "script", profileId: null, confirm: false, workflow: "standard", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", inputs: [], lastRun: run("run-2", live), createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" }) satisfies MoveResponse;
  fetch.mockImplementation(async url => new Response(JSON.stringify(url.includes("/api/move-runs/") ? run(url.split("/").at(-1) ?? "", true) : { tasks: [], moves: [deploy(true)], projects: [] })));
  const show = (runId: string) => act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><MoveRunView key={runId} move={deploy(true)} runId={runId} project={undefined} onClose={() => undefined} onStartAgain={() => undefined} /></TaskDataProvider></QueryClientProvider>));
  await show("run-2");
  await emit(sockets()[0], { type: "snapshot", tasks: [], moves: [deploy(true)], costs: [] });
  const runReads = () => read("/api/move-runs/run-2");
  const before = runReads();
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(runReads()).toBe(before);
  expect(container.textContent).toContain("Terminal");
  await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [], moves: [deploy(false)] });
  expect(container.textContent).toContain("Ended");
  expect(container.textContent).toContain("Transcript");

  // An earlier run is not a last run, so it polls.
  await show("run-1");
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(read("/api/move-runs/run-1")).toBe(3);
});

test("while the socket is open, an unchanged running timeline stays current", async () => {
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const timeline = { tasks: [{ id: "a", projectId: "project", issueKey: null, title: "Task", activity: [{ id: "execution", role: "root", advisorRole: null, label: "Coordinator", agentId: "agent", agentName: "Agent", avatarSeed: "agent", status: "running", attempt: 1, startedAt, finishedAt: null }] }], unavailableSessions: 0 };
  fetch.mockImplementation(async url => new Response(JSON.stringify(url.endsWith("/timeline") ? timeline : { tasks: [], moves: [], projects: [] })));
  await act(async () => root.render(<QueryClientProvider client={client}><TaskDataProvider><TaskActivityTimeline taskId="a" createdAt="2026-09-08T00:00:00.000Z" /></TaskDataProvider></QueryClientProvider>));
  await emit(sockets()[0], { type: "snapshot", tasks: [], moves: [], costs: [] });
  for (let beat = 0; beat < 2; beat++) {
    await act(async () => vi.advanceTimersByTimeAsync(14_000));
    await emit(sockets()[0], { type: "changes", tasks: [], removedTaskIds: [] });
  }
  expect(read("/timeline")).toBe(1);
  expect(container.querySelector('[data-task-timing="root"]')?.getAttribute("data-task-timing-active")).toBe("true");
});
