import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import { HermesAgentFailure, type HermesAgentService, type HermesPrincipal } from "../../identity/hermes-agents.js";
import {
  HermesDeliveryDecisionBodySchema, HermesDeliveryDecisionResponseSchema, HermesDeliveryRefreshResponseSchema, HermesDeliveryRepairResponseSchema,
  HermesIdentityResponseSchema, HermesMergeApprovalBodySchema, HermesMergeApprovalResponseSchema, HermesMergeBodySchema, HermesMergeResponseSchema,
  HermesMergeTrainQuerySchema, HermesMergeTrainResponseSchema, HermesProvenanceResponseSchema, HermesRuntimeOperations,
  HermesSafeTaskProjectionSchema, HermesTaskDependenciesBodySchema, HermesTaskIdParamsSchema,
  HermesTaskListQuerySchema, HermesTaskListResponseSchema, HermesTaskReadProjectionSchema, hermesRuntimeOpenApi,
} from "../contracts/hermes.js";
import type { AgentDeliveryService } from "../../delivery/agent-delivery.js";
import { TaskFailure, type HermesGithubPort, type TaskService } from "../../tasks/tasks.js";
import type { TaskHost } from "../../tasks/host.js";
import { DeliveryTargetSchema } from "../../tasks/contracts.js";

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

export function registerHermesTaskRoutes(app: FastifyInstance, options: { hermes: HermesAgentService; tasks: TaskService; host?: Pick<TaskHost, "recover">; github?: HermesGithubPort; agentDelivery?: AgentDeliveryService }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = (header: string | undefined): HermesPrincipal => authenticateHermesBearer(header, options.hermes);
  const noStore = { "Cache-Control": "private, no-store" };

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

  // The reported surface is the registered surface: an agent reads what this deployment actually accepts.
  const agentDelivery = Boolean(options.agentDelivery);
  typed.get("/api/hermes/capabilities", {
    config: { hermesRuntime: true },
    schema: { response: HermesRuntimeOperations.capabilities.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (_request, reply) => reply.header("Cache-Control", "private, no-store").send({
    apiVersion: "v1",
    capabilities: { read: { task: true }, create: { backlogTask: true, deliveryTargets: DeliveryTargetSchema.options }, taskControl: true, delivery: agentDelivery, merge: agentDelivery, humanDecisions: false },
    autonomousCommands: [
      "create_backlog_task", "start_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait",
      ...(agentDelivery ? ["observe_delivery", "request_delivery_repair", "decide_delivery_wait", "read_merge_train", "request_merge_approval", "merge_pull_request"] as const : []),
    ],
    humanOnlyRecords: ["task_human_answer"],
    unavailableCommands: agentDelivery ? ["answer_human_question", "deliver_task"] as const : ["answer_human_question", "deliver_task", "merge_pull_request"] as const,
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
    return reply.code(result.created ? 201 : 200).send(await options.tasks.readHermesTask(principal, result.task.id, options.github));
  });

  typed.get("/api/hermes/tasks/:taskId", {
    schema: {
      params: HermesRuntimeOperations.getTask.params,
      response: { ...HermesRuntimeOperations.getTask.response, 304: HermesTaskReadProjectionSchema.nullable() },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const task = await options.tasks.readHermesTask(principal, request.params.taskId, options.github);
    const etag = `\"${task.revision}\"`;
    reply.header("Cache-Control", "private, no-store");
    reply.header("ETag", etag);
    if (request.headers["if-match"] && request.headers["if-match"] !== etag) throw new TaskFailure("Task revision is stale", 412, "revision_stale");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send(null);
    return reply.code(200).send(task);
  });

  typed.post("/api/hermes/tasks/:taskId/commands", {
    config: { hermesRuntime: true },
    schema: { params: HermesRuntimeOperations.commandTask.params, body: HermesRuntimeOperations.commandTask.body, response: HermesRuntimeOperations.commandTask.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const task = await options.tasks.commandHermesTask(authenticate(request.headers.authorization), request.params.taskId, request.body);
    if (["start_task", "cancel_task", "send_task_note", "recheck_delivery_wait"].includes(request.body.command)) void options.host?.recover(task.id).catch(error => app.log.warn({ taskId: task.id, err: error }, "Task recovery will be retried"));
    return reply.header("Cache-Control", "private, no-store").code(200).send(task);
  });

  typed.get("/api/hermes/tasks", {
    schema: {
      querystring: HermesTaskListQuerySchema,
      response: { 200: HermesTaskListResponseSchema },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const query = request.query;
    const result = await options.tasks.readHermesTasks(principal, {
      limit: query.limit,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.updatedSince === undefined ? {} : { updatedSince: query.updatedSince }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.archived === undefined ? {} : { archived: query.archived === "true" }),
      ...(query.attention === undefined ? {} : { attention: query.attention === "true" }),
      ...(query.blocker === undefined ? {} : { blocker: query.blocker === "true" }),
      ...(query.filter === undefined ? {} : { filter: query.filter }),
    }, options.github);
    return reply.header("Cache-Control", "private, no-store").code(200).send(result);
  });

  typed.put("/api/hermes/tasks/:taskId/dependencies", {
    schema: {
      params: HermesTaskIdParamsSchema,
      body: HermesTaskDependenciesBodySchema,
      response: { 200: HermesSafeTaskProjectionSchema },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const task = options.tasks.setHermesTaskDependencies(principal, request.params.taskId, request.body.dependsOn);
    reply.headers(noStore);
    return reply.code(200).send(task);
  });

  const delivery = options.agentDelivery;
  if (!delivery) return;

  typed.get("/api/hermes/merge-train", {
    schema: { querystring: HermesMergeTrainQuerySchema, response: { 200: HermesMergeTrainResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.mergeTrain(principal, request.query.projectId);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.post("/api/hermes/tasks/:taskId/delivery/refresh", {
    schema: { params: HermesTaskIdParamsSchema, response: { 200: HermesDeliveryRefreshResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.refresh(principal, request.params.taskId);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.post("/api/hermes/tasks/:taskId/delivery/repair", {
    schema: { params: HermesTaskIdParamsSchema, response: { 202: HermesDeliveryRepairResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.requestReconciliation(principal, request.params.taskId);
    reply.headers(noStore);
    return reply.code(202).send(result);
  });

  typed.post("/api/hermes/tasks/:taskId/delivery/decision", {
    schema: { params: HermesTaskIdParamsSchema, body: HermesDeliveryDecisionBodySchema, response: { 200: HermesDeliveryDecisionResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = delivery.decide(principal, request.params.taskId, request.body.decision);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.post("/api/hermes/tasks/:taskId/delivery/approvals", {
    schema: { params: HermesTaskIdParamsSchema, body: HermesMergeApprovalBodySchema, response: { 201: HermesMergeApprovalResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.issueApproval(principal, request.params.taskId, request.body);
    reply.headers(noStore);
    return reply.code(201).send(result);
  });

  typed.post("/api/hermes/tasks/:taskId/delivery/merge", {
    schema: { params: HermesTaskIdParamsSchema, body: HermesMergeBodySchema, response: { 200: HermesMergeResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.merge(principal, request.params.taskId, request.body);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.get("/api/hermes/tasks/:taskId/delivery/provenance", {
    schema: { params: HermesTaskIdParamsSchema, response: { 200: HermesProvenanceResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const records = delivery.provenance(principal, request.params.taskId).map(record => ({
      id: record.id, attemptId: record.attempt_id, kind: record.kind, pullRequestNumber: record.pull_request_number,
      originalHeadSha: record.original_head_sha, headSha: record.head_sha, baseSha: record.base_sha,
      checks: record.checks_json === null ? null : JSON.parse(record.checks_json),
      merge: record.merge_json === null ? null : JSON.parse(record.merge_json),
      recordedAt: record.recorded_at,
    }));
    reply.headers(noStore);
    return reply.code(200).send({ records });
  });
}
