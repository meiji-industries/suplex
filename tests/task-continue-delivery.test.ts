import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";

test("a delivered draft continues through review and merge on the same task and Coordinator session", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Continue delivery", idempotencyKey: "continue-delivery-targets", startImmediately: true });
    const store = f.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "retained-coordinator" });
    const previous = { kind: "workflow", reviewedHead: "a".repeat(40), pullRequestNumber: 247, observedAt: new Date().toISOString() } as const;
    store.updateWorkflowState(task.id, state => ({ ...state, completion: previous }));
    store.markDelivered(task.id);
    store.retireDeliveredSessions(task.id);
    store.completeStop(root.id);
    f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET shell_pane_id = NULL, pull_request_json = NULL WHERE task_id = ?").run(task.id));

    const send = (deliveryTarget: string) => f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/continue-delivery`, headers: f.headers, payload: { deliveryTarget } });
    const review = await send("pull_request_ready");
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json()).toMatchObject({ id: task.id, status: "active", deliveryTarget: "pull_request_ready", pullRequest: null });
    expect(store.currentSession(task.id, "root")).toMatchObject({ id: root.id, nativeSessionId: "retained-coordinator" });
    expect(store.get(task.id).workflowState).toMatchObject({ completion: null, followUp: true, deliveryHistory: [{ completion: previous }] });
    expect(store.pendingTurns(root.id)).toHaveLength(1);
    expect(store.pendingTurns(root.id)[0]!.promptText).toContain("NEW target pull_request_ready");
    expect(f.wakes).toContain(task.id);

    expect((await send("pull_request_ready")).statusCode).toBe(200);
    expect(store.pendingTurns(root.id)).toHaveLength(1);
    expect((await send("merged")).statusCode).toBe(409);
    store.markDelivered(task.id);
    const merge = await send("merged");
    expect(merge.statusCode, merge.body).toBe(200);
    expect(merge.json()).toMatchObject({ id: task.id, status: "active", deliveryTarget: "merged" });
    expect(store.pendingTurns(root.id)).toHaveLength(2);
    expect(store.pendingTurns(root.id)[1]!.promptText).toContain("NEW target merged");
    expect(store.get(task.id).workflowState.deliveryHistory).toHaveLength(2);
    expect((await send("pull_request_ready")).statusCode).toBe(409);
    expect((await send("merged")).statusCode).toBe(200);
    expect(store.pendingTurns(root.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test("continuation rejects invalid, unauthorized, archived, and unsupported commands", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Restricted delivery", idempotencyKey: "restricted-delivery", startImmediately: true });
    const store = f.tasks.repository.controls;
    store.markDelivered(task.id);
    const url = `/api/tasks/${task.id}/continue-delivery`;
    const send = (payload: { deliveryTarget: string; extra?: boolean }, headers = f.headers) => f.app.inject({ method: "POST", url, headers, payload });
    expect((await send({ deliveryTarget: "pull_request_draft" })).statusCode).toBe(400);
    expect((await send({ deliveryTarget: "merged", extra: true })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url, payload: { deliveryTarget: "merged" } })).statusCode).toBe(401);
    const stamp = new Date().toISOString();
    f.database.authTransaction(db => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('outsider', 'Outsider', 'outsider', 'member', 'active', ?, ?)").run(stamp, stamp));
    expect(() => f.tasks.continueDelivery("outsider", task.id, "merged")).toThrow("Not found");
    f.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.integration', json(?)) WHERE id = ?").run(JSON.stringify({ repository: { kind: "bitbucket", tokenEnvironment: "BB_TOKEN" }, tracker: null }), task.id));
    expect((await send({ deliveryTarget: "merged" })).statusCode).toBe(422);
    f.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET archived_at = ? WHERE id = ?").run(stamp, task.id));
    expect((await send({ deliveryTarget: "merged" })).statusCode).toBe(409);
    expect(store.turns(task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test("a competing task assignment rejects continuation without changing target, history, or turns", async () => {
  const f = await nativeApp();
  try {
    const first = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "First", idempotencyKey: "continue-owner-first", startImmediately: true });
    const second = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Second", idempotencyKey: "continue-owner-second", startImmediately: true });
    const store = f.tasks.repository.controls;
    store.markDelivered(first.task.id);
    f.database.authTransaction(db => {
      const intent = { repository: first.task.configuration.repository, headBranch: first.task.configuration.branch, baseBranch: "main", baselineSha: "a".repeat(40), pullRequestNumber: 247 };
      db.prepare("UPDATE forge_task_controls SET delivery_intent_json = ? WHERE task_id IN (?, ?)").run(JSON.stringify(intent), first.task.id, second.task.id);
    });
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${first.task.id}/continue-delivery`, headers: f.headers, payload: { deliveryTarget: "merged" } });
    expect(response.statusCode).toBe(409);
    expect(store.get(first.task.id)).toMatchObject({ status: "delivered", deliveryTarget: "pull_request_draft" });
    expect(store.get(first.task.id).workflowState.deliveryHistory).toBeUndefined();
    expect(store.turns(first.task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test("a failed Coordinator turn rolls back the target, status, and delivery history", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Atomic continuation", idempotencyKey: "atomic-continuation", startImmediately: true });
    const store = f.tasks.repository.controls;
    store.claimRoot({ taskId: task.id });
    store.markDelivered(task.id);
    f.database.authTransaction(db => db.exec("CREATE TRIGGER reject_continuation_turn BEFORE INSERT ON forge_task_turns BEGIN SELECT RAISE(ABORT, 'turn rejected'); END"));
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/continue-delivery`, headers: f.headers, payload: { deliveryTarget: "merged" } });
    expect(response.statusCode).toBe(409);
    expect(store.get(task.id)).toMatchObject({ status: "delivered", deliveryTarget: "pull_request_draft" });
    expect(store.get(task.id).workflowState.deliveryHistory).toBeUndefined();
    expect(store.turns(task.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test("a recreated Coordinator session and stale closed pull request observation do not block continuation", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Recovered continuation", idempotencyKey: "recreated-continuation", startImmediately: true });
    const store = f.tasks.repository.controls;
    const original = store.claimRoot({ taskId: task.id });
    store.setPullRequest(task.id, { repository: task.configuration.repository, number: 247, url: "https://github.com/meiji-industries/forge/pull/247", headSha: "a".repeat(40), state: "closed", mergedAt: null });
    store.markDelivered(task.id);
    f.database.authTransaction(db => {
      db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'stopped' WHERE id = ?").run(original.id);
      db.prepare("UPDATE forge_task_controls SET root_session_id = NULL, shell_pane_id = 'obsolete-pane' WHERE task_id = ?").run(task.id);
    });
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/continue-delivery`, headers: f.headers, payload: { deliveryTarget: "pull_request_ready" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "active", deliveryTarget: "pull_request_ready", pullRequest: { number: 247, state: "closed" } });
    const replacement = store.currentSession(task.id, "root");
    expect(replacement).toBeTruthy();
    expect(replacement?.id).not.toBe(original.id);
    expect(store.pendingTurns(replacement!.id).some(turn => turn.promptText.includes("NEW target pull_request_ready"))).toBe(true);
  } finally { await f.close(); }
});
