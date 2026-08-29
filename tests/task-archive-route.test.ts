import Fastify from "fastify";
import { validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test, vi } from "vitest";

import taskArchive from "../src/http/routes/task-archive.js";
import taskRoutes from "../src/http/routes/tasks.js";
import { TaskFailure } from "../src/tasks.js";
import { installHttpErrorHandlers } from "../src/http/errors.js";

test("archive route forwards dirty-worktree confirmation and is idempotent", async () => {
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const archiveTask = vi.fn(async (_user: string, _task: string, _revision: number, _input: { confirmDiscardDirty?: boolean }) => ({ status: "confirmation_required" as const, dirtyFileCount: 2, task: {} }));
  const unarchiveTask = vi.fn(() => ({}));
  await app.register(taskArchive, { tasks: {} as never, database: {} as never, archive: { archiveTask, unarchiveTask } as never });
  await app.ready();
  const first = await app.inject({ method: "POST", url: "/api/tasks/task/archive", payload: { expectedRevision: 3 } });
  const second = await app.inject({ method: "POST", url: "/api/tasks/task/archive", payload: { expectedRevision: 3, confirmDiscardDirty: true } });
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2 });
  expect(second.json()).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2 });
  expect(archiveTask.mock.calls).toEqual([["user", "task", 3, {}], ["user", "task", 3, { confirmDiscardDirty: true }]]);
  await app.close();
});

test("unarchive route passes the authenticated actor", async () => {
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const unarchiveTask = vi.fn(() => ({}));
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  await app.register(taskArchive, { tasks: {} as never, database: {} as never, archive: { archiveTask: vi.fn(), unarchiveTask } as never });
  await app.ready();
  const first = await app.inject({ method: "POST", url: "/api/tasks/task/unarchive" });
  const second = await app.inject({ method: "POST", url: "/api/tasks/task/unarchive" });
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(unarchiveTask.mock.calls).toEqual([["user", "task"], ["user", "task"]]);
  await app.close();
});

test("archive route returns a cleanup failure finding", async () => {
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const archiveTask = vi.fn(async () => { throw new TaskFailure("Worktree could not be removed", [{ code: "worktree-cleanup-failed", field: "worktree", message: "Forge does not own the requested worktree" }], 409); });
  await app.register(taskArchive, { tasks: {} as never, database: {} as never, archive: { archiveTask, unarchiveTask: vi.fn() } as never });
  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/tasks/task/archive", payload: { expectedRevision: 3 } });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ findings: [{ code: "worktree-cleanup-failed" }] });
  await app.close();
});


test("task lists request archived tasks only when the archived filter is set", async () => {
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  const listTasks = vi.fn(() => []);
  await app.register(taskRoutes, { tasks: { listTasks } as never });
  await app.ready();
  const visible = await app.inject({ method: "GET", url: "/api/companies/company/tasks" });
  const archived = await app.inject({ method: "GET", url: "/api/companies/company/tasks?archived=true" });
  expect(visible.statusCode).toBe(200);
  expect(archived.statusCode).toBe(200);
  expect(listTasks.mock.calls).toEqual([["user", "company", false], ["user", "company", true]]);
  await app.close();
});
