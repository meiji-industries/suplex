import { expect, test } from "vitest";
import { OpenCodeMessageEnvelopeSchema } from "../src/opencode-contracts.js";
import { TaskUsageSchema, taskUsage } from "../src/task-usage.js";
import { TaskAnalyticsStore } from "../src/task-analytics-store.js";
import { nativeApp } from "./helpers/native-app.js";
import { TaskAnalyticsCollector } from "../src/task-analytics-collector.js";
import { usageMetrics } from "../src/task-analytics-metrics.js";
import type { ModelPricing } from "../src/model-pricing.js";

const tokens = { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } };
function message(completed = true, parts: unknown[] = [], cost = 3, providerID = "openai", modelID = "model", sessionID = "ses", messageID = "msg") {
  return OpenCodeMessageEnvelopeSchema.parse({ info: {
    id: messageID, sessionID, role: "assistant", time: { created: 100, ...(completed ? { completed: 200 } : {}) },
    parentID: "msg_user", modelID, providerID, mode: "primary", agent: "forge-root",
    path: { cwd: "/repo", root: "/repo" }, cost, tokens,
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

test("usage estimates zero-cost token usage from listed model prices", () => {
  const pricing = new Map<string, ModelPricing>([["openai/model", { input: 2, output: 5, cacheRead: 0.5, cacheWrite: 1 }]]);
  const entry = taskUsage([message(true, [], 0)], "root", pricing)[0];
  if (!entry) throw new Error("Missing usage fixture");
  expect(entry.cost).toBeCloseTo((10 * 2 + (20 + 30) * 5 + 40 * 0.5 + 50) / 1_000_000);
  expect(entry.subsidized).toBe(true);
  expect(usageMetrics([entry])).toMatchObject({ cost: entry.cost, subsidized: true, subsidizedMessages: 1, unpricedMessages: 0 });
});

test("native costs remain authoritative over listed model prices", () => {
  const pricing = new Map<string, ModelPricing>([["openai/model", { input: 2, output: 5, cacheRead: 0.5, cacheWrite: 1 }]]);
  expect(taskUsage([message(true, [], 3)], "root", pricing)).toMatchObject([{ cost: 3, subsidized: false }]);
});

test("zero-cost steps are estimated from listed prices instead of cumulative message cost", () => {
  const pricing = new Map<string, ModelPricing>([["openai/model", { input: 2, output: 5, cacheRead: 0.5, cacheWrite: 1 }]]);
  const step = { id: "one", sessionID: "ses", messageID: "msg", type: "step-finish", cost: 0, tokens };
  const entry = taskUsage([message(true, [step], 3)], "root", pricing)[0];
  if (!entry) throw new Error("Missing usage fixture");
  expect(entry.cost).toBeCloseTo(0.00034);
  expect(entry).toMatchObject({ subsidized: true, source: "steps" });
});

test("missing, zero and malformed prices leave token usage unpriced", () => {
  const zero = new Map<string, ModelPricing>([["openai/model", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]]);
  const malformed = new Map<string, ModelPricing>([["openai/model", { input: Number.NaN, output: 5, cacheRead: 0, cacheWrite: 0 }]]);
  for (const pricing of [undefined, zero, malformed]) {
    expect(taskUsage([message(true, [], 0)], "root", pricing)).toMatchObject([{ cost: 0, subsidized: false }]);
  }
});

test("old usage snapshots default to non-subsidized", () => {
  const current = taskUsage([message()], "root")[0];
  if (!current) throw new Error("Missing usage fixture");
  const oldSnapshot = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "subsidized"));
  expect(TaskUsageSchema.parse(oldSnapshot).subsidized).toBe(false);
});

test("collector captures final timings promptly after delivery instead of applying the historical refresh delay", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Final timing", description: "Finish collection", startImmediately: true, idempotencyKey: "final-timing" });
    const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    value.tasks.repository.controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses" });
    const store = new TaskAnalyticsStore(value.database);
    store.record(task.id, root.id, taskUsage([message(false)], "root"), new Date(Date.now() - 1000).toISOString());
    value.tasks.repository.controls.markDelivered(task.id);
    let reads = 0;
    const collector = new TaskAnalyticsCollector(value.tasks.repository, store, async () => { reads += 1; return [message()]; }, error => { throw error; });
    await collector.collect();
    expect(reads).toBe(1);
    expect(store.read(task.id).usage[0]?.completedAt).toBe(200);
    await collector.collect();
    expect(reads).toBe(1);
    await collector.stop();
  } finally { await value.close(); }
});

test("metrics count correlated turns once and union overlapping time in each session", () => {
  const first = taskUsage([message()], "root")[0];
  if (!first) throw new Error("Missing fixture");
  const result = usageMetrics([first, { ...first, messageId: "msg_next", startedAt: 150, completedAt: 250 }]);
  expect(result).toMatchObject({ turns: 1, rootTurns: 1, steps: 2, cost: 6, durationMs: 150 });
  expect(usageMetrics([]).cost).toBeNull();
  expect(usageMetrics([{ ...first, cost: 0 }])).toMatchObject({ cost: null, unpricedMessages: 1, measuredMessages: 1 });
});

test("mixed billed and subsidized entries are not wholly subsidized", () => {
  const pricing = new Map<string, ModelPricing>([["openai/model", { input: 2, output: 5, cacheRead: 0.5, cacheWrite: 1 }]]);
  const subsidized = taskUsage([message(true, [], 0, "openai", "model", "ses_subsidized", "msg_subsidized")], "root", pricing)[0];
  const billed = taskUsage([message(true, [], 3, "openai", "model", "ses_billed", "msg_billed")], "root", pricing)[0];
  if (!subsidized || !billed) throw new Error("Missing usage fixture");
  expect(usageMetrics([subsidized, billed])).toMatchObject({ cost: subsidized.cost + billed.cost, subsidized: false, subsidizedMessages: 1, unpricedMessages: 0 });
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

test("catalog failure cannot prevent message collection or task delivery", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Catalog isolation", description: "No gates", startImmediately: true, idempotencyKey: "analytics-pricing-isolation" });
    const controls = value.tasks.repository.controls;
    const root = controls.claimRoot({ taskId: task.id });
    controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_pricing" });
    const store = new TaskAnalyticsStore(value.database);
    const errors: unknown[] = [];
    const collector = new TaskAnalyticsCollector(value.tasks.repository, store, async () => [message(true, [], 0)], error => errors.push(error), async () => { throw new Error("models.dev offline"); });
    await collector.collect();
    expect(errors).toEqual([]);
    expect(store.read(task.id).usage).toMatchObject([{ cost: 0, subsidized: false }]);
    expect(controls.get(task.id).status).toBe("active");
    expect(controls.markDelivered(task.id).status).toBe("delivered");
    await collector.stop();
  } finally { await value.close(); }
});

test("task costs expose subsidy state without changing unpriced partial semantics", async () => {
  const value = await nativeApp();
  try {
    const listed = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Listed cost", description: "Listed", startImmediately: false, idempotencyKey: "analytics-listed-cost" });
    const unpriced = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Unpriced cost", description: "Unpriced", startImmediately: false, idempotencyKey: "analytics-unpriced-cost" });
    const store = new TaskAnalyticsStore(value.database);
    const pricing = new Map<string, ModelPricing>([["openai/model", { input: 2, output: 5, cacheRead: 0.5, cacheWrite: 1 }]]);
    store.record(listed.task.id, "listed-session", taskUsage([message(true, [], 0, "openai", "model", "ses_listed", "msg_listed")], "root", pricing));
    store.record(unpriced.task.id, "unpriced-session", taskUsage([message(true, [], 0, "openai", "model", "ses_unpriced", "msg_unpriced")], "root"));
    const response = await value.app.inject({ url: `/api/companies/${value.company.id}/task-costs`, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tasks: expect.arrayContaining([
      { id: listed.task.id, cost: expect.any(Number), unpriced: false, subsidized: true, partial: false },
      { id: unpriced.task.id, cost: null, unpriced: true, subsidized: false, partial: true },
    ]) });
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
