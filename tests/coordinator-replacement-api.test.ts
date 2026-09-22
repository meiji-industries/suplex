import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { RootController } from "../src/coordination/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";

test("Coordinator selection requires task access and the current session", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Select a Coordinator", startImmediately: true, idempotencyKey: "coordinator-api" });
    const root = new RootController(f.tasks.repository.controls, new FakeTaskHarness()).prepareRoot(task.id);
    f.tasks.repository.controls.database.authTransaction(db => db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('replacement-root', 'Replacement', 'root', 'replacement', 'codex', 'gpt-5.6-sol', 'medium', 'default', ?, ?)").run(new Date().toISOString(), new Date().toISOString()));
    const url = `/api/tasks/${task.id}/replace-coordinator`;
    const handoff = `Earlier work: ${"x".repeat(20_000)}`;
    const payload = { sessionId: root.id, rootProfileId: "replacement-root", handoff, resume: false };
    expect((await f.app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...payload, sessionId: "unrelated" } })).statusCode).toBe(409);
    const selected = await f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json().rootProfile.profileId).toBe("replacement-root");
    const current = f.tasks.repository.controls.currentSession(task.id, "root")!;
    expect(f.tasks.repository.controls.pendingTurns(current.id).some(turn => turn.promptText.includes(handoff))).toBe(true);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...payload, handoff: "Different direction" } })).statusCode).toBe(409);
    expect(f.tasks.repository.controls.sessions(task.id).filter(session => session.kind === "root")).toHaveLength(2);
  } finally { await f.close(); }
});
