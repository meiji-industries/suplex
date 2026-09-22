import { afterEach, expect, test, vi } from "vitest";
import { TaskHost } from "../src/tasks/host.js";
import type { GithubPullRequestObservation } from "../src/integrations/github/delivery.js";
import { nativeApp } from "./helpers/native-app.js";

const fixtures: Array<Awaited<ReturnType<typeof nativeApp>>> = [];
const observation = (number: number, state: "open" | "closed" | "merged"): GithubPullRequestObservation => ({ exists: true, number, url: `https://github.com/owner/repo/pull/${number}`, state, isDraft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: { total: 0, pending: 0, failing: 0, successful: 0, runs: [] }, autoMergeEnabled: false, reviewDecision: null, title: `Pull ${number}` });

async function fixture(states: Map<number, "open" | "closed" | "merged">) {
  const value = await nativeApp({ pullRequestObserver: { async observePullRequest(input) {
    const state = states.get(input.pullRequestNumber!);
    return state ? observation(input.pullRequestNumber!, state) : { ...observation(0, "open"), exists: false, number: null, url: null, state: null };
  } } });
  fixtures.push(value);
  return value;
}

async function create(f: Awaited<ReturnType<typeof nativeApp>>, title: string, number: number) {
  return (await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title, idempotencyKey: `pull-prerequisite-${number}-request`, startImmediately: true, blockedByPullRequests: [{ number }] })).task;
}
function host(f: Awaited<ReturnType<typeof nativeApp>>, observe: (number: number) => Promise<GithubPullRequestObservation>) {
  return new TaskHost(f.database, { completedPullRequests: { async refresh() {} }, controller: { prepareRoot() { throw new Error("not reached"); }, async recover() {} }, delivery: { async observe() { return null; } }, worktree: async () => { throw new Error("not reached"); }, pullRequestObserver: { async observePullRequest(input) { return observe(input.pullRequestNumber!); } } });
}

afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

test("an open pull request blocks until the host observes a merge", async () => {
  const states = new Map<number, "open" | "closed" | "merged">([[41, "open"]]); const f = await fixture(states);
  const task = await create(f, "Wait for pull", 41);
  expect(task).toMatchObject({ status: "backlog", blockedBy: [{ kind: "pull_request", number: 41, state: "open" }], queue: { waitingOn: [{ kind: "pull_request", number: 41, state: "open", reason: "prerequisite_pull_request_open" }] } });
  states.set(41, "merged");
  const taskHost = host(f, async number => observation(number, states.get(number)!));
  taskHost.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  await taskHost.stop();
  expect(f.tasks.getTask(f.userId, task.id)).toMatchObject({ status: "active", queue: { state: "running", waitingOn: [] } });
});

test("merged prerequisites do not block and missing pull requests are rejected without persistence", async () => {
  const states = new Map([[42, "merged" as const]]); const f = await fixture(states);
  const merged = await create(f, "Merged already", 42);
  expect(merged.status).toBe("active");
  await expect(f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Missing", idempotencyKey: "pull-prerequisite-missing", blockedByPullRequests: [{ number: 99 }] })).rejects.toThrow("Pull request #99 was not found");
  expect(f.tasks.listTasks(f.userId, f.company.id).map(task => task.title)).not.toContain("Missing");
});

test("a closed pull request stays blocked until a later merge observation", async () => {
  const states = new Map<number, "open" | "closed" | "merged">([[43, "closed"]]); const f = await fixture(states);
  const task = await create(f, "Closed prerequisite", 43);
  expect(f.tasks.getTask(f.userId, task.id).queue.waitingOn).toMatchObject([{ kind: "pull_request", number: 43, state: "closed", reason: "prerequisite_pull_request_closed", summary: expect.stringContaining("Reopen and merge") }]);
  states.set(43, "merged");
  const taskHost = host(f, async number => observation(number, states.get(number)!));
  taskHost.start(); await new Promise(resolve => setTimeout(resolve, 20)); await taskHost.stop();
  expect(f.tasks.getTask(f.userId, task.id)).toMatchObject({ status: "active", queue: { waitingOn: [] } });
});

test("set dependencies observes merged, rejects missing, and create reports observer failures", async () => {
  const states = new Map<number, "open" | "closed" | "merged">([[44, "merged"]]); const f = await fixture(states);
  const task = await create(f, "Set prerequisite", 44);
  const updated = await f.tasks.setTaskDependencies(f.userId, task.id, { dependsOn: [], blockedByPullRequests: [{ number: 44 }] });
  expect(updated).toMatchObject({ status: "active", blockedBy: [{ kind: "pull_request", number: 44, state: "merged" }] });
  await expect(f.tasks.setTaskDependencies(f.userId, task.id, { dependsOn: [], blockedByPullRequests: [{ number: 99 }] })).rejects.toThrow("Pull request #99 was not found");
  expect(f.tasks.getTask(f.userId, task.id).blockedBy).toMatchObject([{ number: 44 }]);
  const unavailable = await nativeApp({ pullRequestObserver: { async observePullRequest() { throw new Error("offline"); } } }); fixtures.push(unavailable);
  await expect(unavailable.tasks.createTask(unavailable.userId, unavailable.company.id, { projectId: unavailable.project.id, title: "Unavailable", idempotencyKey: "pull-prerequisite-offline", blockedByPullRequests: [{ number: 45 }] })).rejects.toThrow("Forge cannot observe pull request #45");
});

test("the host observes each queued pull request once per minute and never overlaps a refresh", async () => {
  const f = await fixture(new Map([[46, "open" as const]]));
  await create(f, "Throttle prerequisite", 46);
  vi.useFakeTimers();
  try {
    let calls = 0;
    let finishFirst: (() => void) | undefined;
    const first = new Promise<void>(resolve => { finishFirst = resolve; });
    const taskHost = host(f, async number => {
      calls++;
      if (calls === 1) await first;
      return observation(number, "open");
    });
    taskHost.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(1);
    finishFirst?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(3);
    await taskHost.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("a failed pull request refresh does not stop other queued rows", async () => {
  const states = new Map<number, "open" | "closed" | "merged">([[47, "open"], [48, "open"]]);
  const f = await fixture(states);
  const failed = await create(f, "Failed refresh", 47);
  const merged = await create(f, "Healthy refresh", 48);
  vi.useFakeTimers();
  try {
    const taskHost = host(f, async number => {
      if (number === 47) throw new Error("offline");
      return observation(number, "merged");
    });
    taskHost.start();
    await vi.advanceTimersByTimeAsync(0);
    await taskHost.stop();
    expect(f.tasks.getTask(f.userId, failed.id)).toMatchObject({ status: "backlog", queue: { waitingOn: [{ kind: "pull_request", number: 47, state: "open" }] } });
    expect(f.tasks.getTask(f.userId, merged.id)).toMatchObject({ status: "active", queue: { waitingOn: [] } });
  } finally {
    vi.useRealTimers();
  }
});
