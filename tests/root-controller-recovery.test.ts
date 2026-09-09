import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture, ageDispatch } from "./helpers/root-controller-fixture.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore, type ProcessOwnerObservation } from "../src/coordination/root-session-store.js";

afterEach(cleanupRootControllerFixtures);

test("session claims recover from PID reuse without stealing a live or uncertain owner", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  let observation: ProcessOwnerObservation = { kind: "running", startTime: "old-process-start" };
  const store = new TaskControlStore(value.database, async () => observation);
  const input = { sessionId: root.id, generation: root.generation };
  const first = await store.claimSessionOperation(input);
  expect(first).toBeTruthy();
  expect(await store.claimSessionOperation(input)).toBeNull();
  observation = { kind: "unknown" };
  expect(await store.claimSessionOperation(input)).toBeNull();
  observation = { kind: "running", startTime: "new-process-start" };
  const successor = await store.claimSessionOperation(input);
  expect(successor).toBeTruthy();
  expect(successor).not.toBe(first);
  store.releaseSessionOperation(root.id, first!);
  expect(store.currentSession("task", "root")?.launchOwner).toBe(successor);
  store.releaseSessionOperation(root.id, successor!);
  expect(store.currentSession("task", "root")?.launchOwner).toBeNull();
});

test("concurrent process-identity checks still admit one session owner", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  const store = new TaskControlStore(value.database, async () => ({ kind: "running", startTime: "one-process" }));
  const input = { sessionId: root.id, generation: root.generation };
  const owners = await Promise.all([store.claimSessionOperation(input), store.claimSessionOperation(input)]);
  expect(owners.filter(Boolean)).toHaveLength(1);
});

test("a crash after claiming but before posting fences the old server and submits the same intent once", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const turn = value.store.pendingTurns(root.id)[0]!;
  const owner = await value.store.claimSessionOperation({ sessionId: root.id, generation: root.generation });
  expect(value.store.claimPrompt({ taskId: "task", turnId: turn.id, serverGeneration: value.harness.serverGeneration, owner: owner!, usage: { estimatedCostUsd: 0, admittedTurns: 0 } })).toBe(true);
  value.store.releaseSessionOperation(root.id, owner!);
  await value.controller.recover("task");
  expect(value.harness.fenced).toEqual([]);
  expect(value.harness.dispatched).toEqual([]);
  ageDispatch(value.database, turn.id);
  await value.controller.recover("task");
  expect(value.harness.fenced).toEqual(["b775df17-718a-4cb2-8e23-6912b8aa0d39"]);
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.harness.dispatched[0]).toMatchObject({ messageID: turn.id, prompt: turn.promptText });
  expect(value.store.pendingTurns(root.id)[0]?.dispatchAttempt?.serverGeneration).toBe(value.harness.serverGeneration);
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
});

test("fence receipts cannot requeue another attempt or bypass the current session owner", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const turn = value.store.pendingTurns(root.id)[0]!;
  const owner = await value.store.claimSessionOperation({ sessionId: root.id, generation: root.generation });
  expect(value.store.claimPrompt({ taskId: "task", turnId: turn.id, serverGeneration: value.harness.serverGeneration, owner: owner!, usage: { estimatedCostUsd: 0, admittedTurns: 0 } })).toBe(true);
  const attempt = value.store.pendingTurns(root.id)[0]!.dispatchAttempt!;
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: "stale-owner" })).toBe(false);
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt: { ...attempt, serverGeneration: "c775df17-718a-4cb2-8e23-6912b8aa0d39" }, owner: owner! })).toBe(false);
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: owner! })).toBe(true);
  expect(value.store.claimPrompt({ taskId: "task", turnId: turn.id, serverGeneration: "c775df17-718a-4cb2-8e23-6912b8aa0d39", owner: owner!, usage: { estimatedCostUsd: 0, admittedTurns: 0 } })).toBe(true);
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: owner! })).toBe(false);
  value.store.cancel("task");
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: owner! })).toBe(false);
});

test("a proven stopped Coordinator execution queues one new continuation on the same native session", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const original = value.harness.dispatched[0]!;
  const observed = value.harness.observations.get(original.messageID)!;
  value.harness.observations.set(original.messageID, { ...observed, state: "interrupted", reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: value.harness.serverGeneration } });
  await Promise.all([value.controller.recover("task"), value.controller.recover("task")]);
  const pending = value.store.pendingTurns(value.identity().sessionId);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.id).not.toBe(original.messageID);
  expect(pending[0]?.promptText).toContain("preserve any partial work");
  expect(value.store.get("task").status).toBe("active");
  value.store.completeRootTurn(original.messageID, "duplicate receipt", "Duplicate continuation");
  expect(value.store.pendingTurns(value.identity().sessionId)).toHaveLength(1);
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(2);
  expect(value.harness.dispatched[1]?.sessionID).toBe(original.sessionID);
  expect(value.harness.dispatched.filter(intent => intent.messageID === original.messageID)).toHaveLength(1);
});

test("Coordinator resumes the same native session without reposting its prompt", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root");
  await new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => undefined).recover("task");
  expect(value.store.currentSession("task", "root")?.nativeSessionId).toBe(root?.nativeSessionId);
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.harness.dispatched[0]).toMatchObject({ agent: "forge-root", variant: "max", model: { providerID: "openai", modelID: "gpt-5.6-luna" } });
  expect(value.harness.dispatched[0]?.messageID).toMatch(/^msg_/);
});

test("a queued human note recovers without pane metadata or duplicate native dispatch", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  const note = value.store.wakeRoot({ taskId: "task", rootSessionId: root.id, generation: root.generation, prompt: "Human note:\nCheck the current result." });
  await value.controller.recover("task");
  expect(value.harness.dispatched).toMatchObject([{ messageID: note.id, prompt: note.promptText }]);
  value.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET pane_id = NULL WHERE id = ?").run(root.id));
  await new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => undefined).recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
});

test("a queued human note dispatches while Coordinator and Worker are busy after display metadata is recreated", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  await value.controller.recover("task");
  value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Continue the assigned work." });
  const note = value.store.wakeRoot({ taskId: "task", rootSessionId: root.id, generation: root.generation, prompt: "Human note:\nKeep the current work moving." });
  value.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET pane_id = NULL WHERE id = ?").run(root.id));
  expect(value.store.pendingTurns(root.id).map(turn => turn.id)).toContain(note.id);
  value.store.completeRootTurn(value.harness.dispatched[0]!.messageID, "root receipt", "Coordinator is busy");
  await new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => undefined).recover("task");
  expect(value.harness.dispatched.filter(intent => intent.messageID === note.id)).toHaveLength(1);
  await new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader, async () => undefined).recover("task");
  expect(value.harness.dispatched.filter(intent => intent.messageID === note.id)).toHaveLength(1);
});

test("concurrent controllers own only one native launch and prompt", async () => {
  const value = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const ensure = value.harness.ensureSession.bind(value.harness);
  value.harness.ensureSession = async (...args) => { entered(); await waiting; return ensure(...args); };
  const first = value.controller.recover("task");
  await started;
  await new RootController(new TaskControlStore(value.database), value.harness).recover("task");
  release();
  await first;
  expect(value.harness.dispatched).toHaveLength(1);
});

test.each(["admitted", "stop_failed", "cancelled"])("ambiguous dispatch recovery does not replay when %s", async condition => {
  const value = await fixture();
  value.harness.loseAcknowledgement = true;
  await expect(value.controller.recover("task")).rejects.toThrow("Lost prompt acknowledgement");
  const turn = value.store.pendingTurns(value.identity().sessionId)[0]!;
  ageDispatch(value.database, turn.id);
  value.harness.loseAcknowledgement = false;
  if (condition !== "admitted") value.harness.observations.clear();
  if (condition === "stop_failed") value.harness.failStop = true;
  if (condition === "cancelled") value.store.cancel("task");
  if (condition === "stop_failed") await expect(value.controller.recover("task")).rejects.toThrow("Dispatch server stop");
  else await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.harness.fenced).toEqual([]);
});

test.each([true, false])("lost acknowledgement is not replayed when native admission is %s", async (admitted) => {
  const value = await fixture();
  value.harness.loseAcknowledgement = true;
  await expect(value.controller.recover("task")).rejects.toThrow("Lost prompt acknowledgement");
  if (!admitted) value.harness.observations.clear();
  value.harness.loseAcknowledgement = false;
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
  const root = value.store.currentSession("task", "root")!;
  expect(value.store.pendingTurns(root.id)[0]?.status).toBe(admitted ? "prompted" : "unknown");
});
