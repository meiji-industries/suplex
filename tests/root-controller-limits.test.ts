import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture, usage } from "./helpers/root-controller-fixture.js";
import { updateEnvironmentSettings } from "../src/platform/environment-settings.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import type { ModelPricingCatalog } from "../src/profiles/model-pricing.js";
import { observeTaskLimitUsage } from "../src/tasks/limits/limit-observer.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";

afterEach(cleanupRootControllerFixtures);

test("a spend budget uses native usage and increases only after an explicit decision", async () => {
  const value = await fixture();
  updateEnvironmentSettings(value.database, { minFreeDiskGb: 5, defaultBudgetUsd: 15, defaultMaxTurns: 0 });
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root")!;
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  value.nativeUsage.set(root.id, [usage(root.nativeSessionId!, 20)]);
  value.database.authTransaction(db => db.prepare("INSERT INTO forge_task_usage (task_id, session_id, message_id, snapshot, observed_at) VALUES (?, 'stale-session', 'stale-message', ?, ?)").run("task", JSON.stringify(usage("stale-session", 100)), new Date().toISOString()));
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.store.get("task")).toMatchObject({ status: "waiting_human", humanQuestion: expect.stringContaining("budget") });
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.store.taskSpend("task").costUsd).toBe(20);
  expect(value.store.taskLimits("task")).toEqual({ budgetUsd: 15, maxTurns: 0 });
  expect(value.store.get("task").limitPause).toMatchObject({ usage: { estimatedCostUsd: 20, admittedTurns: 1 }, proposedLimits: { budgetUsd: 35, maxTurns: 0 } });
  expect(new TaskControlStore(value.database).get("task").limitPause).toEqual(value.store.get("task").limitPause);
  expect(() => value.store.answerHuman("task", value.store.get("task").humanQuestionId!, "Continue")).toThrow("task_limit_decision_required");

  value.store.answerTaskLimit("task", value.store.get("task").humanQuestionId!, { kind: "add_allowance" });
  expect(value.store.taskLimits("task")).toEqual({ budgetUsd: 35, maxTurns: 0 });
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(2);
});
test("native usage failure retries without asking the user or dispatching", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const first = value.harness.dispatched[0]!;
  value.harness.finish(first.messageID);
  await value.controller.recover("task");
  value.setUsageError(new Error("Native session is not available"));
  await expect(value.controller.recover("task")).rejects.toThrow("Native session is not available");
  expect(value.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  expect(value.harness.dispatched).toHaveLength(1);
  value.setUsageError(null);
  value.nativeUsage.set(value.store.currentSession("task", "root")!.id, [usage(first.sessionID, 1)]);
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(2);
});

test("missing model pricing preserves usage, permits dispatch, and retries pricing", async () => {
  const value = await fixture();
  let pricing: ModelPricingCatalog | undefined = new Map();
  const controller = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => pricing);
  await controller.recover("task");
  const first = value.harness.dispatched[0]!;
  value.harness.finish(first.messageID);
  await controller.recover("task");
  value.nativeUsage.set(value.store.currentSession("task", "root")!.id, [{ ...usage(first.sessionID, 0), tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]);
  await expect(observeTaskLimitUsage({ taskId: "task", store: value.store, reader: value.reader, readPricing: async () => pricing })).resolves.toEqual({ estimatedCostUsd: null, admittedTurns: 1 });
  await controller.recover("task");
  expect(value.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  expect(value.harness.dispatched).toHaveLength(2);
  const stored = value.database.authQuery(db => db.prepare("SELECT snapshot FROM forge_task_usage WHERE task_id = 'task'").get() as { snapshot: string });
  expect(JSON.parse(stored.snapshot)).toMatchObject({ cost: 0, tokens: { input: 100 } });

  value.harness.finish(value.harness.dispatched[1]!.messageID);
  await controller.recover("task");
  pricing = new Map([["openai/gpt-5.6-luna", { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }]]);
  await controller.recover("task");
  expect(value.store.get("task")).toMatchObject({ status: "waiting_human", limitPause: { reason: "budget", usage: { estimatedCostUsd: 20 } } });
  expect(value.store.taskSpend("task")).toEqual({ costUsd: 20, turns: 2 });
  expect(value.harness.dispatched).toHaveLength(2);
});

test("pricing lookup failure preserves usage and permits dispatch", async () => {
  const value = await fixture();
  const controller = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => { throw new Error("Pricing is offline"); });
  await controller.recover("task");
  const first = value.harness.dispatched[0]!;
  value.harness.finish(first.messageID);
  await controller.recover("task");
  value.nativeUsage.set(value.store.currentSession("task", "root")!.id, [{ ...usage(first.sessionID, 0), tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]);
  await controller.recover("task");
  expect(value.store.get("task")).toMatchObject({ status: "active", humanQuestion: null, limitPause: null });
  expect(value.harness.dispatched).toHaveLength(2);
  const stored = value.database.authQuery(db => db.prepare("SELECT snapshot FROM forge_task_usage WHERE task_id = 'task'").get() as { snapshot: string });
  expect(JSON.parse(stored.snapshot)).toMatchObject({ cost: 0, tokens: { input: 100 } });
});

test("known native cost enforces a budget when other usage is unpriced", async () => {
  const value = await fixture();
  const controller = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => new Map());
  await controller.recover("task");
  const first = value.harness.dispatched[0]!;
  value.harness.finish(first.messageID);
  await controller.recover("task");
  value.nativeUsage.set(value.store.currentSession("task", "root")!.id, [
    usage(first.sessionID, 15),
    { ...usage(first.sessionID, 0), messageId: "unpriced", tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  ]);
  await controller.recover("task");
  expect(value.store.get("task")).toMatchObject({ status: "waiting_human", limitPause: { reason: "budget", usage: { estimatedCostUsd: 15 } } });
  expect(value.store.taskSpend("task").costUsd).toBe(15);
  expect(value.harness.dispatched).toHaveLength(1);
});

test("native cost does not depend on the price catalog", async () => {
  const value = await fixture();
  const controller = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => { throw new Error("Pricing is offline"); });
  await controller.recover("task");
  const first = value.harness.dispatched[0]!;
  value.harness.finish(first.messageID);
  value.nativeUsage.set(value.store.currentSession("task", "root")!.id, [{ ...usage(first.sessionID, 20), tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]);
  await controller.recover("task");
  await controller.recover("task");
  expect(value.store.get("task")).toMatchObject({ status: "waiting_human", limitPause: { reason: "budget", usage: { estimatedCostUsd: 20 } } });
  expect(value.harness.dispatched).toHaveLength(1);
});

test("a known turn cap pauses without observing native cost", async () => {
  const value = await fixture();
  updateEnvironmentSettings(value.database, { minFreeDiskGb: 5, defaultBudgetUsd: 15, defaultMaxTurns: 1 });
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  value.setUsageError(new Error("Native session is unavailable"));
  await value.controller.recover("task");
  expect(value.store.get("task")).toMatchObject({
    status: "waiting_human",
    humanQuestion: expect.stringContaining("Estimated spend is not available"),
    limitPause: { reason: "turns", usage: { estimatedCostUsd: null, admittedTurns: 1 }, proposedLimits: { budgetUsd: 15, maxTurns: 2 } },
  });
  expect(value.harness.dispatched).toHaveLength(1);
});

test("turn admission is atomic across roles and counts cancelled admitted work", async () => {
  const value = await fixture();
  updateEnvironmentSettings(value.database, { minFreeDiskGb: 5, defaultBudgetUsd: 0, defaultMaxTurns: 1 });
  const root = value.controller.prepareRoot("task");
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Do the work" });
  const rootTurn = value.store.pendingTurns(root.id)[0]!;
  const workerTurn = value.store.pendingTurns(worker.id)[0]!;
  const rootOwner = await value.store.claimSessionOperation({ sessionId: root.id, generation: root.generation });
  const workerOwner = await value.store.claimSessionOperation({ sessionId: worker.id, generation: worker.generation });
  const limitUsage = { estimatedCostUsd: 0, admittedTurns: 0 };
  expect(value.store.claimPrompt({ taskId: "task", turnId: rootTurn.id, serverGeneration: value.harness.serverGeneration, owner: rootOwner!, usage: limitUsage })).toBe(true);
  expect(value.store.claimPrompt({ taskId: "task", turnId: workerTurn.id, serverGeneration: "c775df17-718a-4cb2-8e23-6912b8aa0d39", owner: workerOwner!, usage: limitUsage })).toBe(false);
  expect(value.store.get("task").status).toBe("active");
  value.store.markPrompted({ turnId: rootTurn.id, generation: root.generation });
  value.store.cancel("task");
  expect(value.store.taskSpend("task").turns).toBe(1);

  const queued = await fixture();
  queued.controller.prepareRoot("task");
  queued.store.cancel("task");
  expect(queued.store.taskSpend("task").turns).toBe(0);
});

test("a turn cap counts admitted turns but excludes queued prompts", async () => {
  const capped = await fixture();
  updateEnvironmentSettings(capped.database, { minFreeDiskGb: 5, defaultBudgetUsd: 0, defaultMaxTurns: 1 });
  await capped.controller.recover("task");
  expect(capped.harness.dispatched).toHaveLength(1);
  capped.harness.finish(capped.harness.dispatched[0]!.messageID);
  await capped.controller.recover("task");
  await capped.controller.recover("task");
  expect(capped.store.get("task")).toMatchObject({ status: "waiting_human", humanQuestion: expect.stringContaining("turn") });
  expect(capped.store.taskSpend("task").turns).toBe(1);
  expect(capped.harness.dispatched).toHaveLength(1);

  const unlimited = await fixture();
  updateEnvironmentSettings(unlimited.database, { minFreeDiskGb: 5, defaultBudgetUsd: 0, defaultMaxTurns: 0 });
  await unlimited.controller.recover("task");
  expect(unlimited.store.get("task").status).toBe("active");
  expect(unlimited.harness.dispatched).toHaveLength(1);
});

test("a limit answer supersedes only the unadmitted idle prompt while dependencies remain blocked", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");

  const profile = value.store.get("task").rootProfile;
  value.database.authTransaction(db => insertNativeTaskRow(db, { taskId: "limit-prerequisite", directory: value.directory }));
  value.store.create({ taskId: "limit-prerequisite", startImmediately: true, objective: "Prepare the limit dependency", deliveryTarget: "merged", deliveryIntent: { repository: "owner/repo", headBranch: "limit-prerequisite", baseBranch: "main", baselineSha: "a", pullRequestNumber: null }, rootProfile: profile, workerProfile: profile });
  value.database.authTransaction(db => db.prepare("INSERT INTO forge_task_dependencies (task_id, depends_on_task_id, created_at) VALUES ('task', 'limit-prerequisite', ?)").run(new Date().toISOString()));

  expect(value.store.pauseAtTaskLimit("task", { estimatedCostUsd: 999, admittedTurns: 1 })).toBe(true);
  value.store.answerTaskLimit("task", value.store.get("task").humanQuestionId!, { kind: "add_allowance" });
  for (let tick = 0; tick < 3; tick += 1) await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.store.taskSpend("task").turns).toBe(1);

  value.store.markDelivered("limit-prerequisite");
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(2);
  expect(value.harness.dispatched[1]?.prompt).toContain("add_allowance");
  expect(value.harness.dispatched[1]?.prompt).toContain('limit-prerequisite "Task" (delivered)');
  expect(value.store.pendingTurns(value.identity().sessionId).filter(turn => turn.status === "pending_prompt")).toHaveLength(0);
  expect(value.store.taskSpend("task").turns).toBe(2);
});
