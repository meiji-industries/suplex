import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ForgeDatabase } from "../src/database.js";
import { RootController } from "../src/root-controller.js";
import { TaskControlStore, type ProcessOwnerObservation } from "../src/root-session-store.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test("Root owns planning and review while Workers receive implementation assignments", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  expect(value.store.pendingTurns(root.id)[0]?.promptText).toContain("state your implementation plan and acceptance criteria before delegating");
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Implement the specified change" });
  expect(value.store.pendingTurns(worker.id)[0]?.promptText).toContain("Do not take over task planning or final review");
});

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
  expect(value.store.claimPrompt(turn.id, value.harness.serverGeneration, owner!)).toBe(true);
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

test("fence receipts cannot requeue another attempt or bypass the current session owner", async () => {
  const value = await fixture();
  const root = value.controller.prepareRoot("task");
  const turn = value.store.pendingTurns(root.id)[0]!;
  const owner = await value.store.claimSessionOperation({ sessionId: root.id, generation: root.generation });
  expect(value.store.claimPrompt(turn.id, value.harness.serverGeneration, owner!)).toBe(true);
  const attempt = value.store.pendingTurns(root.id)[0]!.dispatchAttempt!;
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: "stale-owner" })).toBe(false);
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt: { ...attempt, serverGeneration: "c775df17-718a-4cb2-8e23-6912b8aa0d39" }, owner: owner! })).toBe(false);
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: owner! })).toBe(true);
  expect(value.store.claimPrompt(turn.id, "c775df17-718a-4cb2-8e23-6912b8aa0d39", owner!)).toBe(true);
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: owner! })).toBe(false);
  value.store.cancel("task");
  expect(value.store.requeueFencedPrompt({ turnId: turn.id, attempt, owner: owner! })).toBe(false);
});

function ageDispatch(database: ForgeDatabase, turnId: string): void {
  database.authTransaction(db => db.prepare("UPDATE forge_task_turns SET dispatch_attempt_json = json_set(dispatch_attempt_json, '$.claimedAt', '2020-01-01T00:00:00.000Z') WHERE id = ?").run(turnId));
}

test("a proven stopped Root execution queues one new continuation on the same native session", async () => {
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

async function fixture(startImmediately = true) {
  const directory = await mkdtemp(join(tmpdir(), "forge-native-controller-"));
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  cleanups.push(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const stamp = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(directory, directory, stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
      insertNativeTaskRow(db);
  });
  const profile = { profileId: "profile", provider: "openai", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" } as const;
  const store = new TaskControlStore(database);
  store.create({ taskId: "task", startImmediately, objective: "Ship it", deliveryTarget: "merged", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", baselineSha: "a", pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: directory, branch: "task", baseSha: "a", headSha: "a", dirty: false } });
  const harness = new FakeTaskHarness();
  const controller = new RootController(store, harness);
  const identity = () => {
    const root = store.currentSession("task", "root");
    if (!root) throw new Error("Root not created");
    return { taskId: "task", sessionId: root.id, generation: root.generation };
  };
  return { directory, database, store, harness, controller, identity };
}

test.each(["root", "worker"] as const)("a crashed %s tool retains its turn until explicit cleanup confirmation", async kind => {
  const value = await fixture();
  await value.controller.recover("task");
  if (kind === "worker") {
    value.harness.finish(value.harness.dispatched[0]!.messageID);
    await value.controller.delegateWorker(value.identity(), "Make the change");
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

test("answers wake the same Root atomically and stale answers cannot revive another question", async () => {
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

test("Root resumes the same native session without reposting its prompt", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root");
  await new RootController(new TaskControlStore(value.database), value.harness).recover("task");
  expect(value.store.currentSession("task", "root")?.nativeSessionId).toBe(root?.nativeSessionId);
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.harness.dispatched[0]).toMatchObject({ agent: "forge-root", variant: "max", model: { providerID: "openai", modelID: "gpt-5.6-luna" } });
  expect(value.harness.dispatched[0]?.messageID).toMatch(/^msg_/);
});

test("cancellation fences dispatch before native abort and retries abort after restart", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  const root = value.store.currentSession("task", "root")!;
  value.harness.failStop = true;
  await expect(value.controller.cancel("task")).rejects.toThrow("Some OpenCode sessions could not be stopped");
  expect(value.store.get("task").status).toBe("cancelled");
  expect(value.store.currentSession("task", "root")).toBeNull();
  value.harness.failStop = false;
  await new RootController(new TaskControlStore(value.database), value.harness).recover("task");
  expect(value.harness.stopped).toEqual([root.nativeSessionId]);
  await value.controller.recover("task");
  expect(value.harness.stopped).toHaveLength(1);
  expect(value.harness.dispatched).toHaveLength(1);
});

test("native Root errors ask for a specific intervention instead of consuming repeated turns", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID, "error");
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.store.get("task").status).toBe("waiting_human");
  expect(value.store.get("task").humanQuestion).toContain("OpenCode");
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

test("delivery retires the Root server without another model turn", async () => {
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

test("completed Worker cleanup cannot gate Root progress", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.delegateWorker(value.identity(), "Make the change");
  const worker = value.store.currentSession("task", "worker")!;
  value.harness.finish(value.harness.dispatched[1]!.messageID);
  value.harness.failStop = true;
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.harness.dispatched.filter(turn => turn.agent === "forge-root")).toHaveLength(2);
  expect((await value.store.pendingStops("task")).map(session => session.id)).toEqual([worker.id]);
  value.harness.failStop = false;
  await value.controller.recover("task");
  expect(await value.store.pendingStops("task")).toEqual([]);
});

test("Herdr display failure does not prevent native dispatch", async () => {
  const value = await fixture();
  value.harness.failAttachment = true;
  await value.controller.recover("task");
  expect(value.harness.dispatched).toHaveLength(1);
  expect(value.store.currentSession("task", "root")).toMatchObject({ lifecycle: "live", paneId: null });
});

test("a finished Root turn queues one continuation while its objective remains active", async () => {
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

test("one completed Worker wakes Root once and allows the next assignment", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  value.harness.finish(value.harness.dispatched[0]!.messageID);
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), "Make the scoped change");
  await expect(value.controller.delegateWorker(value.identity(), "Duplicate work")).rejects.toThrow("worker_already_assigned");
  const worker = value.store.currentSession("task", "worker")!;
  value.harness.finish(value.harness.dispatched[1]!.messageID);
  await value.controller.recover("task");
  await value.controller.recover("task");
  await value.controller.recover("task");
  expect(value.store.currentSession("task", "worker")).toMatchObject({ id: worker.id, lifecycle: "stopped" });
  expect(value.harness.dispatched.filter((intent) => intent.agent === "forge-root")).toHaveLength(2);
  await value.controller.delegateWorker(value.identity(), "Next scoped change");
  expect(value.store.currentSession("task", "worker")?.generation).toBe(worker.generation + 1);
});

test("an interrupted Worker preserves dirty files and reports interruption to Root", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), "Edit the file");
  await writeFile(join(value.directory, "dirty.txt"), "keep this work");
  value.harness.finish(value.harness.dispatched[1]!.messageID, "interrupted");
  await value.controller.recover("task");
  expect(await readFile(join(value.directory, "dirty.txt"), "utf8")).toBe("keep this work");
  expect(value.store.currentSession("task", "worker")?.lifecycle).toBe("stopped");
  expect(value.store.pendingTurns(value.identity().sessionId).some((turn) => turn.promptText.includes('"state":"interrupted"'))).toBe(true);
  expect(value.store.get("task").status).toBe("active");
});

test("cancellation prevents recovery and fences late Worker results", async () => {
  const value = await fixture();
  await value.controller.recover("task");
  await value.controller.delegateWorker(value.identity(), "Edit");
  const worker = value.store.currentSession("task", "worker")!;
  value.store.cancel("task");
  await value.controller.recover("task");
  await expect(value.controller.recordWorkerResult({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "late", observation: "Late result" })).rejects.toThrow("stale_generation");
  expect(value.harness.dispatched).toHaveLength(2);
});
