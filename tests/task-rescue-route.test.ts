import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test } from "vitest";

import taskRoutes from "../src/http/routes/tasks.js";

test("retry endpoint returns the compact retry report", async () => {
  const audit: unknown[][] = [];
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "admin" } as never; });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const database = {
    authQuery: (operation: (db: { prepare: (sql: string) => { get: () => unknown; run: (...args: unknown[]) => unknown } }) => unknown) => operation({
      prepare: (sql) => ({ get: () => sql.includes("forge_users") ? { id: "admin" } : undefined, run: (...args) => audit.push(args) }),
    }),
  };
  const tasks = {
    getTask: () => ({ id: "task", companyId: "company", workflowId: "workflow", phase: "done", revision: 3 }),
  };
  await app.register(taskRoutes, { tasks: tasks as never, database: database as never, config: {} as never });
  await app.ready();

  const response = await app.inject({ method: "POST", url: "/api/tasks/task/rescue" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "cannot_proceed", detail: "Task is already terminal.", revision: 3 });
  expect(audit).toHaveLength(1);
  await app.close();
});
