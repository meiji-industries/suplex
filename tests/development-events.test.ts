import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test } from "vitest";

import type { TaskService } from "../src/tasks.js";
import developmentEvents from "../src/http/routes/development-events.js";

test("Development SSE resumes from Last-Event-ID with ordered framing", async () => {
  const executionId = `developer_${"a".repeat(24)}`;
  const cursors: unknown[] = [];
  const tasks = { getDeveloperProgress(actorUserId: string, taskId: string, cursor?: unknown) {
    expect(actorUserId).toBe("user_sse");
    expect(taskId).toBe("task_sse");
    cursors.push(cursor);
    return { status: "running", execution: { id: executionId, status: "running", startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null, lastHeartbeatAt: "2026-08-13T00:00:01.000Z", currentStep: 1 }, events: cursor ? [{ eventId: "event_2", sequence: 2, kind: "command_finished", stepNumber: 1, occurredAt: "2026-08-13T00:00:02.000Z", summary: "Command finished (exit 0)", exitCode: 0, artifactId: null }] : [] };
  } } as unknown as TaskService;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user_sse" } as never; });
  await app.register(developmentEvents, { tasks });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  try {
    const response = await fetch(`${address}/api/tasks/task_sse/development-events`, { headers: { "Last-Event-ID": `${executionId}:1` }, signal: controller.signal });
    const reader = response.body!.getReader();
    let body = "";
    while (!body.includes("event: progress")) body += new TextDecoder().decode((await reader.read()).value);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(cursors[0]).toEqual({ executionId, sequence: 1 });
    expect(body).toContain("event: status");
    expect(body).toContain(`id: ${executionId}:2\nevent: progress`);
    expect(body).not.toContain(`id: ${executionId}:1\n`);
  } finally {
    controller.abort();
    await app.close();
  }
});

test("Planning SSE uses the same ordered event framing", async () => {
  const executionId = `agent_${"b".repeat(24)}`;
  const tasks = { getPlanningProgress(_actorUserId: string, _taskId: string) {
    return { status: "running", execution: { id: executionId, status: "running", startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null, lastHeartbeatAt: "2026-08-13T00:00:01.000Z", currentStep: null }, events: [{ eventId: "planning_event", sequence: 1, kind: "agent_update", stepNumber: null, occurredAt: "2026-08-13T00:00:02.000Z", summary: "Inspecting the README.", exitCode: null, artifactId: null }] };
  }, getDeveloperProgress() { return { status: "idle", execution: null, events: [] }; } } as unknown as TaskService;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user_sse" } as never; });
  await app.register(developmentEvents, { tasks });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  try {
    const response = await fetch(`${address}/api/tasks/task_sse/planning-events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let body = "";
    while (!body.includes("event: progress")) body += new TextDecoder().decode((await reader.read()).value);
    expect(body).toContain(`id: ${executionId}:1\nevent: progress`);
    expect(body).toContain("Inspecting the README.");
  } finally {
    controller.abort();
    await app.close();
  }
});
