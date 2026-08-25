import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { expect, test } from "vitest";

import agentEvents from "../src/http/routes/agent-events.js";

test("agent event history authorizes the task and resumes after a stream cursor", async () => {
  const calls: Array<{ userId: string; taskId: string; after: number }> = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("forgeUser", undefined as never);
  app.addHook("preHandler", (request, _reply, done) => { request.forgeUser = { id: "member" } as never; done(); });
  await app.register(agentEvents, { tasks: { getAgentEventHistory(userId: string, taskId: string, after: number) {
    calls.push({ userId, taskId, after });
    return { events: after ? [] : [{ streamId: 7, id: "timeline-7", eventType: "message", metadata: { kind: "message", data: { text: "Ready" } }, createdAt: "2026-08-24T00:00:00.000Z", executionId: "execution", executionRole: "planner", sessionId: "session", forgeTurnId: "turn" }], status: { phase: "planning", terminal: false } };
  } } as never });
  try {
    const first = await app.inject({ method: "GET", url: "/api/tasks/task/agent-events" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ events: [{ streamId: 7, executionId: "execution" }] });
    const resumed = await app.inject({ method: "GET", url: "/api/tasks/task/agent-events?after=0", headers: { "last-event-id": "7" } });
    expect(resumed.json()).toMatchObject({ events: [] });
    expect(calls).toEqual([{ userId: "member", taskId: "task", after: 0 }, { userId: "member", taskId: "task", after: 7 }]);
  } finally { await app.close(); }
});
