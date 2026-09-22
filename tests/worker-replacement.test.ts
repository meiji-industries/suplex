import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { RootController } from "../src/coordination/root-controller.js";
import { RootBridge } from "../src/coordination/root-bridge.js";
import { join } from "node:path";

afterEach(cleanupRootControllerFixtures);

test("replacement preserves the dedicated login and rejects a disallowed provider", async () => {
  const f = await assigned();
  f.database.authTransaction(db => {
    db.prepare("INSERT INTO suplex_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES ('client', 'claude-code', 'Client', '/dedicated/client', 'now', 'now')").run();
    db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, provider_instance_id, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('client-worker', 'Client', 'worker', 'seed', 'claude-code', 'client', 'sonnet', 'high', 'default', 'now', 'now')").run();
    db.prepare("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.providerPolicy', json(?)) WHERE id = 'task'").run(JSON.stringify({ allowedProviders: ["claude-code"], allowedInstanceIds: ["client"] }));
  });
  expect(() => f.store.replaceWorker("task", { sessionId: f.old.id, workerProfileId: "profile_native_worker", reason: "Change model" })).toThrow("allowed by this project");
  const replacement = f.store.replaceWorker("task", { sessionId: f.old.id, workerProfileId: "client-worker", reason: "Use client login" });
  expect(replacement.profile).toMatchObject({ providerInstanceId: "client", instanceHomeDirectory: "/dedicated/client" });
  expect(f.store.replaceWorker("task", { sessionId: replacement.id, reason: "Fresh session" }).profile).toEqual(replacement.profile);
});
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
  const database = new SuplexDatabase(join(f.directory, "suplex.sqlite"));
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
  f.database.authTransaction(db => db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('replacement', 'Replacement', 'worker', 'replacement', 'claude-code', 'claude-model', 'high', 'default', ?, ?)").run(new Date().toISOString(), new Date().toISOString()));
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

test("a Coordinator-initiated replacement keeps the previous Worker profile", async () => {
  const f = await assigned();
  f.database.authTransaction(db => db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('switched', 'Switched', 'worker', 'switched', 'claude-code', 'claude-model', 'high', 'default', ?, ?)").run(new Date().toISOString(), new Date().toISOString()));
  const switched = f.store.replaceWorker("task", { sessionId: f.old.id, workerProfileId: "switched", reason: "Human chose another agent" });
  expect(switched.profile).toMatchObject({ profileId: "switched", provider: "claude-code" });
  const configured = f.store.get("task").workerProfile;
  const bridge = new RootBridge(f.identity(), f.controller);
  await bridge.call({ kind: "replace_worker", sessionId: switched.id, reason: "Repeated partial returns", handoff: "Finish the behavior" });
  const worker = f.store.currentSession("task", "worker")!;
  expect(worker.id).not.toBe(switched.id);
  expect(worker.profile).toEqual(switched.profile);
  expect(f.store.get("task").workerProfile).toEqual(configured);
});

test("replacement of a previously stopped Worker requests a new native inspection", async () => {
  const f = await assigned();
  f.database.authTransaction(db => db.prepare("UPDATE suplex_task_sessions SET stopped_at = ?, lifecycle = 'stopped' WHERE id = ?").run(new Date().toISOString(), f.old.id));
  const next = f.store.replaceWorker("task", { sessionId: f.old.id, reason: "Fresh native session" });
  expect(f.store.workerReplacementReady(next.id)).toBe(false);
  expect((await f.store.pendingStops("task")).map(session => session.id)).toContain(f.old.id);
});
