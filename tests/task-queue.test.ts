import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CompletedPullRequests } from "../src/delivery/completed-pull-requests.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { TaskQueueWaits, backlogText } from "../src/frontend/features/tasks/task-details.js";
import { TaskStatus, taskStatusLabel } from "../src/frontend/features/tasks/task-status.js";
import { TaskSchema, type Task, type TaskInput } from "../src/tasks/contracts.js";
import { TaskHost } from "../src/tasks/host.js";
import { nativeApp } from "./helpers/native-app.js";

type Fixture = Awaited<ReturnType<typeof nativeApp>>;

async function create(f: Fixture, title: string, input: Partial<TaskInput> = {}): Promise<Task> {
  return (await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title, idempotencyKey: `queue-${title.toLowerCase().replaceAll(" ", "-")}`, ...input })).task;
}
const read = (f: Fixture, id: string) => f.tasks.getTask(f.userId, id);
const work = (f: Fixture, id: string) => ({ sessions: f.tasks.repository.controls.sessions(id).length, turns: f.tasks.repository.controls.turns(id).length });
const pull = (number: number, state: "open" | "merged") => ({ repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, headSha: "b".repeat(40), state, mergedAt: state === "merged" ? "2026-09-18T12:00:00.000Z" : null });
/** What GitHub reports and Forge records when a merged-target task completes: the merged pull request, then delivery. */
function merge(f: Fixture, id: string, number: number): void {
  f.tasks.repository.controls.setPullRequest(id, pull(number, "merged"));
  f.tasks.repository.controls.markDelivered(id);
}

test("a merged-target chain starts one task at a time, exactly once, and only after each authoritative merge", async () => {
  const f = await nativeApp();
  try {
    const a = await create(f, "Chain A", { startImmediately: true, deliveryTarget: "merged" });
    const b = await create(f, "Chain B", { startImmediately: true, deliveryTarget: "merged", dependsOn: [a.id] });
    const c = await create(f, "Chain C", { startImmediately: true, deliveryTarget: "merged", dependsOn: [b.id] });
    expect(a).toMatchObject({ status: "active", queue: { state: "running" } });
    expect(b).toMatchObject({ status: "backlog", queue: { startIntent: "queued", state: "queued", waitingOn: [{ id: a.id, title: "Chain A", status: "active", deliveryTarget: "merged", reason: "prerequisite_running" }] } });
    expect(c).toMatchObject({ status: "backlog", queue: { startIntent: "queued", state: "queued", waitingOn: [{ id: b.id, reason: "prerequisite_not_started" }] } });

    // The agent finished and opened the pull request, but GitHub has not merged it.
    f.tasks.repository.controls.setPullRequest(a.id, pull(101, "open"));
    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
    expect(read(f, b.id)).toMatchObject({ status: "backlog", queue: { waitingOn: [{ id: a.id, reason: "prerequisite_running" }] } });
    expect([work(f, b.id), work(f, c.id)]).toEqual([{ sessions: 0, turns: 0 }, { sessions: 0, turns: 0 }]);

    merge(f, a.id, 101);
    const started = read(f, b.id);
    expect(started).toMatchObject({ status: "active", wakeAt: expect.any(String), queue: { startIntent: "manual", state: "running", waitingOn: [] } });
    expect(read(f, c.id)).toMatchObject({ status: "backlog", queue: { state: "queued", waitingOn: [{ id: b.id, reason: "prerequisite_running" }] } });

    // Duplicate completion events and sweeps change nothing.
    f.tasks.repository.controls.markDelivered(a.id);
    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
    expect(read(f, b.id).statusChangedAt).toBe(started.statusChangedAt);

    merge(f, b.id, 102);
    expect(read(f, c.id)).toMatchObject({ status: "active", queue: { state: "running" } });
    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
  } finally { await f.close(); }
});

test("the queue intent survives restart, and the startup sweep starts an eligible task once", async () => {
  const f = await nativeApp();
  try {
    const a = await create(f, "Restart A", { startImmediately: true });
    const b = await create(f, "Restart B", { startImmediately: true, dependsOn: [a.id] });
    // The prerequisite completed, but the process stopped before any wake reached its dependent.
    f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET status = 'delivered' WHERE task_id = ?").run(a.id));
    expect(read(f, b.id)).toMatchObject({ status: "backlog", queue: { startIntent: "queued", state: "queued", waitingOn: [] } });
    expect(work(f, b.id)).toEqual({ sessions: 0, turns: 0 });

    const restart = async () => {
      const host = new TaskHost(f.database, {
        completedPullRequests: { refresh: async () => {} },
        controller: { prepareRoot: () => { throw new Error("No root in this test"); }, recover: async () => {} },
        delivery: { observe: async () => null },
        worktree: async () => { throw new Error("No worktree in this test"); },
      });
      host.start();
      await host.stop();
    };
    await restart();
    const started = read(f, b.id);
    expect(started.status).not.toBe("backlog");
    expect(started.queue.startIntent).toBe("manual");

    // A second restart and a repeated sweep find nothing to admit: the task left the backlog exactly once.
    await restart();
    expect(new TaskControlStore(f.database).admitQueued()).toEqual([]);
    expect(read(f, b.id).statusChangedAt).toBe(started.statusChangedAt);
  } finally { await f.close(); }
});

test("a cancelled, unanswered, or archived prerequisite keeps its dependents queued with an actionable reason and no work", async () => {
  const f = await nativeApp();
  try {
    const cancelled = await create(f, "Cancelled prerequisite", { startImmediately: true });
    f.tasks.cancelTask(f.userId, cancelled.id);
    const question = await create(f, "Question prerequisite", { startImmediately: true });
    f.tasks.repository.controls.askHuman(question.id, "Which schema?");
    const archived = await create(f, "Archived prerequisite");
    f.tasks.repository.setArchived(archived.id, true);
    const dependent = await create(f, "Dependent", { startImmediately: true, dependsOn: [cancelled.id, question.id, archived.id] });

    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
    const waiting = read(f, dependent.id);
    expect(waiting).toMatchObject({ status: "backlog", queue: { state: "queued" } });
    const reasons = Object.fromEntries(waiting.queue.waitingOn.map(wait => [wait.id, wait]));
    expect(reasons[cancelled.id]).toMatchObject({ status: "cancelled", reason: "prerequisite_cancelled", summary: expect.stringContaining("Remove it from Blocked by") });
    expect(reasons[question.id]).toMatchObject({ status: "waiting_human", reason: "prerequisite_needs_human", summary: expect.stringContaining("Answer it") });
    expect(reasons[archived.id]).toMatchObject({ status: "backlog", reason: "prerequisite_archived", summary: expect.stringContaining("open and deliver it") });
    expect(work(f, dependent.id)).toEqual({ sessions: 0, turns: 0 });
  } finally { await f.close(); }
});

test("every blocker must complete, dependency edits re-evaluate, and only observed merges release a merged prerequisite", async () => {
  const f = await nativeApp();
  try {
    const x = await create(f, "Blocker X", { startImmediately: true });
    const y = await create(f, "Blocker Y", { startImmediately: true });
    const both = await create(f, "Needs both", { startImmediately: true, dependsOn: [x.id, y.id] });
    f.tasks.repository.controls.markDelivered(y.id);
    expect(read(f, both.id)).toMatchObject({ status: "backlog", queue: { waitingOn: [{ id: x.id, reason: "prerequisite_running" }] } });
    f.tasks.repository.controls.markDelivered(x.id);
    expect(read(f, both.id).status).toBe("active");

    // A complete prerequisite starts a queued task at creation.
    expect(await create(f, "Already satisfied", { startImmediately: true, dependsOn: [x.id] })).toMatchObject({ status: "active" });

    // Adding an incomplete blocker before admission prevents the start; removing the last one starts the task.
    const running = await create(f, "Running blocker", { startImmediately: true });
    const edited = await create(f, "Edited dependencies");
    const put = (dependsOn: string[]) => f.app.inject({ method: "PUT", url: `/api/tasks/${edited.id}/dependencies`, headers: f.headers, payload: { dependsOn } });
    expect((await put([running.id])).statusCode).toBe(200);
    expect(f.tasks.startTask(f.userId, edited.id)).toMatchObject({ status: "backlog", queue: { state: "queued", waitingOn: [{ id: running.id }] } });
    const manual = await create(f, "Manual blocker");
    expect(TaskSchema.parse((await put([running.id, manual.id])).json())).toMatchObject({ status: "backlog", queue: { waitingOn: [{ reason: expect.any(String) }, { reason: expect.any(String) }] } });
    expect(TaskSchema.parse((await put([x.id])).json())).toMatchObject({ status: "active", queue: { state: "running" } });

    // A merged-target prerequisite recorded as delivered with an unmerged pull request waits for GitHub.
    const merged = await create(f, "Merged target", { startImmediately: true, deliveryTarget: "merged" });
    f.tasks.repository.controls.setPullRequest(merged.id, pull(201, "open"));
    f.tasks.repository.controls.markDelivered(merged.id);
    const dependent = await create(f, "After merge", { startImmediately: true, dependsOn: [merged.id] });
    expect(dependent.queue.waitingOn).toEqual([expect.objectContaining({ id: merged.id, status: "delivered", reason: "prerequisite_merge_unobserved", summary: expect.stringContaining("Forge checks GitHub again") })]);

    // Unknown external state retries; it never releases the dependent.
    await expect(new CompletedPullRequests(f.database, { getPullRequestStates: async () => { throw new Error("GitHub is unavailable"); } }).refresh()).rejects.toThrow("GitHub is unavailable");
    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
    expect(read(f, dependent.id).status).toBe("backlog");

    // A merge made outside Forge releases the dependent once Forge observes it.
    await new CompletedPullRequests(f.database, { getPullRequestStates: async () => [pull(201, "merged")] }).refresh();
    expect(f.tasks.repository.controls.admitQueued()).toEqual([dependent.id]);
    expect(read(f, dependent.id).status).toBe("active");
  } finally { await f.close(); }
});

test("manual backlog never starts by itself; start queues, disarm returns it to the manual backlog, and cancel clears the intent", async () => {
  const f = await nativeApp();
  try {
    const delivered = await create(f, "Delivered", { startImmediately: true });
    f.tasks.repository.controls.markDelivered(delivered.id);
    const manual = await create(f, "Manual", { dependsOn: [delivered.id] });
    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
    expect(read(f, manual.id)).toMatchObject({ status: "backlog", queue: { startIntent: "manual", state: "backlog", waitingOn: [] } });

    const running = await create(f, "Running", { startImmediately: true });
    const task = await create(f, "Queue and disarm", { dependsOn: [running.id] });
    const post = (action: string, headers: Record<string, string> = f.headers) => f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/${action}`, headers });
    expect((await post("disarm", { origin: f.config.reachableAddress })).statusCode).toBe(401);
    const queued = await post("start");
    expect(queued.statusCode, queued.body).toBe(200);
    expect(TaskSchema.parse(queued.json())).toMatchObject({ status: "backlog", queue: { startIntent: "queued", state: "queued" } });
    const disarmed = await post("disarm");
    expect(disarmed.statusCode, disarmed.body).toBe(200);
    expect(TaskSchema.parse(disarmed.json())).toMatchObject({ status: "backlog", queue: { startIntent: "manual", state: "backlog", waitingOn: [{ id: running.id }] } });
    f.tasks.repository.controls.markDelivered(running.id);
    expect(read(f, task.id).status).toBe("backlog");
    expect(TaskSchema.parse((await post("start")).json()).status).toBe("active");
    expect((await post("disarm")).statusCode).toBe(409);

    // A cancelled queued task keeps no intent, so a delayed wake cannot start it.
    const blocker = await create(f, "Late blocker", { startImmediately: true });
    const cancelled = await create(f, "Cancelled queued", { startImmediately: true, dependsOn: [blocker.id] });
    f.tasks.cancelTask(f.userId, cancelled.id);
    f.tasks.repository.controls.markDelivered(blocker.id);
    expect(f.tasks.repository.controls.admitQueued()).toEqual([]);
    expect(read(f, cancelled.id)).toMatchObject({ status: "cancelled", queue: { startIntent: "manual", state: "cancelled" } });
    expect(work(f, cancelled.id)).toEqual({ sessions: 0, turns: 0 });

    // An archived queued task keeps no intent, so opening it again leaves it in the manual backlog.
    const parked = await create(f, "Parked queued", { startImmediately: true, dependsOn: [cancelled.id] });
    expect(parked.queue.state).toBe("queued");
    f.tasks.repository.setArchived(parked.id, true);
    f.tasks.unarchiveTask(f.userId, parked.id);
    expect(read(f, parked.id)).toMatchObject({ status: "backlog", queue: { startIntent: "manual", state: "backlog" } });
  } finally { await f.close(); }
});

test("HTTP, the paired-agent API, OpenAPI, and the UI report the same queue state and wait reasons", async () => {
  const f = await nativeApp();
  try {
    const credential = (name: string) => {
      const issued = f.externalAgent.create(f.userId, { name, companyId: f.company.id, projectIds: [f.project.id] });
      return { Authorization: `Bearer ${f.externalAgent.exchange({ pairingCode: issued.pairingCode, profileId: `profile-${name}` }).credential}` };
    };
    const agent = credential("queue-bot");
    const other = credential("other-bot");
    const agentApi = (method: "GET" | "POST", url: string, payload?: object, headers = agent) => f.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

    const prerequisite = (await agentApi("POST", "/api/agent/tasks", { projectId: f.project.id, title: "Agent prerequisite", idempotencyKey: "agent-prerequisite" })).json();
    const createdResponse = await agentApi("POST", "/api/agent/tasks", { projectId: f.project.id, title: "Agent queued", idempotencyKey: "agent-queued", queue: true, dependsOn: [prerequisite.id] });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = createdResponse.json();
    const expectedQueue = { startIntent: "queued", state: "queued", waitingOn: [{ id: prerequisite.id, title: "Agent prerequisite", status: "backlog", deliveryTarget: "pull_request_draft", reason: "prerequisite_not_started", summary: expect.stringContaining("Start it") }] };
    expect(created).toMatchObject({ status: "backlog", workflowStage: "queued", queue: expectedQueue, permittedCommands: expect.arrayContaining(["disarm_task"]) });
    expect(created.permittedCommands).not.toContain("start_task");
    expect(prerequisite).toMatchObject({ workflowStage: "backlog", queue: { startIntent: "manual", state: "backlog" }, permittedCommands: expect.arrayContaining(["start_task"]) });

    const http = read(f, created.id);
    expect(http.queue).toEqual(created.queue);

    // The UI renders the same state and the prerequisite link, id, and reason.
    expect(taskStatusLabel(http)).toBe("Queued");
    expect(renderToStaticMarkup(createElement(TaskStatus, { status: http.status, queued: http.queue.state === "queued" }))).toContain("Queued");
    expect(backlogText(http.queue)).toContain("starts by itself");
    const waits = renderToStaticMarkup(createElement(TaskQueueWaits, { task: http }));
    expect(waits).toContain(`data-task-queue-wait="${prerequisite.id}"`);
    expect(waits).toContain(`data-reason="prerequisite_not_started"`);
    expect(waits).toContain(`/tasks/${prerequisite.id}`);
    expect(waits).toContain("Agent prerequisite");

    // Another paired agent cannot read or disarm the task; the creator can disarm and queue it again.
    expect((await agentApi("POST", `/api/agent/tasks/${created.id}/commands`, { command: "disarm_task", revision: created.revision, idempotencyKey: "other-disarm" }, other)).statusCode).toBe(404);
    const disarmed = await agentApi("POST", `/api/agent/tasks/${created.id}/commands`, { command: "disarm_task", revision: created.revision, idempotencyKey: "agent-disarm" });
    expect(disarmed.statusCode, disarmed.body).toBe(200);
    expect(disarmed.json()).toMatchObject({ status: "backlog", workflowStage: "backlog", queue: { startIntent: "manual", state: "backlog" }, permittedCommands: expect.arrayContaining(["start_task"]) });
    expect(read(f, created.id).queue).toEqual(disarmed.json().queue);
    const requeued = await agentApi("POST", `/api/agent/tasks/${created.id}/commands`, { command: "start_task", revision: disarmed.json().revision, idempotencyKey: "agent-requeue" });
    expect(requeued.json()).toMatchObject({ status: "backlog", queue: { state: "queued" } });
    expect((await agentApi("GET", `/api/agent/tasks/${created.id}`)).json().queue).toEqual(read(f, created.id).queue);

    const document = (await agentApi("GET", "/api/agent/openapi.json")).json();
    const commandEnum = document.paths["/api/agent/tasks/{taskId}/commands"].post.requestBody.content["application/json"].schema.properties.command.enum;
    expect(commandEnum).toEqual(expect.arrayContaining(["start_task", "disarm_task"]));
    expect(document.paths["/api/agent/tasks"].post.requestBody.content["application/json"].schema.properties).toHaveProperty("queue");
    const readSchema = document.paths["/api/agent/tasks/{taskId}"].get.responses["200"].content["application/json"].schema;
    expect(readSchema.properties.queue.properties.state.enum).toEqual(["backlog", "queued", "running", "needs_attention", "delivered", "cancelled"]);
    expect(readSchema.properties.queue.properties.waitingOn.items.properties.reason.enum).toContain("prerequisite_merge_unobserved");
    const capabilities = (await agentApi("GET", "/api/agent/capabilities")).json();
    expect(capabilities).toMatchObject({ capabilities: { create: { queuedTask: true } }, autonomousCommands: expect.arrayContaining(["create_queued_task", "disarm_task"]) });
  } finally { await f.close(); }
});

test("the queue migration keeps waiting rows queued and touches no task control", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(`CREATE TABLE forge_tasks (id TEXT PRIMARY KEY, start_when_blocked_by_delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE forge_task_controls (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO forge_tasks VALUES ('waiting', 1), ('manual', 0), ('running', 0);
      INSERT INTO forge_task_controls VALUES ('waiting', 'backlog', 'before'), ('manual', 'backlog', 'before'), ('running', 'active', 'before');`);
    const migration = await readFile(new URL("../drizzle/20260918200123065_task_start_queue.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);
    expect(database.prepare("SELECT id, start_queued AS queued FROM forge_tasks ORDER BY id").all()).toEqual([{ id: "manual", queued: 0 }, { id: "running", queued: 0 }, { id: "waiting", queued: 1 }]);
    expect(database.prepare("SELECT task_id AS id, status, updated_at AS updatedAt FROM forge_task_controls ORDER BY task_id").all()).toEqual([
      { id: "manual", status: "backlog", updatedAt: "before" }, { id: "running", status: "active", updatedAt: "before" }, { id: "waiting", status: "backlog", updatedAt: "before" },
    ]);
  } finally { database.close(); }
});
