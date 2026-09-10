import { afterEach, expect, test, vi } from "vitest";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import * as processes from "../src/tasks/archive/processes.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

afterEach(cleanupRootControllerFixtures);

test("backlog waits for a durable start and resumes after reopening the database", async () => {
  const value = await fixture(false);
  await value.controller.recover("task");
  expect(value.store.get("task").status).toBe("backlog");
  expect(value.harness.dispatched).toHaveLength(0);
  value.store.start("task");
  value.database.close();
  const reopened = new ForgeDatabase(join(value.directory, "forge.sqlite"));
  try {
    const store = new TaskControlStore(reopened);
    expect(store.start("task").status).toBe("active");
    await new RootController(store, value.harness).recover("task");
    expect(value.harness.dispatched).toHaveLength(1);
  } finally { reopened.close(); }
});

test("answers wake the same Coordinator atomically and stale answers cannot revive another question", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.askHuman(value.identity(), "Which branch should receive the change?", [{ label: "Main", description: "Use the project base", recommended: true }, { label: "Release", description: "Use the release branch", recommended: false }]);
  const first = value.store.get("task").humanQuestionId!;
  expect(first).toBeTruthy();
  value.store.answerHuman("task", first, "Use main.");
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(2);
  expect(value.harness.dispatched[1]).toMatchObject({ sessionID: value.harness.dispatched[0]!.sessionID });
  expect(value.harness.dispatched[1]!.prompt).toContain("Use main.");
  await value.controller.askHuman(value.identity(), "Publish a draft?", [{ label: "Yes", description: "Publish for review", recommended: true }, { label: "No", description: "Keep local", recommended: false }]);
  expect(() => value.store.answerHuman("task", first, "Stale response")).toThrow("question_identity_mismatch");
  expect(value.store.get("task")).toMatchObject({ status: "waiting_human", humanQuestion: "Publish a draft?" });
  value.store.cancel("task");
  expect(() => value.store.start("task")).toThrow("task_not_startable");
  expect(() => value.store.askHuman("task", "Late question")).toThrow("task_not_active");
  expect(value.store.get("task").status).toBe("cancelled");
});

test("start immediately survives closing Forge before the first native dispatch", async () => {
  const value = await fixture(true);
  expect(value.harness.dispatched).toHaveLength(0);
  value.database.close();
  const reopened = new ForgeDatabase(join(value.directory, "forge.sqlite"));
  try {
    await new RootController(new TaskControlStore(reopened), value.harness).recover("task");
    expect(value.harness.dispatched).toHaveLength(1);
  } finally { reopened.close(); }
});

test("cancellation fences dispatch before native abort and retries abort after restart", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root")!;
  value.harness.failStop = true;
  await expect(value.controller.cancel("task")).rejects.toThrow("Some agent sessions could not be stopped");
  expect(value.store.get("task").status).toBe("cancelled");
  expect(value.store.currentSession("task", "root")).toBeNull();
  value.harness.failStop = false;
  await new RootController(new TaskControlStore(value.database), value.harness).recover("task");
  expect(value.harness.stopped).toEqual([root.nativeSessionId]);
  await value.controller.recover("task");
  expect(value.harness.stopped).toHaveLength(1);
  expect(value.harness.dispatched).toHaveLength(1);
});

test("native Coordinator errors ask for a specific intervention instead of consuming repeated turns", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID, "error");
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.store.get("task").status).toBe("waiting_human");
  expect(value.store.get("task").humanQuestion).toContain("The agent stopped");
  expect(value.harness.dispatched).toHaveLength(1);
});

test("cancellation waits for an in-flight dispatch to settle before aborting", async () => {
  const value = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const dispatch = value.harness.dispatch.bind(value.harness);
  value.harness.dispatch = async (...args) => {
    const result = await dispatch(...args);
    entered();
    await waiting;
    return result;
  };
  const recovering = value.controller.recover("task");
  await admitted;
  await value.controller.cancel("task");
  expect(value.harness.stopped).toHaveLength(0);
  release();
  await recovering;
  await value.controller.recover("task");
  expect(value.harness.stopped).toHaveLength(1);
  expect(value.harness.dispatched).toHaveLength(1);
});

test("delivery retires the Coordinator server without another model turn", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root")!;
  value.store.markDelivered("task");
  await value.controller.recover("task");
  expect(value.harness.stopped).toEqual([root.nativeSessionId]);
  expect(value.store.currentSession("task", "root")).toBeNull();
  await value.controller.recover("task");
  expect(value.harness.stopped).toHaveLength(1);
  expect(value.harness.dispatched).toHaveLength(1);
});

test("an idle retained Worker does not gate Coordinator progress", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Make the change" });
  await value.controller.recover("task");
  const worker = value.store.currentSession("task", "worker")!;
  value.harness.finish(value.harness.dispatched.find(intent => intent.agent === "forge-worker")!.messageID);
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.harness.dispatched.filter(turn => turn.agent === "forge-root")).toHaveLength(2);
  expect(await value.store.pendingStops("task")).toEqual([]);
  expect(value.harness.stopped).not.toContain(worker.nativeSessionId);
});

test("Herdr display failure does not prevent native dispatch", async () => {
  const value = await fixture();
  value.harness.failAttachment = true;
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.store.currentSession("task", "root")).toMatchObject({ lifecycle: "live", paneId: null });
});

test("a finished Coordinator turn queues one continuation while its objective remains active", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  value.store.wakeIdleRoot("task");
  expect(value.store.pendingTurns(value.identity().sessionId)).toHaveLength(1);
  expect(value.store.pendingTurns(value.identity().sessionId)[0]?.status).toBe("pending_prompt");
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(2);
});

test("an interrupted Worker preserves dirty files and reports interruption to Coordinator", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Edit the file" });
  await value.controller.recover("task");
  await writeFile(join(value.directory, "dirty.txt"), "keep this work");
  value.harness.finish(value.harness.dispatched[1]!.messageID, "interrupted");
  await value.controller.recover("task");
  expect(await readFile(join(value.directory, "dirty.txt"), "utf8")).toBe("keep this work");
  expect(value.store.currentSession("task", "worker")?.lifecycle).toBe("live");
  expect(value.store.pendingTurns(value.identity().sessionId).some((turn) => turn.promptText.includes("Worker reported (interrupted)") && turn.promptText.includes("read_worker_evidence"))).toBe(true);
  expect(value.store.get("task").status).toBe("active");
});

test("cancellation prevents recovery and fences late Worker results", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Edit" });
  const worker = value.store.currentSession("task", "worker")!;
  value.store.cancel("task");
  await value.controller.recover("task");
  await expect(value.controller.recordWorkerResult({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "late", observation: "Late result" })).rejects.toThrow("stale_generation");
  expect(value.harness.dispatched).toHaveLength(1);
});

test.each(["root", "worker"] as const)("a crashed %s tool retains its turn until explicit cleanup confirmation", async kind => {
  const value = await fixture();
  await value.controller.recover("task");
  if (kind === "worker") {
    value.harness.finish(value.harness.dispatched[0]!.messageID);
    await value.controller.delegateWorker(value.identity(), { plan: "Update the scoped file using the existing implementation", acceptanceCriteria: ["The requested behavior passes its focused checks"], instruction: "Make the change" });
    await value.controller.recover("task");
  }
  const dispatched = value.harness.dispatched.at(-1)!;
  value.harness.observations.set(dispatched.messageID, { ...value.harness.observations.get(dispatched.messageID)!, state: "unknown", executionUncertain: { stoppedServerGeneration: value.harness.serverGeneration } });
  await value.controller.recover("task");
  const task = value.store.get("task");
  expect(task).toMatchObject({ status: "waiting_human", recoveryTurnId: dispatched.messageID });
  expect(value.store.turns("task").find(turn => turn.id === dispatched.messageID)?.status).toBe("prompted");
  expect(() => value.store.launchWorker({ taskId: "task", rootSessionId: value.identity().sessionId, rootGeneration: value.identity().generation, instruction: "Competing write" })).toThrow();
  expect(() => value.store.answerHuman("task", task.humanQuestionId!, "Proceed")).toThrow("command_cleanup_confirmation_required");
  expect(value.store.get("task").status).toBe("waiting_human");
  value.store.answerHuman("task", task.humanQuestionId!, "I stopped the old commands and checked the worktree.", true);
  expect(value.store.get("task")).toMatchObject({ status: "active", recoveryTurnId: null });
  expect(value.store.turns("task").find(turn => turn.id === dispatched.messageID)?.terminalObservation).toContain("operator_confirmed_commands_stopped");
  expect(() => value.store.answerHuman("task", task.humanQuestionId!, "Again", true)).toThrow("question_identity_mismatch");
  await value.controller.recover("task");
  expect(value.harness.dispatched.filter(turn => turn.messageID === dispatched.messageID)).toHaveLength(1);
  expect(value.harness.dispatched.at(-1)?.sessionID).toBe(value.harness.dispatched[0]?.sessionID);
});

test.each(["delivered", "cancelled"] as const)("a retained idle Worker is stopped when the task is %s", async terminalStatus => {
  const value = await fixture();
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root")!;
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), { plan: "Make the scoped change", acceptanceCriteria: ["The change is verified"], instruction: "Implement the change" });
  await value.controller.recover("task");
  const worker = value.store.currentSession("task", "worker")!;
  value.harness.finish(value.harness.dispatched.find(intent => intent.agent === "forge-worker")!.messageID);
  await value.controller.recover("task");
  expect(value.harness.stopped).toEqual([]);

  if (terminalStatus === "delivered") {
    value.store.markDelivered("task");
    await value.controller.recover("task");
  } else await value.controller.cancel("task");

  expect(value.harness.stopped).toHaveLength(2);
  expect(value.harness.stopped).toEqual(expect.arrayContaining([root.nativeSessionId, worker.nativeSessionId]));
});

test("cancellation retries detached command cleanup before recording the session stopped", async () => {
  const value = await fixture(true);
  await value.controller.recover("task");
  const cleanup = vi.spyOn(processes, "stopWorktreeProcesses").mockRejectedValueOnce(new Error("Command is still exiting")).mockResolvedValue();
  try {
    await expect(value.controller.cancel("task")).rejects.toThrow("Command is still exiting");
    expect(value.store.get("task").status).toBe("cancelled");
    expect(await value.store.pendingStops("task")).not.toHaveLength(0);
    await value.controller.recover("task");
    expect(cleanup).toHaveBeenCalledWith(value.directory);
    expect(await value.store.pendingStops("task")).toHaveLength(0);
  } finally { cleanup.mockRestore(); }
});

test("cancellation does not wait on an incomplete launch-owner record", async () => {
  const value = await fixture(true);
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root")!;
  value.database.authTransaction(db => db.prepare("UPDATE forge_task_sessions SET launch_owner_pid = ?, launch_owner_start_time = NULL WHERE id = ?").run(process.pid, root.id));
  await value.controller.cancel("task");
  expect(value.harness.stopped).toContain(root.nativeSessionId);
  expect(await value.store.pendingStops("task")).toHaveLength(0);
});
