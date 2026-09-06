import { expect, test } from "vitest";
import { timelineActivity } from "../src/task-timeline.js";
import { OpenCodeMessageEnvelopeSchema } from "../src/opencode-contracts.js";
import { TaskProfileSchema } from "../src/task-control.js";
import { nativeApp } from "./helpers/native-app.js";

const profile = TaskProfileSchema.parse({ profileId: "profile", provider: "openai", model: "model", reasoningLevel: "medium", serviceTier: "default" });
const task = { rootProfile: profile, workerProfile: profile };
const session = { id: "root", kind: "root", generation: 1 } as const;
function message(id: string, parentID: string, created: number, completed?: number) {
  return OpenCodeMessageEnvelopeSchema.parse({ info: {
    id, sessionID: "ses_timeline", role: "assistant", time: { created, completed }, parentID, modelID: "model", providerID: "openai", mode: "primary", agent: "forge-root", path: { cwd: "/repo", root: "/repo" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }, parts: [] });
}

test("timeline groups native message steps by turn and excludes idle gaps", () => {
  const activity = timelineActivity(task, session, [message("msg_two", "msg_user", 200, 300), message("msg_one", "msg_user", 100, 200), message("msg_next", "msg_later_user", 1000, 1100)], false);
  expect(activity).toHaveLength(2);
  expect(activity[0]).toMatchObject({ startedAt: new Date(100).toISOString(), finishedAt: new Date(300).toISOString(), status: "completed", role: "root" });
  expect(activity[1]?.startedAt).toBe(new Date(1000).toISOString());
});

test("only the current busy native message extends to now", () => {
  const messages = [message("msg_abandoned", "msg_old", 100), message("msg_done", "msg_new", 1000, 1100), message("msg_running", "msg_new", 1100)];
  expect(timelineActivity(task, session, messages, true)).toMatchObject([{ id: "root:msg_new", startedAt: new Date(1000).toISOString(), finishedAt: null, status: "running" }]);
  expect(timelineActivity(task, session, messages, false)).toMatchObject([{ id: "root:msg_new", finishedAt: new Date(1100).toISOString(), status: "interrupted" }]);
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
