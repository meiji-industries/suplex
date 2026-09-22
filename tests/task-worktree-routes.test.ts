
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
  let user = native.auth.listUsers(native.userId)[0]!;
  app.decorateRequest("suplexUser", { getter: () => user });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  const runCommand = vi.fn(async () => ({ command: "code /worktrees/task", exitCode: 0, signal: null, spawnError: null, durationMs: 1, stdout: "", stderr: "", entries: [], startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.001Z", timedOut: false }));
  const launchers = () => [{ id: "finder" as const, label: "Finder", command: "/usr/bin/open", args: (path: string) => [path] }, { id: "terminal" as const, label: "Terminal", command: "terminal", args: () => [], cwd: (path: string) => path }];
  const editorLauncher = () => ({ id: "editor" as const, label: "Editor", command: "/usr/local/bin/code", args: (path: string) => [path] });
  await app.register(taskWorktree, { tasks, database, runCommand, config: native.config, launchers, editorLauncher });
  await app.ready();
  return { native, task, database, app, runCommand, asUser(id: string) { user = { ...user, id }; } };
}

test("opens a task worktree through the configured editor and records the action", async () => {
  const value = await fixture();
  try {
    const response = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111" }, payload: { app: "editor" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(value.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "/usr/local/bin/code", args: ["/worktrees/task"], taskId: value.task.id }));
    expect(value.database.authQuery((db) => db.prepare("SELECT action FROM suplex_audit_events WHERE action = 'worktree_opened'").all())).toEqual([{ action: "worktree_opened" }]);
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("returns not found when the task has no worktree", async () => {
  const value = await fixture(false);
  try {
    const response = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111" }, payload: { app: "finder" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Worktree not found" });
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("does not disclose another user's task and rejects invalid applications", async () => {
  const value = await fixture();
  try {
    value.asUser("user-not-authorized");
    const denied = await value.app.inject({ method: "GET", url: `/api/tasks/${value.task.id}/worktree/apps`, headers: { host: "127.0.0.1:4111" } });
    expect(denied.statusCode).toBe(401);
    value.asUser(value.native.userId);
    const invalid = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111" }, payload: { app: "not-an-app" } });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("requires a direct loopback peer and exact configured Host", async () => {
  const value = await fixture();
  try {
    const local = await value.app.inject({ method: "GET", url: `/api/tasks/${value.task.id}/worktree/apps`, headers: { host: "127.0.0.1:4111" } });
    expect(local.json()).toEqual({ apps: [{ id: "finder", label: "Finder" }, { id: "terminal", label: "Terminal" }] });
    const remote = await value.app.inject({ method: "GET", url: `/api/tasks/${value.task.id}/worktree/apps`, headers: { host: "suplex.tailnet.ts.net:4111" } });
    expect(remote.json()).toEqual({ apps: [] });
    const forged = await value.app.inject({ method: "GET", url: `/api/tasks/${value.task.id}/worktree/apps`, headers: { host: "127.0.0.1:4111" }, remoteAddress: "203.0.113.10" });
    expect(forged.json()).toEqual({ apps: [] });
    const forwarded = await value.app.inject({ method: "GET", url: `/api/tasks/${value.task.id}/worktree/apps`, headers: { host: "127.0.0.1:4111", "x-forwarded-for": "127.0.0.1" } });
    expect(forwarded.json()).toEqual({ apps: [] });
    const rejected = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "suplex.tailnet.ts.net:4111" }, payload: { app: "finder" } });
    expect(rejected.statusCode).toBe(403);
    const spoofed = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111", forwarded: "for=127.0.0.1" }, payload: { app: "finder" } });
    expect(spoofed.statusCode).toBe(403);
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("accepts IPv4, mapped IPv4, and IPv6 direct peers", async () => {
  const value = await fixture();
  try {
    for (const remoteAddress of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
      const host = remoteAddress === "::1" ? "[::1]:4111" : "127.0.0.1:4111";
      const response = await value.app.inject({ method: "GET", url: `/api/tasks/${value.task.id}/worktree/apps`, headers: { host }, remoteAddress });
      expect(response.json().apps).toHaveLength(2);
    }
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("does not audit failed launches or unavailable applications", async () => {
  const value = await fixture();
  try {
    const missing = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111" }, payload: { app: "ghostty" } });
    expect(missing.statusCode).toBe(501);
    value.runCommand.mockRejectedValueOnce(new Error("permission denied"));
    const denied = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111" }, payload: { app: "finder" } });
    expect(denied.json()).toEqual({ ok: false, error: "permission denied" });
    expect(value.database.authQuery((db) => db.prepare("SELECT action FROM suplex_audit_events WHERE action = 'worktree_opened'").all())).toEqual([]);
  } finally {
    await value.app.close();
    await value.native.close();
  }
});

test("uses the server-owned path as terminal cwd", async () => {
  const value = await fixture();
  try {
    const response = await value.app.inject({ method: "POST", url: `/api/tasks/${value.task.id}/worktree/open`, headers: { host: "127.0.0.1:4111" }, payload: { app: "terminal" } });
    expect(response.json()).toEqual({ ok: true });
    expect(value.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "terminal", args: [], cwd: "/worktrees/task" }));
  } finally {
    await value.app.close();
    await value.native.close();
  }
});
