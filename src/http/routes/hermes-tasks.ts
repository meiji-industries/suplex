import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import { HermesAgentFailure, type HermesAgentService, type HermesPrincipal } from "../../identity/hermes-agents.js";
import { HermesIdentityResponseSchema, HermesRuntimeOperations, HermesSafeTaskProjectionSchema, HermesTaskListQuerySchema, HermesTaskListResponseSchema, hermesRuntimeOpenApi } from "../contracts/hermes.js";
import { TaskFailure, type TaskService } from "../../tasks/tasks.js";

export function authenticateHermesBearer(header: string | undefined, hermes: HermesAgentService): HermesPrincipal {
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
  const authenticate = (header: string | undefined): HermesPrincipal => authenticateHermesBearer(header, options.hermes);

  typed.get("/api/hermes/me", {
    schema: { response: { 200: HermesIdentityResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    return reply.header("Cache-Control", "private, no-store").code(200).send(options.tasks.hermesIdentity(principal));
  });

  typed.get("/api/hermes/openapi.json", {
    config: { hermesRuntime: true },
    schema: { response: HermesRuntimeOperations.openApi.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (_request, reply) => reply.header("Cache-Control", "private, no-store").send(hermesRuntimeOpenApi()));

  typed.get("/api/hermes/capabilities", {
    config: { hermesRuntime: true },
    schema: { response: HermesRuntimeOperations.capabilities.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (_request, reply) => reply.header("Cache-Control", "private, no-store").send({
    apiVersion: "v1",
    capabilities: { read: { task: true }, create: { backlogTask: true }, taskControl: false, delivery: false, merge: false, humanDecisions: false },
    autonomousCommands: ["create_backlog_task"],
    humanOnlyRecords: ["task_human_answer"],
    unavailableCommands: ["start_task", "cancel_task", "answer_human_question", "send_task_note", "deliver_task", "merge_pull_request"],
    pagination: { supported: false, cursor: false },
  }));

  typed.post("/api/hermes/tasks", {
    config: { hermesRuntime: true },
    schema: {
      body: HermesRuntimeOperations.createTask.body,
      response: HermesRuntimeOperations.createTask.response,
    },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await options.tasks.createTaskForHermes(principal, request.body);
    reply.header("Cache-Control", "private, no-store");
    return reply.code(result.created ? 201 : 200).send(result.task);
  });

  typed.get("/api/hermes/tasks/:taskId", {
    schema: {
      params: HermesRuntimeOperations.getTask.params,
      response: { ...HermesRuntimeOperations.getTask.response, 304: HermesSafeTaskProjectionSchema.nullable() },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const task = options.tasks.getHermesTask(principal, request.params.taskId);
    const etag = `\"${task.revision}\"`;
    reply.header("Cache-Control", "private, no-store");
    reply.header("ETag", etag);
    if (request.headers["if-match"] && request.headers["if-match"] !== etag) throw new TaskFailure("Task revision is stale", 412, "revision_stale");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send(null);
    return reply.code(200).send(task);
  });

  typed.get("/api/hermes/tasks", {
    schema: {
      querystring: HermesTaskListQuerySchema,
      response: { 200: HermesTaskListResponseSchema },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const query = request.query;
    const result = options.tasks.listHermesTasks(principal, {
      limit: query.limit,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.updatedSince === undefined ? {} : { updatedSince: query.updatedSince }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.archived === undefined ? {} : { archived: query.archived === "true" }),
      ...(query.attention === undefined ? {} : { attention: query.attention === "true" }),
      ...(query.blocker === undefined ? {} : { blocker: query.blocker === "true" }),
    });
    return reply.header("Cache-Control", "private, no-store").code(200).send(result);
  });
}
