import { expect, test } from "vitest";
import { readTaskTimeline, timelineActivity } from "../src/task-timeline.js";
import { OpenCodeMessageEnvelopeSchema } from "../src/opencode-contracts.js";
import { TaskProfileSchema } from "../src/task-control.js";
import { nativeApp } from "./helpers/native-app.js";
import { TaskAnalyticsStore } from "../src/task-analytics-store.js";
import { taskUsage } from "../src/task-usage.js";

test("task Activity and company Timeline read durable analytics timing without waking archived tasks", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Recorded timeline", description: "Offline history", startImmediately: true, idempotencyKey: "recorded-timeline" });
    const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    value.tasks.repository.controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_timeline" });
    new TaskAnalyticsStore(value.database).record(task.id, root.id, taskUsage([message("msg_recorded", "msg_turn", 1000, 3000)], "root"));
    value.tasks.repository.controls.markDelivered(task.id);
    value.tasks.repository.setArchived(task.id, true);
    const before = value.tasks.getTask(value.userId, task.id);
    const route = `/api/tasks/${task.id}/timeline`;
    expect((await value.app.inject({ url: route })).statusCode).toBe(401);
    for (const url of [route, `/api/companies/${value.company.id}/timeline`]) {
      const response = await value.app.inject({ url, headers: value.headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ tasks: [{ id: task.id, activity: [{ role: "root", startedAt: new Date(1000).toISOString(), finishedAt: new Date(3000).toISOString() }] }] });
    }
    expect((await value.app.inject({ url: "/api/tasks/task_missing/timeline", headers: value.headers })).statusCode).toBe(404);
    expect(value.tasks.getTask(value.userId, task.id)).toEqual(before);
    expect(value.wakes).toEqual([]);
  } finally { await value.close(); }
});

const profile = TaskProfileSchema.parse({ profileId: "profile", provider: "openai", model: "model", reasoningLevel: "medium", serviceTier: "default" });
const task = { rootProfile: profile, workerProfile: profile };
const session = { id: "root", kind: "root", generation: 1 } as const;
function message(id: string, parentID: string, created: number, completed?: number) {
  return OpenCodeMessageEnvelopeSchema.parse({ info: {
    id, sessionID: "ses_timeline", role: "assistant", time: { created, completed }, parentID, modelID: "model", providerID: "openai", mode: "primary", agent: "forge-root", path: { cwd: "/repo", root: "/repo" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }, parts: [] });
}

test("timeline groups native message steps by turn and excludes idle gaps", () => {
  const activity = timelineActivity(task, session, taskUsage([message("msg_two", "msg_user", 200, 300), message("msg_one", "msg_user", 100, 200), message("msg_next", "msg_later_user", 1000, 1100)], "root"), null);
  expect(activity).toHaveLength(2);
  expect(activity[0]).toMatchObject({ startedAt: new Date(100).toISOString(), finishedAt: new Date(300).toISOString(), status: "completed", role: "root" });
  expect(activity[1]?.startedAt).toBe(new Date(1000).toISOString());
});

test("only the current busy native message extends to now", () => {
  const messages = [message("msg_abandoned", "msg_old", 100), message("msg_done", "msg_new", 1000, 1100), message("msg_running", "msg_new", 1100)];
  expect(timelineActivity(task, session, taskUsage(messages, "root"), "msg_running")).toMatchObject([{ id: "root:msg_new", startedAt: new Date(1000).toISOString(), finishedAt: null, status: "running" }]);
  expect(timelineActivity(task, session, taskUsage(messages, "root"), null)).toMatchObject([{ id: "root:msg_new", finishedAt: new Date(1100).toISOString(), status: "interrupted" }]);
  expect(timelineActivity(task, session, taskUsage(messages, "root"), "msg_abandoned").every(entry => entry.finishedAt !== null)).toBe(true);
});

test("timeline observation is company-authorized and cannot wake a task", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Timeline", description: "Read only", startImmediately: false, idempotencyKey: "timeline-only" });
    const route = `/api/companies/${value.company.id}/timeline`;
    expect((await value.app.inject({ url: route })).statusCode).toBe(401);
    const response = await value.app.inject({ url: route, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tasks: [{ id: task.id, activity: [] }], unavailableSessions: 0 });
    expect(value.tasks.getTask(value.userId, task.id)).toEqual(task);
    expect(value.wakes).toEqual([]);
  } finally { await value.close(); }
});

test("live observations merge with durable history and failures cannot extend unfinished messages", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Live timeline", description: "Observe only", startImmediately: true, idempotencyKey: "live-timeline" });
    const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    value.tasks.repository.controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_timeline" });
    const sessions = value.tasks.repository.controls.sessions(task.id);
    const recorded = taskUsage([message("msg_recorded", "msg_old", 1000, 2000), message("msg_abandoned", "msg_lost", 3000)], "root");
    const live = await readTaskTimeline(value.database.filename(), [task], sessions, () => recorded, async () => ({ usage: taskUsage([message("msg_live", "msg_current", 4000)], "root"), liveMessageId: "msg_live" }));
    expect(live.tasks[0]?.activity).toHaveLength(2);
    expect(live.tasks[0]?.activity.at(-1)).toMatchObject({ status: "running", finishedAt: null });
    const offline = await readTaskTimeline(value.database.filename(), [task], sessions, () => recorded, async () => { throw new Error("offline"); });
    expect(offline.unavailableSessions).toBe(1);
    expect(offline.tasks[0]?.activity).toHaveLength(1);
    expect(offline.tasks[0]?.activity[0]).toMatchObject({ status: "completed", finishedAt: new Date(2000).toISOString() });
    value.database.authQuery(db => db.exec("DROP TABLE forge_task_usage"));
    expect((await value.app.inject({ url: `/api/tasks/${task.id}/timeline`, headers: value.headers })).statusCode).toBe(500);
    expect(value.tasks.repository.controls.markDelivered(task.id).status).toBe("delivered");
    expect(value.wakes).toEqual([]);
  } finally { await value.close(); }
});
