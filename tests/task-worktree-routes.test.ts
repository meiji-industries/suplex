
import { validatorCompiler } from "@fastify/type-provider-zod";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";

import { nativeApp } from "./helpers/native-app.js";
import taskWorktree from "../src/http/routes/task-worktree.js";
import { installHttpErrorHandlers } from "../src/http/errors.js";

async function fixture(withWorktree = true) {
  const native = await nativeApp();
  const { database, tasks } = native;
  const { task } = await tasks.createTask(native.userId, native.company.id, { projectId: native.project.id, title: "Open worktree", description: "Open the existing checkout", idempotencyKey: "open-worktree-test", startImmediately: true });
  if (withWorktree) tasks.repository.controls.setWorktree(task.id, { path: "/worktrees/task", branch: task.configuration.branch, baseSha: "a", headSha: "a", dirty: false });
  const app = Fastify();
  const user = native.auth.listUsers(native.userId)[0]!;
  app.decorateRequest("forgeUser", { getter: () => user });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  const runCommand = vi.fn(async () => ({ command: "code /worktrees/task", exitCode: 0, durationMs: 1, stdout: "", stderr: "", entries: [], startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.001Z", timedOut: false }));
  await app.register(taskWorktree, { tasks, database, runCommand });
  await app.ready();
  return { native, task, database, app, runCommand };
}

test("opens a task worktree in the configured editor and records the action", async () => {
  const value = await fixture();
  try {
    const response = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, payload: { app: "editor" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(value.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "code", args: ["/worktrees/task"], taskId: value.task.id }));
    expect(value.database.authQuery((db) => db.prepare("SELECT action FROM forge_audit_events WHERE action = 'worktree_opened'").all())).toEqual([{ action: "worktree_opened" }]);
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("returns not found when the task has no worktree", async () => {
  const value = await fixture(false);
  try {
    const response = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, payload: { app: "editor" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Worktree not found" });
  } finally {
    await value.app.close();
    await value.native.close();
  }
});
