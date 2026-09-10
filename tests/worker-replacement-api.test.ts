import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { RootController } from "../src/coordination/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";

test("authenticated replacement records history, wakes cleanup, and keeps a budget pause", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Replace a Worker", startImmediately: true, idempotencyKey: "replace-api" });
    const store = f.tasks.repository.controls;
    const controller = new RootController(store, new FakeTaskHarness());
    const root = controller.prepareRoot(task.id);
    await controller.delegateWorker({ taskId: task.id, sessionId: root.id, generation: root.generation }, { plan: "Finish", acceptanceCriteria: ["Behavior works"], instruction: "Finish the feature and tests" });
    const old = store.currentSession(task.id, "worker")!;
    store.pauseAtTaskLimit(task.id, { estimatedCostUsd: 999, admittedTurns: 0 });
    const before = store.taskLimitState(task.id);
    const url = `/api/tasks/${task.id}/replace-worker`;
    const payload = { sessionId: old.id, reason: "Repeated partial results" };
    const anonymous = await f.app.inject({ method: "POST", url, payload });
    expect(anonymous.statusCode).toBe(401);
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("waiting_human");
    expect(store.taskLimitState(task.id)).toEqual(before);
    const next = store.currentSession(task.id, "worker")!;
    expect(next.id).not.toBe(old.id);
    const activity = await f.app.inject({ url: `/api/tasks/${task.id}/activity`, headers: f.headers });
    expect(activity.json().sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: next.id, replacement: expect.objectContaining({ sessionId: old.id, reason: payload.reason }) })]));
    expect(f.wakes).toContain(task.id);
  } finally { await f.close(); }
});
