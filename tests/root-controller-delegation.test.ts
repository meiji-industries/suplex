import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";

afterEach(cleanupRootControllerFixtures);

test("Coordinator defines the assignment while Worker owns implementation decisions", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  expect(value.store.pendingTurns(root.id)[0]?.promptText).toContain("objective, essential constraints, acceptance examples");
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Implement the specified change" });
  expect(value.store.pendingTurns(worker.id)[0]?.promptText).toContain("own the design and implementation choices within that assignment");
});
test("Coordinator handoff preserves its plan and review criteria in the Worker prompt", async () => {
  const value = await fixture();
  value.controller.prepareRoot("task");
  const delegated = await value.controller.delegateWorker(value.identity(), {
    plan: "Update the existing README heading; leave runtime code unchanged.",
    acceptanceCriteria: ["Only README.md changes", "The heading describes the current runtime"],
    instruction: "Apply the heading change and report the diff.",
  }) as { acceptedAssignment: { kind: string; prompt: string } };
  expect(delegated.acceptedAssignment).toMatchObject({ kind: "saved_prompt", prompt: expect.stringContaining("Update the existing README heading") });
  const worker = value.store.currentSession("task", "worker");
  expect(worker).not.toBeNull();
  const prompt = value.store.turns("task").find(turn => turn.sessionId === worker?.id)?.promptText;
  expect(prompt).toContain("Coordinator plan:\nUpdate the existing README heading");
  expect(prompt).toContain("1. Only README.md changes\n2. The heading describes the current runtime");
  expect(prompt).toContain("Worker instructions:\nApply the heading change");
  expect(prompt?.match(/For configured verification commands, set a 30-minute shell timeout, or the tool maximum if lower\. Normal completion ends the command immediately\./g)).toHaveLength(1);
});

test("a durable Worker assignment stays authoritative across reconstruction and a rejected competing plan", async () => {
  const value = await fixture();
  value.controller.prepareRoot("task");
  const ensure = value.harness.ensureSession.bind(value.harness);
  value.harness.ensureSession = async () => { throw new Error("OpenCode request timed out for /session"); };

  await expect(value.controller.delegateWorker(value.identity(), {
    plan: "Update the scoped source without changing unrelated behavior.",
    acceptanceCriteria: ["The focused check passes"],
    instruction: "Implement the scoped change.",
  })).resolves.toMatchObject({
    worker: { kind: "worker", lifecycle: "reserved" },
    acceptedAssignment: { kind: "saved_prompt", prompt: expect.stringContaining("Implement the scoped change.") },
  });
  expect(value.store.sessions("task").filter(session => session.kind === "worker")).toHaveLength(1);
  expect(value.store.turns("task").filter(turn => turn.sessionId === value.store.currentSession("task", "worker")?.id)).toHaveLength(1);
  await expect(value.controller.delegateWorker(value.identity(), {
    plan: "Start different work.",
    acceptanceCriteria: ["The other check passes"],
    instruction: "Dispatch a duplicate.",
  })).rejects.toThrow("worker_already_assigned");

  value.harness.ensureSession = ensure;
  const restarted = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, value.reader);
  await restarted.recover("task");
  await restarted.recover("task");
  expect(value.harness.dispatched.filter(intent => intent.agent === "suplex-worker")).toHaveLength(1);
});

test("one completed Worker wakes Coordinator once and allows the next assignment", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Make the scoped change" });
  await expect(value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Duplicate work" })).rejects.toThrow("worker_already_assigned");
  await value.controller.recover("task");
  const worker = value.store.currentSession("task", "worker")!;
  value.harness.finish(value.harness.dispatched.find(intent => intent.agent === "suplex-worker")!.messageID);
  await value.controller.recover("task");
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.store.currentSession("task", "worker")).toMatchObject({ id: worker.id, lifecycle: "live", launchOwner: null });
  expect(value.harness.dispatched.filter((intent) => intent.agent === "suplex-root")).toHaveLength(2);
  await value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Next scoped change" });
  expect(value.store.currentSession("task", "worker")?.generation).toBe(worker.generation + 1);
});

test("an interrupted Worker command wakes Coordinator once without replaying its admitted prompt", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Run the focused check", acceptanceCriteria: ["The check exits successfully"], instruction: "Check the change" });
  await value.controller.recover("task");
  const workerIntent = value.harness.dispatched.find(intent => intent.agent === "suplex-worker")!;
  const worktree = value.store.get("task").worktree;
  value.harness.finish(workerIntent.messageID, "interrupted", "Unfinished command item_0: make test-local. No exit result.");
  const interrupted = value.harness.observations.get(workerIntent.messageID)!;
  value.harness.observations.set(workerIntent.messageID, { ...interrupted, reason: "tool_execution_after_process_stopped", unsettledTools: true, interruptedExecution: { stoppedServerGeneration: value.harness.serverGeneration } });

  await value.controller.recover("task");
  await value.controller.recover("task");
  await value.controller.recover("task");

  expect(value.store.get("task")).toMatchObject({ status: "active", worktree });
  expect(value.harness.dispatched.filter(intent => intent.agent === "suplex-worker")).toHaveLength(1);
  const roots = value.harness.dispatched.filter(intent => intent.agent === "suplex-root");
  expect(roots).toHaveLength(2);
  expect(value.store.turns("task").filter(turn => turn.sessionId === value.store.currentSession("task", "root")?.id && turn.promptText.includes("Unfinished command item_0"))).toHaveLength(1);
  expect(value.store.turns("task").filter(turn => turn.sessionId === value.store.currentSession("task", "worker")?.id)).toHaveLength(1);
});

test("Coordinator reads bounded authoritative evidence for a historical Worker turn without stored observations", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Make the scoped change", acceptanceCriteria: ["The focused check passes"], instruction: "Implement and check it" });
  await value.controller.recover("task");
  const worker = value.store.currentSession("task", "worker")!;
  const workerIntent = value.harness.dispatched.find(intent => intent.agent === "suplex-worker")!;
  value.harness.finish(workerIntent.messageID);
  await value.controller.recover("task");
  const turn = value.store.turns("task").find(candidate => candidate.sessionId === worker.id)!;
  value.database.authTransaction(db => db.prepare("UPDATE suplex_task_turns SET status = 'unknown', terminal_observation = NULL, native_turn_id = NULL WHERE id = ?").run(turn.id));
  const calls: string[] = [];
  const output = "x".repeat(120_000);
  const controller = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, () => ({
    turnEvidence: async (session, turnId) => {
      calls.push(`${session.id}:${turnId}`);
      return { tools: [{ id: "native-tool-1", name: "bash", status: "completed" as const, input: { command: "pnpm test" }, output, error: null }], limitation: null };
    },
  }));
  const first = await controller.readWorkerEvidence(value.identity(), { turnId: turn.id, toolId: "native-tool-1", field: "output", position: "head", maxCharacters: 4096 });
  expect(calls).toEqual([`${worker.id}:${turn.id}`]);
  expect(first).toMatchObject({ kind: "tool", tool: { toolId: "native-tool-1", status: "completed" }, evidence: { text: "x".repeat(4096), truncatedAfter: true } });
  expect(first.nextCursor).not.toBeNull();
  const second = await controller.readWorkerEvidence(value.identity(), { turnId: turn.id, toolId: "native-tool-1", field: "output", position: "head", cursor: first.nextCursor!, maxCharacters: 4096 });
  expect(second).toMatchObject({ kind: "tool", tool: { toolId: "native-tool-1" }, evidence: { offset: 4096 } });
  expect(calls).toHaveLength(2);
  const unavailable = new RootController(new TaskControlStore(value.database), value.harness, undefined, undefined, undefined, () => ({ turnEvidence: async () => { throw new Error("Native session is unavailable"); } }));
  await expect(unavailable.readWorkerEvidence(value.identity(), { turnId: turn.id })).rejects.toThrow("Native session is unavailable");
});

test("sequential Worker assignments reuse one native session and pane across controller reconstruction", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Make the first scoped change", acceptanceCriteria: ["The first change is verified"], instruction: "Implement the first change" });
  await value.controller.recover("task");
  const firstWorker = value.store.currentSession("task", "worker")!;
  const firstWorkerIntent = value.harness.dispatched.find(intent => intent.agent === "suplex-worker")!;
  value.harness.finish(firstWorkerIntent.messageID);

  const restartedStore = new TaskControlStore(value.database);
  const restartedController = new RootController(restartedStore, value.harness, undefined, undefined, undefined, value.reader);
  await restartedController.recover("task");
  const idleWorker = restartedStore.currentSession("task", "worker")!;
  expect(idleWorker).toMatchObject({ id: firstWorker.id, nativeSessionId: firstWorker.nativeSessionId, paneId: firstWorker.paneId, lifecycle: "live" });
  expect(value.harness.stopped).not.toContain(firstWorker.nativeSessionId);
  const firstTurn = restartedStore.turns("task").find(turn => turn.id === firstWorkerIntent.messageID)!;
  expect(restartedStore.recordWorkerResultAndWake({ taskId: "task", sessionId: firstWorker.id, generation: firstWorker.generation, receiptId: firstTurn.resultReceiptId!, observation: firstTurn.terminalObservation! })).toEqual({ kind: "duplicate" });

  const root = restartedStore.currentSession("task", "root")!;
  const reviewTurn = restartedStore.pendingTurns(root.id)[0]!;
  restartedStore.completeRootTurn(reviewTurn.id, "Reviewed first assignment");
  restartedStore.wakeIdleRoot("task");
  expect(restartedStore.pendingTurns(root.id)).toHaveLength(1);

  await restartedController.delegateWorker({ taskId: "task", sessionId: root.id, generation: root.generation }, { plan: "Make the second scoped change", acceptanceCriteria: ["The second change is verified"], instruction: "Implement the second change" });
  await restartedController.recover("task");
  const secondWorker = restartedStore.currentSession("task", "worker")!;
  expect(secondWorker).toMatchObject({ id: firstWorker.id, nativeSessionId: firstWorker.nativeSessionId, paneId: firstWorker.paneId, generation: firstWorker.generation + 1 });
  expect(() => restartedStore.recordWorkerResultAndWake({ taskId: "task", sessionId: firstWorker.id, generation: firstWorker.generation, receiptId: firstTurn.resultReceiptId!, observation: firstTurn.terminalObservation! })).toThrow("stale_generation");

  const workerIntents = value.harness.dispatched.filter(intent => intent.agent === "suplex-worker");
  expect(workerIntents).toHaveLength(2);
  expect(new Set(workerIntents.map(intent => intent.sessionID))).toEqual(new Set([firstWorker.nativeSessionId]));
  expect(workerIntents[1]?.messageID).not.toBe(workerIntents[0]?.messageID);
  expect(restartedStore.sessions("task").filter(session => session.kind === "worker")).toHaveLength(1);
  expect(restartedStore.turns("task").filter(turn => turn.sessionId === firstWorker.id).map(turn => turn.generation)).toEqual([firstWorker.generation, secondWorker.generation]);

  value.harness.finish(workerIntents[1]!.messageID);
  await restartedController.recover("task");
  const secondTurn = restartedStore.turns("task").find(turn => turn.id === workerIntents[1]!.messageID)!;
  expect(restartedStore.recordWorkerResultAndWake({ taskId: "task", sessionId: secondWorker.id, generation: secondWorker.generation, receiptId: secondTurn.resultReceiptId!, observation: secondTurn.terminalObservation! })).toEqual({ kind: "duplicate" });
});

test("a Worker assignment cannot advance while its session operation is owned", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "First assignment" });
  value.store.recordWorkerResultAndWake({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "first-receipt", observation: "First result" });
  const owner = await value.store.claimSessionOperation({ sessionId: worker.id, generation: worker.generation });
  expect(owner).toBeTruthy();
  expect(() => value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Second assignment" })).toThrow("worker_already_assigned");
  value.store.releaseSessionOperation(worker.id, owner!);
  expect(value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Second assignment" })).toMatchObject({ id: worker.id, generation: worker.generation + 1 });
});

test("a legacy stopped Worker resumes its native conversation after cleanup completes", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Legacy assignment" });
  value.store.bindHarnessSession({ sessionId: worker.id, generation: worker.generation, nativeSessionId: "legacy-native-session" });
  value.store.bindPane({ sessionId: worker.id, generation: worker.generation, paneId: "legacy-pane" });
  value.store.recordWorkerResultAndWake({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "legacy-receipt", observation: "Legacy result" });
  value.database.authTransaction(db => db.prepare("UPDATE suplex_task_sessions SET lifecycle = 'stopped', stop_requested_at = updated_at, stopped_at = NULL WHERE id = ?").run(worker.id));
  expect(() => value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Blocked assignment" })).toThrow("worker_already_assigned");
  value.database.authTransaction(db => db.prepare("UPDATE suplex_task_sessions SET stopped_at = updated_at, launch_owner = 'legacy-owner', launch_owner_pid = 999999, launch_owner_start_time = 'legacy-start' WHERE id = ?").run(worker.id));
  const successor = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Current assignment" });
  expect(successor).toMatchObject({ id: worker.id, generation: worker.generation + 1, nativeSessionId: "legacy-native-session", paneId: "legacy-pane", lifecycle: "reserved", stopRequestedAt: null, stoppedAt: null });
  expect(value.store.sessions("task").filter(session => session.kind === "worker")).toHaveLength(1);
});

test("role reuse selects the highest generation even when an older session was updated later", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const older = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Older assignment" });
  value.store.bindHarnessSession({ sessionId: older.id, generation: older.generation, nativeSessionId: "older-native" });
  value.store.bindPane({ sessionId: older.id, generation: older.generation, paneId: "older-pane" });
  value.store.recordWorkerResultAndWake({ taskId: "task", sessionId: older.id, generation: older.generation, receiptId: "older-receipt", observation: "Older result" });
  value.database.authTransaction(db => {
    db.prepare("UPDATE suplex_task_sessions SET is_current = 0, updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(older.id);
    db.prepare("INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, pane_id, native_session_id, lifecycle, assignment_hash, created_at, updated_at) VALUES ('newer-worker', 'task', 'worker', 2, 1, 'newer-pane', 'newer-native', 'live', 'newer-assignment', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  });
  const reused = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Current assignment" });
  expect(reused).toMatchObject({ id: "newer-worker", generation: 3, nativeSessionId: "newer-native", paneId: "newer-pane" });
});

test("role reuse waits for cleanup of the newest conversation instead of falling back", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const older = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Older assignment" });
  value.store.recordWorkerResultAndWake({ taskId: "task", sessionId: older.id, generation: older.generation, receiptId: "older-receipt", observation: "Older result" });
  value.database.authTransaction(db => {
    db.prepare("UPDATE suplex_task_sessions SET is_current = 0 WHERE id = ?").run(older.id);
    db.prepare("INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, pane_id, native_session_id, lifecycle, assignment_hash, stop_requested_at, created_at, updated_at) VALUES ('cleanup-worker', 'task', 'worker', 2, 1, 'cleanup-pane', 'cleanup-native', 'stopped', 'cleanup-assignment', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  });
  const turnCount = value.store.turns("task").length;
  expect(() => value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Blocked assignment" })).toThrow("worker_already_assigned");
  expect(value.store.turns("task")).toHaveLength(turnCount);

  await value.controller.recover("task");
  expect(value.harness.stopped).toContain("cleanup-native");
  const reused = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Current assignment" });
  expect(reused).toMatchObject({ id: "cleanup-worker", generation: 3, nativeSessionId: "cleanup-native", paneId: "cleanup-pane" });
  expect(value.store.sessions("task").filter(session => session.kind === "worker")).toHaveLength(2);
});
