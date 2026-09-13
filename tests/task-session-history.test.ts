import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as commands from "../src/platform/command-runner.js";
import * as executables from "../src/platform/executable-resolver.js";
import { taskSessionRuntimeDirectory } from "../src/runtimes/task-harness.js";
import { nativeApp } from "./helpers/native-app.js";

afterEach(() => vi.restoreAllMocks());

test("task history authorizes the task and session before native fallback reads", async () => {
  const value = await nativeApp();
  try {
    const first = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "History", description: "Read history", startImmediately: true, idempotencyKey: "history-session" });
    const second = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Foreign", description: "Other task", startImmediately: true, idempotencyKey: "foreign-session" });
    const firstStore = value.tasks.repository.controls;
    const firstReserved = firstStore.claimRoot({ taskId: first.task.id });
    const firstSession = firstStore.bindHarnessSession({ sessionId: firstReserved.id, generation: firstReserved.generation, nativeSessionId: "ses_history" });
    const secondReserved = firstStore.claimRoot({ taskId: second.task.id });
    const secondSession = firstStore.bindHarnessSession({ sessionId: secondReserved.id, generation: secondReserved.generation, nativeSessionId: "ses_foreign" });
    vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
    const run = vi.spyOn(commands, "readCommandOutput").mockResolvedValue(JSON.stringify({ info: { id: "ses_history" }, messages: [{
      info: { id: "msg_user", sessionID: "ses_history", role: "user", time: { created: 10 }, agent: "forge-root", model: { providerID: "openai", modelID: "model" } },
      parts: [{ id: "prt_user", type: "text", text: "Hello" }],
    }] }));

    const response = await value.app.inject({ url: `/api/tasks/${first.task.id}/sessions/${firstSession.id}/history`, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ messages: [{ id: "msg_user", role: "user", createdAt: 10, content: [{ id: "prt_user", type: "text", text: "Hello" }] }], olderCursor: null });
    expect(run).toHaveBeenCalledTimes(1);

    expect((await value.app.inject({ url: `/api/tasks/${first.task.id}/sessions/${secondSession.id}/history`, headers: value.headers })).statusCode).toBe(404);
    expect((await value.app.inject({ url: `/api/tasks/${first.task.id}/sessions/${firstSession.id}/history` })).statusCode).toBe(401);
    expect(run).toHaveBeenCalledTimes(1);
  } finally { await value.close(); }
});

test("task history distinguishes an invalid cursor from an unavailable native read", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "History errors", description: "Read history", startImmediately: true, idempotencyKey: "history-errors" });
    const store = value.tasks.repository.controls;
    const reserved = store.claimRoot({ taskId: task.id });
    const session = store.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_history" });
    vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
    vi.spyOn(commands, "readCommandOutput")
      .mockResolvedValueOnce(JSON.stringify({ info: { id: "ses_history" }, messages: [] }))
      .mockResolvedValueOnce(JSON.stringify({ info: { id: "ses_history" }, messages: [] }))
      .mockRejectedValueOnce(new Error("offline"));
    const empty = await value.app.inject({ url: `/api/tasks/${task.id}/sessions/${session.id}/history`, headers: value.headers });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ messages: [], olderCursor: null });
    const invalid = await value.app.inject({ url: `/api/tasks/${task.id}/sessions/${session.id}/history?before=missing`, headers: value.headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("cursor");
    const unavailable = await value.app.inject({ url: `/api/tasks/${task.id}/sessions/${session.id}/history`, headers: value.headers });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: "Session history is not available" });
  } finally { await value.close(); }
});

test("task history serves Devin turn logs whose file mtimes carry sub-millisecond precision", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Devin history", description: "Read history", startImmediately: true, idempotencyKey: "devin-history" });
    const store = value.tasks.repository.controls;
    const reserved = store.claimRoot({ taskId: task.id });
    const session = store.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "devin-71618050-0d31-428e-a547-d6c4a2eca88f" });
    const directory = taskSessionRuntimeDirectory(value.config.databasePath, session.id);
    await mkdir(directory, { recursive: true });
    const turn = join(directory, "turn-msg_devin.jsonl");
    await writeFile(turn, "Reviewed the change.\n");
    await utimes(turn, 1_700_000_000.0005, 1_700_000_000.0005);

    const response = await value.app.inject({ url: `/api/tasks/${task.id}/sessions/${session.id}/history`, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ messages: [{ id: "msg_devin", role: "assistant", createdAt: 1_700_000_000_000, content: [{ id: "msg_devin:text", type: "text", text: "Reviewed the change." }] }], olderCursor: null });
  } finally { await value.close(); }
});

test("task history preserves an authorization failure after the native read", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "History revoked", description: "Recheck access", startImmediately: true, idempotencyKey: "history-revoked" });
    const store = value.tasks.repository.controls;
    const reserved = store.claimRoot({ taskId: task.id });
    const session = store.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_history" });
    vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
    vi.spyOn(commands, "readCommandOutput").mockImplementation(async () => {
      value.database.authQuery(db => db.prepare("UPDATE forge_users SET status = 'revoked' WHERE id = ?").run(value.userId));
      return JSON.stringify({ info: { id: "ses_history" }, messages: [] });
    });

    const response = await value.app.inject({ url: `/api/tasks/${task.id}/sessions/${session.id}/history`, headers: value.headers });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required" });
  } finally { await value.close(); }
});
