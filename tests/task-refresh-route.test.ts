import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test, vi } from "vitest";

import taskRefresh from "../src/http/routes/task-refresh.js";

test("manual task refresh checks task access and runs both reconcilers", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const getTask = vi.fn(() => ({ id: "task" }));
  const refreshGithub = vi.fn(async () => ({ inspected: 1, signalled: 1, skipped: 0, errors: 0, outcomes: [] }));
  const refreshWorktrees = vi.fn(async () => ({ inspected: 1, removedExternally: 0, reported: 0, outcomes: [] }));
  await app.register(taskRefresh, { tasks: { getTask } as never, database: {} as never, config: {} as never, refreshGithub, refreshWorktrees });
  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/tasks/task/refresh" });

  expect(response.statusCode).toBe(200);
  expect(getTask).toHaveBeenCalledWith("user", "task");
  expect(refreshGithub).toHaveBeenCalledWith({}, {}, "task");
  expect(refreshWorktrees).toHaveBeenCalledWith({}, {}, { taskId: "task" });
  expect(response.json()).toMatchObject({ github: { signalled: 1 }, worktrees: { inspected: 1 } });
  await app.close();
});
