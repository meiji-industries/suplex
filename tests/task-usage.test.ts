import { expect, test } from "vitest";
import { OpenCodeMessageEnvelopeSchema } from "../src/opencode-contracts.js";
import { taskUsage } from "../src/task-usage.js";
import { TaskAnalyticsStore } from "../src/task-analytics-store.js";
import { nativeApp } from "./helpers/native-app.js";
import { TaskAnalyticsCollector } from "../src/task-analytics-collector.js";
import { usageMetrics } from "../src/task-analytics-metrics.js";

const tokens = { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } };
function message(completed = true, parts: unknown[] = []) {
  return OpenCodeMessageEnvelopeSchema.parse({ info: {
    id: "msg", sessionID: "ses", role: "assistant", time: { created: 100, ...(completed ? { completed: 200 } : {}) },
    parentID: "msg_user", modelID: "model", providerID: "openai", mode: "primary", agent: "forge-root",
    path: { cwd: "/repo", root: "/repo" }, cost: 3, tokens,
  }, parts });
}

test("usage sums unique step-finish parts instead of cumulative message costs", () => {
  const step = { id: "one", sessionID: "ses", messageID: "msg", type: "step-finish", cost: 1, tokens };
  expect(taskUsage([message(true, [step, step, { ...step, id: "two", cost: 2 }])], "root")).toMatchObject([
    { cost: 3, steps: 2, source: "steps", tokens: { input: 20, output: 40, reasoning: 60, cache: { read: 80, write: 100 } } },
  ]);
});

test("usage preserves unfinished and fallback evidence without inventing completion", () => {
  expect(taskUsage([message(false)], "worker")).toMatchObject([{ role: "worker", completedAt: null, steps: 0, source: "message" }]);
});

test("metrics count correlated turns once and union overlapping time in each session", () => {
  const first = taskUsage([message()], "root")[0];
  if (!first) throw new Error("Missing fixture");
  const result = usageMetrics([first, { ...first, messageId: "msg_next", startedAt: 150, completedAt: 250 }]);
  expect(result).toMatchObject({ turns: 1, rootTurns: 1, steps: 2, cost: 6, durationMs: 150 });
  expect(usageMetrics([]).cost).toBeNull();
  expect(usageMetrics([{ ...first, cost: 0 }])).toMatchObject({ cost: null, unpricedMessages: 1, measuredMessages: 1 });
});

test("analytics requires company access and cannot wake tasks", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Analytics", description: "Read only", startImmediately: false, idempotencyKey: "analytics-auth" });
    const route = `/api/companies/${value.company.id}/analytics`;
    expect((await value.app.inject({ url: route })).statusCode).toBe(401);
    expect((await value.app.inject({ url: "/api/companies/company_missing/analytics", headers: value.headers })).statusCode).toBe(404);
    const response = await value.app.inject({ url: route, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tasks: [{ id: task.id, usage: [] }] });
    expect(value.tasks.getTask(value.userId, task.id)).toEqual(task);
    expect(value.wakes).toEqual([]);
  } finally { await value.close(); }
});

test("collector failure and broken analytics storage cannot prevent task delivery", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Independent analytics", description: "No gates", startImmediately: true, idempotencyKey: "analytics-isolation" });
    const controls = value.tasks.repository.controls;
    const root = controls.claimRoot({ taskId: task.id });
    controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_test" });
    const store = new TaskAnalyticsStore(value.database);
    const errors: unknown[] = [];
    const collector = new TaskAnalyticsCollector(value.tasks.repository, store, async () => { throw new Error("OpenCode offline"); }, error => errors.push(error));
    await collector.collect();
    expect(errors).toHaveLength(1);
    expect(store.read(task.id).sessions[0]?.errorAt).not.toBeNull();
    expect(controls.get(task.id).status).toBe("active");
    value.database.authQuery(db => db.exec("DROP TABLE forge_task_analytics_events"));
    expect(controls.markDelivered(task.id).status).toBe("delivered");
    await collector.stop();
  } finally { await value.close(); }
});

test("durable usage replaces partial observations and survives archive", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Usage", description: "Usage", startImmediately: false, idempotencyKey: "usage-test" });
    const store = new TaskAnalyticsStore(value.database);
    store.record(task.id, "forge_session", taskUsage([message(false)], "root"));
    store.record(task.id, "forge_session", taskUsage([message()], "root"));
    store.record(task.id, "forge_session", taskUsage([message()], "root"));
    store.observe(task, "2026-09-01T00:00:00.000Z");
    store.observe(task, "2026-09-02T00:00:00.000Z");
    expect(store.read(task.id).usage).toHaveLength(1);
    expect(store.read(task.id).usage[0]).toMatchObject({ cost: 3, completedAt: 200 });
    expect(store.read(task.id).events).toHaveLength(1);
    store.failed(task.id, "forge_session");
    expect(store.read(task.id).usage).toHaveLength(1);
    await value.tasks.archiveTask(value.userId, task.id);
    expect(new TaskAnalyticsStore(value.database).read(task.id).usage).toHaveLength(1);
  } finally { await value.close(); }
});
