import type { FastifyInstance } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import { HermesAgentFailure, type HermesAgentService, type HermesPrincipal } from "../../hermes-agents.js";
import { HermesSafeTaskProjectionSchema, HermesTaskCreateBodySchema, HermesTaskIdParamsSchema } from "../contracts/hermes.js";
import type { TaskService } from "../../tasks.js";

function authenticateBearer(header: string | undefined, hermes: HermesAgentService): HermesPrincipal {
  if (!header || !header.startsWith("Bearer ")) {
    throw new HermesAgentFailure("Authentication failed", 401, "credential_invalid");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new HermesAgentFailure("Authentication failed", 401, "credential_invalid");
  }
  return hermes.authenticate(token);
}

export function registerHermesTaskRoutes(app: FastifyInstance, options: { hermes: HermesAgentService; tasks: TaskService }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post("/api/hermes/tasks", {
    schema: {
      body: HermesTaskCreateBodySchema,
      response: { 200: HermesSafeTaskProjectionSchema, 201: HermesSafeTaskProjectionSchema },
    },
  }, async (request, reply) => {
    const principal = authenticateBearer(request.headers.authorization, options.hermes);
    const result = await options.tasks.createTaskForHermes(principal, request.body);
    reply.header("Cache-Control", "private, no-store");
    return reply.code(result.created ? 201 : 200).send(result.task);
  });

  typed.get("/api/hermes/tasks/:taskId", {
    schema: {
      params: HermesTaskIdParamsSchema,
      response: { 200: HermesSafeTaskProjectionSchema },
    },
  }, async (request, reply) => {
    const principal = authenticateBearer(request.headers.authorization, options.hermes);
    const task = options.tasks.getHermesTask(principal, request.params.taskId);
    reply.header("Cache-Control", "private, no-store");
    return reply.code(200).send(task);
  });
}
