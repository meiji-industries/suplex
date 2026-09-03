import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatorCompiler } from "@fastify/type-provider-zod";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import taskWorktree from "../src/http/routes/task-worktree.js";
import { installHttpErrorHandlers } from "../src/http/errors.js";

async function fixture(withWorktree = true) {
  const root = await mkdtemp(join(tmpdir(), "forge-task-worktree-routes-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  if (withWorktree) database.authQuery((db) => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, reserved_at) VALUES ('worktree', 'task', 'company', 'project', 'workflow', '/repo', '/worktrees', '/worktrees/task', 'forge/task', 'a', 'lease', ?)").run(new Date().toISOString());
  });
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const runCommand = vi.fn(async () => ({ command: "code /worktrees/task", exitCode: 0, durationMs: 1, stdout: "", stderr: "", entries: [], startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.001Z", timedOut: false }));
  await app.register(taskWorktree, { tasks: { getTask: () => ({ companyId: "company" }) } as never, database, runCommand });
  await app.ready();
  return { root, database, app, runCommand };
}

test("opens a task worktree in the configured editor and records the action", async () => {
  const value = await fixture();
  try {
    const response = await value.app.inject({ method: "POST", url: "/api/tasks/task/worktree/open", payload: { app: "editor" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(value.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "code", args: ["/worktrees/task"], taskId: "task" }));
    expect(value.database.authQuery((db) => db.prepare("SELECT action FROM forge_audit_events").all())).toEqual([{ action: "worktree_opened" }]);
  } finally {
    await value.app.close();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("returns not found when the task has no worktree", async () => {
  const value = await fixture(false);
  try {
    const response = await value.app.inject({ method: "POST", url: "/api/tasks/task/worktree/open", payload: { app: "editor" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Worktree not found" });
  } finally {
    await value.app.close();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
