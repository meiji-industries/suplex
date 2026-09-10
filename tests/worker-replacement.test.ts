import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { RootController } from "../src/coordination/root-controller.js";
import { join } from "node:path";

afterEach(cleanupRootControllerFixtures);
const assignment = { plan: "Finish the feature", acceptanceCriteria: ["Complete behavior and tests"], instruction: "Preserve work and finish the implementation." };

async function assigned() {
  const f = await fixture();
  await f.controller.recover("task");
  f.harness.finish(f.harness.dispatched[0]!.messageID);
  await f.controller.delegateWorker(f.identity(), assignment);
  return { ...f, old: f.store.currentSession("task", "worker")! };
}

test("replacement cancels the queued continuation, preserves work and pauses, and is idempotent", async () => {
  const f = await assigned();
  f.store.pauseAtTaskLimit("task", { estimatedCostUsd: 999, admittedTurns: 1 });
  const limits = f.store.taskLimitState("task");
  const before = f.store.get("task");
  const request = { sessionId: f.old.id, reason: "Repeated partial returns", handoff: "Finish recovery and race tests." };
  const worker = f.store.replaceWorker("task", request);
  expect(worker).toMatchObject({ nativeSessionId: null, current: true, replacement: { sessionId: f.old.id, reason: request.reason } });
  expect(worker.id).not.toBe(f.old.id);
  expect(f.store.get("task")).toMatchObject({ status: before.status, humanQuestionId: before.humanQuestionId, worktree: before.worktree, limitPause: before.limitPause });
  expect(f.store.taskLimitState("task")).toEqual(limits);
  expect(f.store.pendingTurns(f.old.id)).toHaveLength(0);
  expect(f.store.pendingTurns(worker.id)).toHaveLength(1);
  expect(f.store.pendingTurns(worker.id)[0]!.promptText).toContain(assignment.instruction);
  expect(f.store.pendingTurns(worker.id)[0]!.promptText).toContain(request.handoff);
  expect(f.store.replaceWorker("task", request).id).toBe(worker.id);
  await f.controller.recover("task");
  expect(f.harness.dispatched).toHaveLength(1);
});

test("the new Worker waits for authoritative shutdown, then survives a database reopen", async () => {
  const f = await assigned();
  await f.controller.recover("task");
  const previous = f.store.currentSession("task", "worker")!;
  const replacement = f.store.replaceWorker("task", { sessionId: previous.id, reason: "Change strategy" });
  const originalStop = f.harness.stop.bind(f.harness);
  f.harness.stop = async () => { throw new Error("Native command still active"); };
  const before = f.harness.dispatched.length;
  await f.controller.recover("task");
  expect(f.harness.dispatched).toHaveLength(before);
  expect(f.store.workerReplacementReady(replacement.id)).toBe(false);
  f.harness.stop = originalStop;
  const database = new ForgeDatabase(join(f.directory, "forge.sqlite"));
  try {
    const store = new TaskControlStore(database);
    await new RootController(store, f.harness, undefined, undefined, undefined, f.reader, async () => undefined).recover("task");
    expect(store.workerReplacementReady(replacement.id)).toBe(true);
    expect(store.currentSession("task", "worker")!.nativeSessionId).not.toBe(previous.nativeSessionId);
    expect(f.harness.dispatched).toHaveLength(before + 1);
  } finally { database.close(); }
});

test("Coordinator replacement rejects another task's session and cannot change the budget", async () => {
  const f = await assigned();
  const before = f.store.get("task");
  await expect(f.controller.replaceWorker(f.identity(), { sessionId: "foreign", reason: "Retry" })).rejects.toThrow("does not belong");
  await expect(f.controller.replaceWorker(f.identity(), { sessionId: f.old.id, reason: "Try a fresh approach" })).resolves.toMatchObject({ worker: { nativeSessionId: null } });
  expect(f.store.get("task").status).toBe(before.status);
});

test("a profile change preserves the outgoing profile and repeated replacement handoffs stay concise", async () => {
  const f = await assigned();
  f.database.authTransaction(db => db.prepare("INSERT INTO forge_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('replacement', 'Replacement', 'worker', 'replacement', 'claude-code', 'claude-model', 'high', 'default', ?, ?)").run(new Date().toISOString(), new Date().toISOString()));
  const originalProfile = f.store.get("task").workerProfile;
  const worker = f.store.replaceWorker("task", { sessionId: f.old.id, workerProfileId: "replacement", reason: "Use another model" });
  expect(worker.profile).toMatchObject({ provider: "claude-code", model: "claude-model" });
  expect(f.store.sessions("task").find(s => s.id === f.old.id)!.profile).toEqual(originalProfile);
  const next = f.store.replaceWorker("task", { sessionId: worker.id, reason: "Correct the handoff", handoff: "One complete behavior." });
  const prompt = f.store.pendingTurns(next.id)[0]!.promptText;
  expect(prompt.match(/Fresh Worker handoff:/g)).toHaveLength(1);
  expect(f.store.workerReplacementReady(next.id)).toBe(false);
  expect(f.store.sessions("task")).toHaveLength(4);
});

test("replacement of a previously stopped Worker requests a new native inspection", async () => {
  const f = await assigned();
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET stopped_at = ?, lifecycle = 'stopped' WHERE id = ?").run(new Date().toISOString(), f.old.id));
  const next = f.store.replaceWorker("task", { sessionId: f.old.id, reason: "Fresh native session" });
  expect(f.store.workerReplacementReady(next.id)).toBe(false);
  expect((await f.store.pendingStops("task")).map(session => session.id)).toContain(f.old.id);
});
