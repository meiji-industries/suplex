import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test, vi } from "vitest";

const { getIssueEngine } = vi.hoisted(() => ({ getIssueEngine: vi.fn(() => ({})) }));
vi.mock("../src/engine/index.js", () => ({ getIssueEngine }));

import taskRefresh from "../src/http/routes/task-refresh.js";

test("manual task refresh checks task access and runs one refresh pass", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const getTask = vi.fn(() => ({ id: "task" }));
  const reconcile = vi.fn(async () => ({ turns: 1, worktrees: 1, github: 1, capacity: 1 }));
  await app.register(taskRefresh, { tasks: { getTask } as never, database: {} as never, config: {} as never, reconcile });
  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/tasks/task/refresh" });

  expect(response.statusCode).toBe(200);
  expect(getTask).toHaveBeenCalledWith("user", "task");
  expect(reconcile).toHaveBeenCalledWith({}, {}, expect.anything(), expect.objectContaining({ force: true }));
  expect(response.json()).toMatchObject({ github: 1, worktrees: 1 });
  await app.close();
});
