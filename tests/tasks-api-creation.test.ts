import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { TaskSchema } from "../src/tasks/contracts.js";

test("issue association can be cleared during active work without changing task intent", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Keep this title", description: "Keep this scope", idempotencyKey: "clear-issue-api", startImmediately: true });
    const url = `/api/tasks/${task.id}/issue`;
    expect((await f.app.inject({ method: "PATCH", url, payload: { issue: null } })).statusCode).toBe(401);
    const response = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { issue: null } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ issue: null, title: "Keep this title", description: "Keep this scope", status: "active" });
    expect(f.tasks.repository.controls.get(task.id).objective).toBe("Keep this title\n\nKeep this scope");
  } finally { await f.close(); }
});

test("Start immediately commits active intent and schedules Coordinator without a second command", async () => {
  const f = await nativeApp();
  try {
    const payload = { projectId: f.project.id, title: "Immediate task", description: "Do the work", idempotencyKey: "immediate-1", startImmediately: true };
    const url = `/api/companies/${f.company.id}/tasks`;
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(response.statusCode, response.body).toBe(201);
    const task = TaskSchema.parse(response.json());
    expect(task.status).toBe("active");
    expect(task.limits).toEqual({ budgetUsd: 15, maxTurns: 40, admittedTurns: 0 });
    expect(f.wakes).toContain(task.id);
    const retried = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().id).toBe(task.id);
    const conflict = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...payload, title: "Different objective" } });
    expect(conflict.statusCode).toBe(409);
    expect(f.tasks.listTasks(f.userId)).toHaveLength(1);
  } finally { await f.close(); }
});

test("task creation accepts a title without a description and keeps its objective clean", async () => {
  const f = await nativeApp();
  try {
    const url = `/api/companies/${f.company.id}/tasks`;
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { projectId: f.project.id, title: "Title only", idempotencyKey: "title-only-1" } });
    expect(response.statusCode, response.body).toBe(201);
    const task = TaskSchema.parse(response.json());
    expect(task.description).toBe("");
    expect(f.tasks.repository.controls.get(task.id).objective).toBe("Title only");
    const missingTitle = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { projectId: f.project.id, description: "Description only", idempotencyKey: "missing-title-1" } });
    expect(missingTitle.statusCode).toBe(400);
  } finally { await f.close(); }
});

test("task details can clear a description but not its title", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Editable title", description: "Existing description", idempotencyKey: "clear-description-1" });
    const response = await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: f.headers, payload: { description: "" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(TaskSchema.parse(response.json())).toMatchObject({ title: "Editable title", description: "" });
    expect(f.tasks.repository.controls.get(task.id).objective).toBe("Editable title");
    const emptyTitle = await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: f.headers, payload: { title: "" } });
    expect(emptyTitle.statusCode).toBe(400);
  } finally { await f.close(); }
});

test("task details accept the editable settings and refuse an edit once the task starts", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Editable settings", description: "Edit me", idempotencyKey: "edit-settings-1" });
    const payload = { title: "Edited settings", workflow: "independent_review", advisorProfileIds: { reviewer: "profile_native_root" }, deliveryTarget: "remote_branch", runProjectTests: false, visualEvidence: "capture" };
    const response = await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: f.headers, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(TaskSchema.parse(response.json())).toMatchObject({
      title: "Edited settings", description: "Edit me", workflow: "independent_review", deliveryTarget: "remote_branch",
      advisorProfiles: { reviewer: { profileId: "profile_native_root" } }, configuration: { runProjectTests: false, visualEvidence: "capture" },
    });
    expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: f.headers, payload: { projectId: f.project.id } })).statusCode).toBe(400);
    f.tasks.startTask(f.userId, task.id);
    expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: f.headers, payload: { title: "Too late" } })).statusCode).toBe(409);
  } finally { await f.close(); }
});

test("task limit answers require an explicit decision and expose the approved limits", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Limited task", description: "Stop at the boundary", idempotencyKey: "limited-task-1", startImmediately: true });
    f.tasks.repository.controls.claimRoot({ taskId: task.id });
    const pause = { kind: "task_limit", reason: "budget", limits: { budgetUsd: 15, maxTurns: 40 }, usage: { estimatedCostUsd: 16, admittedTurns: 2 }, proposedLimits: { budgetUsd: 31, maxTurns: 40 } };
    f.database.authTransaction(db => db.prepare("UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Task limit reached', human_question_id = 'limit-question', limit_pause_json = ? WHERE task_id = ?").run(JSON.stringify(pause), task.id));
    const url = `/api/tasks/${task.id}/answer`;
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { questionId: "limit-question", answer: "Continue" } })).statusCode).toBe(409);
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { questionId: "limit-question", limitDecision: { kind: "add_allowance" } } });
    expect(response.statusCode, response.body).toBe(200);
    expect(TaskSchema.parse(response.json())).toMatchObject({ status: "active", humanQuestion: null, limits: { budgetUsd: 31, maxTurns: 40, admittedTurns: 0 } });

    const cancelled = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Stopped task", description: "Stop at the limit", idempotencyKey: "limited-task-2", startImmediately: true });
    f.tasks.repository.controls.claimRoot({ taskId: cancelled.task.id });
    f.database.authTransaction(db => db.prepare("UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Task limit reached', human_question_id = 'cancel-question', limit_pause_json = ? WHERE task_id = ?").run(JSON.stringify(pause), cancelled.task.id));
    const cancelResponse = await f.app.inject({ method: "POST", url: `/api/tasks/${cancelled.task.id}/answer`, headers: f.headers, payload: { questionId: "cancel-question", limitDecision: { kind: "cancel_task" } } });
    expect(cancelResponse.statusCode, cancelResponse.body).toBe(200);
    expect(TaskSchema.parse(cancelResponse.json())).toMatchObject({ status: "cancelled", humanQuestion: null });
  } finally { await f.close(); }
});

test("backlog tasks stay idle until Start and answers target an exact question", async () => {
  const f = await nativeApp();
  try {
    const response = await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/tasks`, headers: f.headers, payload: { projectId: f.project.id, title: "Backlog task", description: "Wait", idempotencyKey: "backlog-1", startImmediately: false } });
    const task = TaskSchema.parse(response.json());
    expect(task.status).toBe("backlog");
    expect(f.wakes).toEqual([]);
    const started = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, headers: f.headers, payload: {} });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().status).toBe("active");
    f.tasks.repository.controls.claimRoot({ taskId: task.id });
    f.tasks.repository.controls.askHuman(task.id, "Which output format?");
    const question = f.tasks.getTask(f.userId, task.id).humanQuestion!;
    const answer = (questionId: string) => f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/answer`, headers: f.headers, payload: { questionId, answer: "Markdown" } });
    expect((await answer("stale-question")).statusCode).toBe(409);
    expect((await answer(question.id)).statusCode).toBe(200);
    expect((await answer(question.id)).statusCode).toBe(409);
    expect(f.tasks.repository.controls.turns(task.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test("notes queue one trimmed message for the current Coordinator", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Message task", idempotencyKey: "message-task", startImmediately: true });
    const root = f.tasks.repository.controls.claimRoot({ taskId: task.id });
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/note`, headers: f.headers, payload: { note: "  Check the current result.  " } });
    expect(response.statusCode, response.body).toBe(200);
    expect(f.wakes).toContain(task.id);
    expect(f.tasks.repository.controls.pendingTurns(root.id)).toMatchObject([{ promptText: "Human note:\nCheck the current result.", status: "pending_prompt" }]);
  } finally { await f.close(); }
});

test("a message resumes a delivered task and preserves its Coordinator and delivery history", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Continue delivery", idempotencyKey: "continue-delivery", startImmediately: true });
    const store = f.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "retained-coordinator" });
    const previous = { kind: "workflow", reviewedHead: "a".repeat(40), pullRequestNumber: 1597, observedAt: new Date().toISOString() } as const;
    store.updateWorkflowState(task.id, state => ({ ...state, completion: previous }));
    store.markDelivered(task.id);
    store.retireDeliveredSessions(task.id);
    store.completeStop(root.id);
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/note`, headers: f.headers, payload: { note: "Fix the failing checks on the existing PR." } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "active", deliveryTarget: task.deliveryTarget });
    expect(store.currentSession(task.id, "root")).toMatchObject({ id: root.id, nativeSessionId: "retained-coordinator" });
    expect(JSON.parse(store.pendingTurns(root.id)[0]!.promptText)).toMatchObject({ answer: "Fix the failing checks on the existing PR." });
    expect(store.get(task.id).workflowState).toMatchObject({ completion: null, acceptedDelivery: null, followUp: true, deliveryHistory: [{ completion: previous }] });
    expect(f.wakes).toContain(task.id);
  } finally { await f.close(); }
});

test("notes reject invalid, unauthorised, and inactive requests without queuing a turn", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Restricted message task", idempotencyKey: "restricted-message-task", startImmediately: false });
    const url = `/api/tasks/${task.id}/note`;
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { note: "Message" } })).statusCode).toBe(409);
    f.tasks.startTask(f.userId, task.id);

    f.tasks.repository.controls.claimRoot({ taskId: task.id });
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { note: "   " } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { note: "x".repeat(20_001) } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url, payload: { note: "Message" } })).statusCode).toBe(401);
    expect(f.tasks.repository.controls.turns(task.id)).toEqual([]);
  } finally { await f.close(); }
});

test("task APIs reject old phase commands and cross-company reads", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Private task", description: "Keep this private", idempotencyKey: "private-1" });
    expect((await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: f.headers, payload: { expectedRevision: 1 } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode).toBe(401);
    const stamp = new Date().toISOString();
    f.database.authTransaction(db => db.prepare("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('outsider', 'Outsider', 'outsider', 'member', 'active', ?, ?)").run(stamp, stamp));
    expect(() => f.tasks.getTask("outsider", task.id)).toThrow("Not found");
    expect(f.tasks.listTasks("outsider")).toEqual([]);
  } finally { await f.close(); }
});
