import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";

test("authenticated role selection saves a future Worker without a native session", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Select a Worker", startImmediately: true, idempotencyKey: "select-agent-api" });
    const time = new Date().toISOString();
    f.tasks.repository.controls.database.authTransaction(db => db.prepare("INSERT INTO forge_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('selected-worker', 'Selected', 'worker', 'selected', 'codex', 'gpt-5.6-sol', 'medium', 'default', ?, ?)").run(time, time));
    const url = `/api/tasks/${task.id}/select-agent`;
    const payload = { role: "worker", expectedProfileId: task.workerProfile.profileId, expectedSessionId: null, profileId: "selected-worker", direction: "Inspect existing work.", resume: false };
    expect((await f.app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().workerProfile.profileId).toBe("selected-worker");
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...payload, direction: "Different" } })).statusCode).toBe(409);
    const store = f.tasks.repository.controls;
    expect(store.sessions(task.id).filter(session => session.kind === "worker")).toHaveLength(0);
    const root = store.currentSession(task.id, "root")!;
    expect(store.pendingTurns(root.id).some(turn => turn.promptText.includes("Inspect existing work."))).toBe(true);
    expect(f.wakes).toContain(task.id);
  } finally { await f.close(); }
});
