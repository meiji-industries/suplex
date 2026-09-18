import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { TaskSchema } from "../src/tasks/contracts.js";
import { taskDependencyMap } from "../src/tasks/dependencies.js";

type Fixture = Awaited<ReturnType<typeof nativeApp>>;
const byId = <T extends { id: string }>(values: T[]): T[] => [...values].sort((left, right) => left.id.localeCompare(right.id));

/** Every reader of the stored edges: the task view, the Coordinator context, and dependency evaluation. */
function readers(f: Fixture, taskId: string) {
  const task = f.tasks.getTask(f.userId, taskId);
  return { blockedBy: task.blockedBy, dependsOn: task.dependsOn, coordinator: f.tasks.repository.controls.dependencySummaries(taskId), evaluation: taskDependencyMap(f.database, [taskId]).get(taskId) };
}

test("Blocked by edits save the complete prerequisite set through the dependency route", async () => {
  const f = await nativeApp();
  try {
    const create = (title: string, key: string) => f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title, idempotencyKey: key });
    const first = await create("Prepare the schema", "blocked-by-first");
    const second = await create("Prepare the API", "blocked-by-second");
    const dependent = await create("Use the API", "blocked-by-dependent");
    const url = `/api/tasks/${dependent.task.id}/dependencies`;

    const set = await f.app.inject({ method: "PUT", url, headers: f.headers, payload: { dependsOn: [first.task.id] } });
    expect(set.statusCode, set.body).toBe(200);
    expect(TaskSchema.parse(set.json())).toMatchObject({ blockedBy: [{ id: first.task.id, title: "Prepare the schema", status: "backlog" }], dependsOn: [first.task.id] });
    expect(f.wakes).toEqual([]);

    const both = await f.app.inject({ method: "PUT", url, headers: f.headers, payload: { dependsOn: [second.task.id, first.task.id] } });
    expect(both.statusCode, both.body).toBe(200);
    const expected = byId([{ id: first.task.id, title: "Prepare the schema", status: "backlog" as const }, { id: second.task.id, title: "Prepare the API", status: "backlog" as const }]);
    expect(readers(f, dependent.task.id)).toEqual({ blockedBy: expected, dependsOn: expected.map(task => task.id), coordinator: expected, evaluation: expected.map(task => task.id) });
    expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${dependent.task.id}`, headers: f.headers, payload: { description: "Keep the prerequisites" } })).statusCode).toBe(200);
    expect(f.tasks.getTask(f.userId, dependent.task.id).dependsOn).toEqual(expected.map(task => task.id));

    f.tasks.renameTask(f.userId, second.task.id, { title: "Prepare the updated API" });
    f.tasks.startTask(f.userId, second.task.id);
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy).toContainEqual({ id: second.task.id, title: "Prepare the updated API", status: "active" });

    // Removing one prerequisite keeps the other.
    const removed = await f.app.inject({ method: "PUT", url, headers: f.headers, payload: { dependsOn: [second.task.id] } });
    expect(TaskSchema.parse(removed.json()).blockedBy).toEqual([{ id: second.task.id, title: "Prepare the updated API", status: "active" }]);
    expect(readers(f, dependent.task.id).evaluation).toEqual([second.task.id]);

    f.tasks.repository.setArchived(second.task.id, true);
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy).toEqual([{ id: second.task.id, title: "Prepare the updated API", status: "active" }]);
    // Start queues; an archived prerequisite that was never delivered keeps the task queued.
    expect(f.tasks.startTask(f.userId, dependent.task.id)).toMatchObject({ status: "backlog", queue: { startIntent: "queued", state: "queued", waitingOn: [{ id: second.task.id, reason: "prerequisite_archived" }] } });

    const cleared = await f.app.inject({ method: "PUT", url, headers: f.headers, payload: { dependsOn: [] } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(readers(f, dependent.task.id)).toEqual({ blockedBy: [], dependsOn: [], coordinator: [], evaluation: [] });
    expect(TaskSchema.parse(cleared.json())).toMatchObject({ status: "active", queue: { startIntent: "manual", state: "running", waitingOn: [] } });
  } finally { await f.close(); }
});

test("Blocked by rejects unavailable, self, cyclic, and other-company tasks without mutation", async () => {
  const f = await nativeApp();
  try {
    const target = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Allowed target", idempotencyKey: "blocked-by-allowed" });
    const dependent = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Dependent task", idempotencyKey: "blocked-by-invalid" });
    const otherCompany = f.auth.createCompany(f.userId, "Other company");
    const repositoryPath = join(f.config.repositoryRoot, "other-company");
    const worktreeRoot = join(f.config.worktreeRoot, "other-company");
    await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
    const otherProject = await f.projects.createProject(f.userId, otherCompany.id, { name: "Other", repositoryPath, worktreeRoot, repository: "owner/other-company", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    const foreign = await f.tasks.createTask(f.userId, otherCompany.id, { projectId: otherProject.id, title: "Other company task", idempotencyKey: "blocked-by-other-company" });
    const put = (taskId: string, dependsOn: string[]) => f.app.inject({ method: "PUT", url: `/api/tasks/${taskId}/dependencies`, headers: f.headers, payload: { dependsOn } });

    expect((await put(dependent.task.id, [target.task.id])).statusCode).toBe(200);
    for (const [dependsOn, status, error] of [
      [["task_missing"], 404, "Not found"],
      [[dependent.task.id], 422, "A task cannot depend on itself"],
      [[target.task.id, foreign.task.id], 404, "A dependency task is not available"],
    ] as const) {
      const response = await put(dependent.task.id, [...dependsOn]);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error).toBe(error);
      expect(f.tasks.getTask(f.userId, dependent.task.id).dependsOn).toEqual([target.task.id]);
    }
    const cycle = await put(target.task.id, [dependent.task.id]);
    expect(cycle.statusCode, cycle.body).toBe(422);
    expect(cycle.json().error).toBe("The dependency creates a cycle");
    expect(f.tasks.getTask(f.userId, target.task.id).dependsOn).toEqual([]);

    // The retired single-reference inputs are rejected, never ignored.
    const legacyBody = await f.app.inject({ method: "PUT", url: `/api/tasks/${dependent.task.id}/dependencies`, headers: f.headers, payload: { dependsOn: [], blockedByTaskId: target.task.id } });
    expect(legacyBody.statusCode).toBe(400);
    const legacyRoute = await f.app.inject({ method: "PATCH", url: `/api/tasks/${dependent.task.id}/blocked-by`, headers: f.headers, payload: { blockedByTaskId: null } });
    expect(legacyRoute.statusCode).toBe(404);
    const legacyCreate = await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/tasks`, headers: f.headers, payload: { projectId: f.project.id, title: "Legacy", idempotencyKey: "blocked-by-legacy-create", blockedByTaskId: target.task.id } });
    expect(legacyCreate.statusCode).toBe(400);
    expect(f.tasks.getTask(f.userId, dependent.task.id).dependsOn).toEqual([target.task.id]);
  } finally { await f.close(); }
});

test("creation validates and persists several Blocked by tasks", async () => {
  const f = await nativeApp();
  try {
    const first = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "First", idempotencyKey: "creation-first" });
    const second = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Second", idempotencyKey: "creation-second" });
    const url = `/api/companies/${f.company.id}/tasks`;
    const payload = { projectId: f.project.id, title: "Dependent", idempotencyKey: "creation-dependent", dependsOn: [first.task.id, second.task.id] };
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(response.statusCode, response.body).toBe(201);
    expect(TaskSchema.parse(response.json()).blockedBy).toEqual(byId([{ id: first.task.id, title: "First", status: "backlog" }, { id: second.task.id, title: "Second", status: "backlog" }]));

    const rejected = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...payload, idempotencyKey: "creation-invalid", dependsOn: [first.task.id, "task_missing"] } });
    expect(rejected.statusCode, rejected.body).toBe(404);
    expect(f.tasks.listTasks(f.userId, f.company.id)).toHaveLength(3);
  } finally { await f.close(); }
});

test("an immediate task waits for its Blocked by task to deliver", async () => {
  const f = await nativeApp();
  try {
    const reference = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Deliver first", idempotencyKey: "gate-reference", startImmediately: true });
    const waiting = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Wait for delivery", idempotencyKey: "gate-waiting", startImmediately: true, dependsOn: [reference.task.id] });
    expect(waiting.task).toMatchObject({ status: "backlog", queue: { state: "queued" }, blockedBy: [{ id: reference.task.id }] });

    f.tasks.repository.controls.markDelivered(reference.task.id);
    expect(f.tasks.getTask(f.userId, waiting.task.id)).toMatchObject({ status: "active", queue: { startIntent: "manual" } });

    const deliveredReference = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Already delivered", idempotencyKey: "gate-delivered-reference", startImmediately: true });
    f.tasks.repository.controls.markDelivered(deliveredReference.task.id);
    const immediate = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Start now", idempotencyKey: "gate-immediate", startImmediately: true, dependsOn: [deliveredReference.task.id] });
    expect(immediate.task).toMatchObject({ status: "active", queue: { startIntent: "manual" } });

    const backlog = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Stay in backlog", idempotencyKey: "gate-backlog", dependsOn: [waiting.task.id] });
    expect(backlog.task).toMatchObject({ status: "backlog", queue: { startIntent: "manual" } });
    f.tasks.repository.controls.markDelivered(waiting.task.id);
    expect(f.tasks.getTask(f.userId, backlog.task.id).status).toBe("backlog");
  } finally { await f.close(); }
});

test("an explicit start records queued intent until live prerequisites are removed", async () => {
  const f = await nativeApp();
  try {
    const prerequisite = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Prepare first", idempotencyKey: "explicit-start-prerequisite", startImmediately: true });
    const dependent = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Start after prepare", idempotencyKey: "explicit-start-dependent", dependsOn: [prerequisite.task.id] });

    expect(f.tasks.startTask(f.userId, dependent.task.id)).toMatchObject({ status: "backlog", queue: { startIntent: "queued" } });
    expect(f.tasks.repository.controls.taskSpend(dependent.task.id).turns).toBe(0);

    f.tasks.setTaskDependencies(f.userId, dependent.task.id, []);
    expect(f.tasks.getTask(f.userId, dependent.task.id)).toMatchObject({ status: "active", queue: { startIntent: "manual" } });
  } finally { await f.close(); }
});

test.each(["cancelled", "archived"] as const)("dependency release does not wake a %s queued task", async disposition => {
  const f = await nativeApp();
  try {
    const prerequisite = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Prepare first", idempotencyKey: `release-${disposition}-prerequisite`, startImmediately: true });
    const dependent = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Wait safely", idempotencyKey: `release-${disposition}-dependent`, dependsOn: [prerequisite.task.id] });
    f.tasks.startTask(f.userId, dependent.task.id);
    if (disposition === "cancelled") f.tasks.repository.controls.cancel(dependent.task.id);
    else f.tasks.repository.setArchived(dependent.task.id, true);

    f.tasks.repository.controls.markDelivered(prerequisite.task.id);
    expect(f.tasks.getTask(f.userId, dependent.task.id).status).toBe(disposition === "cancelled" ? "cancelled" : "backlog");
  } finally { await f.close(); }
});

test("an immediate task with two Blocked by tasks starts only after both deliver", async () => {
  const f = await nativeApp();
  try {
    const first = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "A", idempotencyKey: "both-task-a", startImmediately: true });
    const second = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "B", idempotencyKey: "both-task-b", startImmediately: true });
    const waiting = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "C", idempotencyKey: "both-task-c", startImmediately: true, dependsOn: [first.task.id, second.task.id] });
    expect(waiting.task).toMatchObject({ status: "backlog", queue: { state: "queued" } });

    f.tasks.repository.controls.markDelivered(second.task.id);
    expect(f.tasks.getTask(f.userId, waiting.task.id)).toMatchObject({ status: "backlog", queue: { state: "queued" } });

    f.tasks.repository.controls.markDelivered(first.task.id);
    expect(f.tasks.getTask(f.userId, waiting.task.id)).toMatchObject({ status: "active", queue: { startIntent: "manual" } });
  } finally { await f.close(); }
});

test("a chain of immediate tasks starts one dependency at a time", async () => {
  const f = await nativeApp();
  try {
    const first = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "A", idempotencyKey: "chain-task-a", startImmediately: true });
    const second = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "B", idempotencyKey: "chain-task-b", startImmediately: true, dependsOn: [first.task.id] });
    const third = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "C", idempotencyKey: "chain-task-c", startImmediately: true, dependsOn: [second.task.id] });
    expect(second.task).toMatchObject({ status: "backlog", queue: { state: "queued" } });
    expect(third.task).toMatchObject({ status: "backlog", queue: { state: "queued" } });

    f.tasks.repository.controls.markDelivered(first.task.id);
    expect(f.tasks.getTask(f.userId, second.task.id)).toMatchObject({ status: "active", queue: { startIntent: "manual" } });
    expect(f.tasks.getTask(f.userId, third.task.id)).toMatchObject({ status: "backlog", queue: { state: "queued" } });

    f.tasks.repository.controls.markDelivered(second.task.id);
    expect(f.tasks.getTask(f.userId, third.task.id)).toMatchObject({ status: "active", queue: { startIntent: "manual" } });
  } finally { await f.close(); }
});
