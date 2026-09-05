import Fastify from "fastify";
import { validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test, vi } from "vitest";

import { installHttpErrorHandlers } from "../src/http/errors.js";
import taskRoutes from "../src/http/routes/tasks.js";

function testApp() {
  const app = Fastify();
  app.decorateRequest("forgeUser", undefined as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  return app;
}

test("task creation accepts a 2 MB image body", async () => {
  const app = testApp();
  const createTask = vi.fn(async () => ({ created: true, task: { id: "task_1" } }));
  await app.register(taskRoutes, { tasks: { createTask } as never });
  await app.ready();
  const image = Buffer.alloc(2 * 1024 * 1024).toString("base64");
  const response = await app.inject({ method: "POST", url: "/api/companies/company_1/tasks", payload: { projectId: "project_1", title: "Large image", description: "Inspect this image", idempotencyKey: "large-image-0001", images: [{ filename: "large.png", mimeType: "image/png", base64: image }] } });
  expect(response.statusCode).toBe(201);
  expect(createTask).toHaveBeenCalledWith("user", "company_1", expect.objectContaining({ images: [expect.objectContaining({ base64: image })] }));
  await app.close();
});

test("an oversized request body returns an actionable 413 response", async () => {
  const app = testApp();
  app.post("/body-limit-probe", { bodyLimit: 256 }, async () => ({ ok: true }));
  await app.ready();
  const response = await app.inject({ method: "POST", url: "/body-limit-probe", payload: { value: "x".repeat(512) } });
  expect(response.statusCode).toBe(413);
  expect(response.json()).toEqual({ error: "Request is too large", findings: [{ code: "request-too-large", field: "images", message: "Attach fewer or smaller images and submit again" }] });
  await app.close();
});
