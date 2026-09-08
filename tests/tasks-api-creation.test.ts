import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { TaskSchema } from "../src/tasks/contracts.js";

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

test("task limit answers require an explicit decision and expose the approved limits", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Limited task", description: "Stop at the boundary", idempotencyKey: "limited-task-1", startImmediately: true });
    f.tasks.repository.controls.claimRoot({ taskId: task.id });
    const pause = { kind: "task_limit", reason: "budget", limits: { budgetUsd: 15, maxTurns: 40 }, usage: { estimatedCostUsd: 16, admittedTurns: 2 }, proposedLimits: { budgetUsd: 31, maxTurns: 40 } };
    f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', human_question = 'Task limit reached', human_question_id = 'limit-question', limit_pause_json = ? WHERE task_id = ?").run(JSON.stringify(pause), task.id));
    const url = `/api/tasks/${task.id}/answer`;
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { questionId: "limit-question", answer: "Continue" } })).statusCode).toBe(409);
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { questionId: "limit-question", limitDecision: { kind: "add_allowance" } } });
    expect(response.statusCode, response.body).toBe(200);
    expect(TaskSchema.parse(response.json())).toMatchObject({ status: "active", humanQuestion: null, limits: { budgetUsd: 31, maxTurns: 40, admittedTurns: 0 } });

    const cancelled = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Stopped task", description: "Stop at the limit", idempotencyKey: "limited-task-2", startImmediately: true });
    f.tasks.repository.controls.claimRoot({ taskId: cancelled.task.id });
    f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET status = 'waiting_human', human_question = 'Task limit reached', human_question_id = 'cancel-question', limit_pause_json = ? WHERE task_id = ?").run(JSON.stringify(pause), cancelled.task.id));
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

test("task APIs reject old phase commands and cross-company reads", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Private task", description: "Keep this private", idempotencyKey: "private-1" });
    expect((await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: f.headers, payload: { expectedRevision: 1 } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode).toBe(401);
    const stamp = new Date().toISOString();
    f.database.authTransaction(db => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('outsider', 'Outsider', 'outsider', 'member', 'active', ?, ?)").run(stamp, stamp));
    expect(() => f.tasks.getTask("outsider", task.id)).toThrow("Not found");
    expect(f.tasks.listTasks("outsider")).toEqual([]);
  } finally { await f.close(); }
});
