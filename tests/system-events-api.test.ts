import { expect, test, vi } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { runWithSystemEvents, withEventCause, type EventContext, type SystemEvent } from "../src/platform/system-events.js";

test("authenticated client reports are bounded and Start links the client to committed admission", async () => {
  const observed: Array<{ event: SystemEvent; context: EventContext }> = [];
  const f = await nativeApp({ systemEvents: (event, context) => { observed.push({ event, context }); return `event-${observed.length}`; } });
  try {
    const tabId = "11111111-1111-4111-8111-111111111111";
    const documentId = "22222222-2222-4222-8222-222222222222";
    const body = { state: "startup", tabId, documentId, clientTime: new Date().toISOString(), visible: true, online: true };
    expect((await f.app.inject({ method: "POST", url: "/api/system/client-lifecycle", payload: body })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: "/api/system/client-lifecycle", headers: { ...f.headers, "x-suplex-tab-id": tabId }, payload: { ...body, url: "https://private.example/secret" } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/api/system/client-lifecycle", headers: { ...f.headers, "x-suplex-tab-id": tabId }, payload: body })).statusCode).toBe(204);
    expect(observed.at(-1)).toMatchObject({ event: { type: "client_lifecycle", state: "startup", tabId, documentId }, context: { source: "http", clientId: tabId } });
    const created = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Start log", idempotencyKey: "start-log-1" });
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${created.task.id}/start`, headers: { ...f.headers, "x-suplex-tab-id": tabId }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    const action = observed.find(item => item.event.type === "task_action" && item.event.action === "start");
    const admitted = observed.find(item => item.event.type === "task_admitted" && item.event.taskId === created.task.id);
    expect(action).toBeDefined();
    expect(admitted).toBeDefined();
    expect(admitted?.context).toMatchObject({ source: "http", requestId: action?.context.requestId, clientId: tabId });
  } finally { await f.close(); }
});

test("delivery commits dependent admission with the prerequisite identity and bridge cause", async () => {
  const observed: Array<{ event: SystemEvent; context: EventContext }> = [];
  const sink = (event: SystemEvent, context: EventContext): string => { observed.push({ event, context }); return `event-${observed.length}`; };
  const f = await nativeApp({ systemEvents: sink });
  try {
    const prerequisite = (await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Prerequisite", idempotencyKey: "system-prereq-1", startImmediately: true })).task;
    const dependent = (await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Dependent", idempotencyKey: "system-prereq-2", startImmediately: true, dependsOn: [prerequisite.id] })).task;
    expect(dependent.status).toBe("queued");
    runWithSystemEvents(sink, { source: "root_bridge", taskId: prerequisite.id, trigger: "request_delivery" }, () => {
      withEventCause("11111111-1111-4111-8111-111111111111", () => f.tasks.repository.controls.markDelivered(prerequisite.id));
    });
    expect(f.tasks.repository.controls.get(dependent.id).status).toBe("active");
    const admission = observed.find(item => item.event.type === "task_admitted" && item.event.taskId === dependent.id);
    expect(admission).toMatchObject({ event: { type: "task_admitted", prerequisiteTaskId: prerequisite.id, trigger: "prerequisite completion" }, context: { source: "root_bridge", taskId: prerequisite.id, causeEventId: "11111111-1111-4111-8111-111111111111" } });
  } finally { await f.close(); }
});

test("a failed queue diagnostic read cannot stop a committed Start", async () => {
  const sink = (): string => "event-id";
  const f = await nativeApp({ systemEvents: sink });
  try {
    const task = (await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Diagnostic failure", idempotencyKey: "system-fail-open-1" })).task;
    const original = f.database.authQuery.bind(f.database);
    const failing = vi.spyOn(f.database, "authQuery").mockImplementationOnce(() => { throw new Error("diagnostic unavailable"); });
    expect(() => runWithSystemEvents(sink, { source: "test" }, () => f.tasks.repository.controls.observeQueueWaits([task.id]))).not.toThrow();
    failing.mockRestore();
    expect(f.database.authQuery).toBeDefined();
    expect(original(db => db.prepare("SELECT status FROM suplex_task_controls WHERE task_id = ?").get(task.id))).toEqual({ status: "backlog" });
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, headers: f.headers, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(f.tasks.repository.controls.get(task.id).status).toBe("active");
  } finally { await f.close(); }
});
