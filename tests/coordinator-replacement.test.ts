import { afterEach, expect, test } from "vitest";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import { withCurrentDependencyStatus } from "../src/coordination/workflow-prompts.js";

afterEach(cleanupRootControllerFixtures);

function addProfile(database: Awaited<ReturnType<typeof fixture>>["database"], id: string, provider = "codex") {
  database.authTransaction(db => db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES (?, ?, 'root', ?, ?, ?, 'medium', 'default', ?, ?)").run(id, id, id, provider, provider === "codex" ? "gpt-5.6-sol" : "opus", new Date().toISOString(), new Date().toISOString()));
}

test("replacement fences the old Coordinator, retries the stop, and starts one fresh turn", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  await f.controller.recover("task");
  const old = f.store.currentSession("task", "root")!;
  const oldProfile = f.store.get("task").rootProfile;
  f.database.authTransaction(db => db.prepare("UPDATE suplex_task_sessions SET pane_id = 'recreated-pane-token' WHERE id = ?").run(old.id));
  const request = { sessionId: old.id, rootProfileId: "new-root", handoff: "Check the failed provider.", resume: false } as const;
  const next = f.store.replaceCoordinator("task", request);
  expect(next).toMatchObject({ current: true, generation: old.generation + 1, profile: { provider: "codex" }, replacement: { sessionId: old.id } });
  expect(f.store.replaceCoordinator("task", request).id).toBe(next.id);
  expect(() => f.store.replaceCoordinator("task", { ...request, handoff: "Different direction" })).toThrow("Coordinator changed");
  expect(() => f.store.assertCurrentRoot({ taskId: "task", sessionId: old.id, generation: old.generation })).toThrow();
  const stop = f.harness.stop.bind(f.harness);
  f.harness.stop = async () => { throw new Error("stop failed"); };
  await f.controller.recover("task");
  expect(f.harness.dispatched).toHaveLength(1);
  f.harness.stop = stop;
  await f.controller.recover("task");
  await f.controller.recover("task");
  expect(f.harness.dispatched).toHaveLength(2);
  expect(f.harness.dispatched[1]?.messageID).toBe(f.store.pendingTurns(next.id)[0]?.id);
  expect(f.store.sessions("task").find(session => session.id === old.id)?.profile).toEqual(oldProfile);
});

test("a retired Coordinator cannot ask a question after its earlier ownership check", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  const old = f.controller.prepareRoot("task");
  f.store.assertCurrentRoot({ taskId: "task", sessionId: old.id, generation: old.generation });
  f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: false });
  await expect(f.controller.askHuman({ taskId: "task", sessionId: old.id, generation: old.generation }, "A stale question", [])).rejects.toThrow("stale_root");
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
});

test("a failed retired turn cannot pause the replacement after its completion", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  await f.controller.recover("task");
  const old = f.store.currentSession("task", "root")!;
  f.harness.finish(f.harness.dispatched[0]!.messageID, "error", "Provider stopped");
  const complete = f.store.completeRootTurn.bind(f.store);
  f.store.completeRootTurn = (...args) => {
    const completed = complete(...args);
    f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: false });
    return completed;
  };
  await f.controller.recover("task");
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  expect(f.store.currentSession("task", "root")?.id).not.toBe(old.id);
});

test("a cancelled old turn cannot ask a question after native result collection", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  await f.controller.recover("task");
  const old = f.store.currentSession("task", "root")!;
  f.harness.finish(f.harness.dispatched[0]!.messageID, "error", "Provider stopped");
  f.harness.resultText = async () => {
    f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: false });
    return "Provider stopped";
  };
  await f.controller.recover("task");
  expect(f.store.get("task")).toMatchObject({ status: "active", humanQuestion: null });
  expect(f.store.turns("task").find(turn => turn.sessionId === old.id)?.status).toBe("cancelled");
});

test("accepted answers, notes, and earlier additional direction survive multiple swaps", async () => {
  const f = await fixture();
  addProfile(f.database, "first-root");
  addProfile(f.database, "second-root", "claude-code");
  const old = f.controller.prepareRoot("task");
  f.store.askHuman("task", "Choose the release branch", [{ label: "Main", description: "Use main", recommended: true }]);
  const questionId = f.store.get("task").humanQuestionId!;
  f.store.answerHuman("task", questionId, "Use the maintenance branch");
  const answer = f.store.pendingTurns(old.id).find(turn => turn.promptText.includes("maintenance branch"))!;
  const admitted = withCurrentDependencyStatus(answer.promptText, [{ id: "prerequisite", title: "Prepare release", status: "active" }]);
  f.database.authTransaction(db => db.prepare("UPDATE suplex_task_turns SET prompt_text = ?, status = 'prompted', prompted_at = ? WHERE id = ?").run(admitted, new Date().toISOString(), answer.id));
  f.store.sendNote("task", "Keep the release notes intact.");
  const first = f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "first-root", handoff: "Use the release checklist.", resume: false });
  const second = f.store.replaceCoordinator("task", { sessionId: first.id, rootProfileId: "second-root", resume: false });
  const prompt = f.store.pendingTurns(second.id)[0]!.promptText;
  expect(prompt).toContain("Use the maintenance branch");
  expect(prompt).toContain("Keep the release notes intact.");
  expect(prompt).toContain("Use the release checklist.");
  expect(prompt.match(/Earlier additional directions from the user/g)).toHaveLength(1);
  expect(prompt).not.toContain("[Suplex prerequisite status]");
});

test("an existing Worker result wakes the replacement Coordinator", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  const root = f.controller.prepareRoot("task");
  await f.controller.delegateWorker({ taskId: "task", sessionId: root.id, generation: root.generation }, { plan: "Finish", acceptanceCriteria: ["The result is reviewed"], instruction: "Finish the existing assignment" });
  const worker = f.store.currentSession("task", "worker")!;
  const before = f.store.get("task");
  const next = f.store.replaceCoordinator("task", { sessionId: root.id, rootProfileId: "new-root", resume: false });
  expect(f.store.get("task")).toMatchObject({ worktree: before.worktree, workerSessionId: worker.id, workflowState: before.workflowState });
  f.store.recordWorkerResultAndWake({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "result-1", observation: JSON.stringify({ state: "completed", text: "Finished the existing assignment" }) });
  expect(f.store.currentSession("task", "worker")?.id).toBe(worker.id);
  expect(f.store.pendingTurns(next.id).some(turn => turn.promptText.includes("result-1"))).toBe(true);
});

test("an ordinary unanswered question resumes only with its exact identity", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  const old = f.controller.prepareRoot("task");
  f.store.askHuman("task", "Can you resolve the provider failure?", []);
  const questionId = f.store.get("task").humanQuestionId!;
  expect(() => f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: true, questionId: "stale" })).toThrow("question changed");
  const next = f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: true, questionId });
  expect(f.store.get("task").status).toBe("active");
  expect(f.store.pendingTurns(next.id)[0]?.promptText).toContain("have NOT been answered");
  expect(f.store.turns("task").filter(turn => turn.promptText.includes('"answer"'))).toHaveLength(0);
  addProfile(f.database, "third-root");
  const third = f.store.replaceCoordinator("task", { sessionId: next.id, rootProfileId: "third-root", resume: false });
  expect(f.store.pendingTurns(third.id)[0]?.promptText).toContain(`Question ${questionId}:\nCan you resolve the provider failure?`);
  expect(f.store.pendingTurns(third.id)[0]?.promptText).toContain("The task is active. Reassess these questions");
});

test("a later accepted answer removes a carried question from the next handoff", async () => {
  const f = await fixture();
  addProfile(f.database, "first-root");
  addProfile(f.database, "second-root");
  const old = f.controller.prepareRoot("task");
  const question = "Which release branch should Suplex use?";
  f.store.askHuman("task", question, []);
  const firstId = f.store.get("task").humanQuestionId!;
  const first = f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "first-root", resume: true, questionId: firstId });
  f.store.askHuman("task", question, []);
  f.store.answerHuman("task", f.store.get("task").humanQuestionId!, "Use the maintenance branch.");
  const second = f.store.replaceCoordinator("task", { sessionId: first.id, rootProfileId: "second-root", resume: false });
  const prompt = f.store.pendingTurns(second.id)[0]!.promptText;
  expect(prompt).toContain("Use the maintenance branch.");
  expect(prompt).not.toContain("Questions without an accepted answer:");
});

test("a task limit decision stays pending and a disallowed provider is rejected", async () => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  const old = f.controller.prepareRoot("task");
  f.store.pauseAtTaskLimit("task", { estimatedCostUsd: 999, admittedTurns: 1 });
  const questionId = f.store.get("task").humanQuestionId!;
  expect(() => f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: true, questionId })).toThrow("Answer the current task decision");
  f.database.authTransaction(db => db.prepare("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.providerPolicy', json(?)) WHERE id = 'task'").run(JSON.stringify({ allowedProviders: ["opencode"], allowedInstanceIds: [] })));
  expect(() => f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: false })).toThrow("allowed by this project");
  f.database.authTransaction(db => db.prepare("UPDATE suplex_tasks SET configuration_json = json_remove(configuration_json, '$.providerPolicy') WHERE id = 'task'").run());
  f.store.replaceCoordinator("task", { sessionId: old.id, rootProfileId: "new-root", resume: false });
  expect(f.store.get("task")).toMatchObject({ status: "waiting_human", humanQuestionId: questionId });
});

test.each(["cancelled", "delivered"] as const)("a %s task cannot select a Coordinator", async status => {
  const f = await fixture();
  addProfile(f.database, "new-root");
  const root = f.controller.prepareRoot("task");
  f.database.authTransaction(db => db.prepare("UPDATE suplex_task_controls SET status = ? WHERE task_id = 'task'").run(status));
  expect(() => f.store.replaceCoordinator("task", { sessionId: root.id, rootProfileId: "new-root", resume: false })).toThrow("Only active or paused");
});

test("an archived task and a Worker profile cannot be selected", async () => {
  const f = await fixture();
  const root = f.controller.prepareRoot("task");
  f.database.authTransaction(db => db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('wrong-role', 'Wrong role', 'worker', 'seed', 'codex', 'gpt-5.6-sol', 'medium', 'default', ?, ?)").run(new Date().toISOString(), new Date().toISOString()));
  expect(() => f.store.replaceCoordinator("task", { sessionId: root.id, rootProfileId: "wrong-role", resume: false })).toThrow("profile does not exist");
  addProfile(f.database, "new-root");
  f.database.authTransaction(db => db.prepare("UPDATE suplex_tasks SET archived_at = ? WHERE id = 'task'").run(new Date().toISOString()));
  expect(() => f.store.replaceCoordinator("task", { sessionId: root.id, rootProfileId: "new-root", resume: false })).toThrow("Only active or paused");
});
