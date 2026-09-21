import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import { ExternalAgentFailure, type ExternalAgentService, type ExternalAgentPrincipal } from "../../identity/external-agents.js";
import {
  AgentApiDeliveryDecisionBodySchema, AgentApiDeliveryDecisionResponseSchema, AgentApiDeliveryRefreshResponseSchema, AgentApiDeliveryRepairResponseSchema,
  AgentApiIdentityResponseSchema, AgentApiMergeApprovalBodySchema, AgentApiMergeApprovalResponseSchema, AgentApiMergeBodySchema, AgentApiMergeResponseSchema,
  AgentApiMergeTrainQuerySchema, AgentApiMergeTrainResponseSchema, AgentApiProvenanceResponseSchema, AgentApiRuntimeOperations,
  AgentApiProjectDiscoveryQuerySchema, AgentApiTemplateDiscoveryResponseSchema, AgentApiWorkflowDiscoveryResponseSchema,
  AgentApiTaskIdParamsSchema,
  AgentApiTaskListQuerySchema, AgentApiTaskListResponseSchema, AgentApiTaskReadProjectionSchema, agentApiRuntimeOpenApi,
} from "../contracts/agent-api.js";
import type { AgentDeliveryService } from "../../delivery/agent-delivery.js";
import { TaskFailure, type AgentApiGithubPort, type TaskService } from "../../tasks/tasks.js";
import type { TaskHost } from "../../tasks/host.js";
import { DeliveryTargetSchema } from "../../tasks/contracts.js";

export function authenticateAgentApiBearer(header: string | undefined, externalAgent: ExternalAgentService): ExternalAgentPrincipal {
  if (!header || !header.startsWith("Bearer ")) {
    throw new ExternalAgentFailure("Authentication failed", 401, "credential_invalid");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new ExternalAgentFailure("Authentication failed", 401, "credential_invalid");
  }
  return externalAgent.authenticate(token);
}

export function registerAgentApiTaskRoutes(app: FastifyInstance, options: { externalAgent: ExternalAgentService; tasks: TaskService; host?: Pick<TaskHost, "recover">; github?: AgentApiGithubPort; agentDelivery?: AgentDeliveryService }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = (header: string | undefined): ExternalAgentPrincipal => authenticateAgentApiBearer(header, options.externalAgent);
  const noStore = { "Cache-Control": "private, no-store" };
  const registerRoutes = (prefix: "/api/agent" | "/api/hermes"): void => {

  typed.get(`${prefix}/me`, {
    schema: { response: { 200: AgentApiIdentityResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    return reply.header("Cache-Control", "private, no-store").code(200).send(options.tasks.agentApiIdentity(principal));
  });

  typed.get(`${prefix}/openapi.json`, {
    config: { agentApiRuntime: true },
    schema: { response: AgentApiRuntimeOperations.openApi.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (_request, reply) => reply.header("Cache-Control", "private, no-store").send(agentApiRuntimeOpenApi()));

  // The reported surface is the registered surface: an agent reads what this deployment actually accepts.
  const agentDelivery = Boolean(options.agentDelivery);
  typed.get(`${prefix}/capabilities`, {
    config: { agentApiRuntime: true },
    schema: { response: AgentApiRuntimeOperations.capabilities.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (_request, reply) => reply.header("Cache-Control", "private, no-store").send({
    apiVersion: "v1",
    capabilities: { read: { task: true, workflows: true, templates: true }, create: { backlogTask: true, queuedTask: true, deliveryTargets: DeliveryTargetSchema.options }, taskControl: true, delivery: agentDelivery, merge: agentDelivery, humanDecisions: false },
    autonomousCommands: [
      "create_backlog_task", "create_queued_task", "start_task", "disarm_task", "cancel_task", "archive_task", "unarchive_task", "duplicate_task", "send_task_note", "recheck_delivery_wait",
      ...(agentDelivery ? ["observe_delivery", "request_delivery_repair", "decide_delivery_wait", "read_merge_train", "request_merge_approval", "merge_pull_request"] as const : []),
    ],
    humanOnlyRecords: ["task_human_answer"],
    unavailableCommands: agentDelivery ? ["answer_human_question", "deliver_task"] as const : ["answer_human_question", "deliver_task", "merge_pull_request"] as const,
    pagination: { supported: false, cursor: false },
  }));

  typed.get(`${prefix}/workflows`, {
    config: { agentApiRuntime: true },
    schema: { querystring: AgentApiProjectDiscoveryQuerySchema, response: { 200: AgentApiWorkflowDiscoveryResponseSchema } },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const workflows = options.tasks.listAgentApiWorkflows(authenticate(request.headers.authorization), request.query.projectId);
    return reply.header("Cache-Control", "private, no-store").code(200).send({ workflows });
  });

  typed.get(`${prefix}/templates`, {
    config: { agentApiRuntime: true },
    schema: { querystring: AgentApiProjectDiscoveryQuerySchema, response: { 200: AgentApiTemplateDiscoveryResponseSchema } },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const templates = options.tasks.listAgentApiTemplates(authenticate(request.headers.authorization), request.query.projectId);
    return reply.header("Cache-Control", "private, no-store").code(200).send({ templates });
  });

  typed.post(`${prefix}/tasks`, {
    config: { agentApiRuntime: true },
    schema: {
      body: AgentApiRuntimeOperations.createTask.body,
      response: AgentApiRuntimeOperations.createTask.response,
    },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await options.tasks.createTaskForAgentApi(principal, request.body);
    if (result.task.status === "active") void options.host?.recover(result.task.id).catch(error => app.log.warn({ taskId: result.task.id, err: error }, "Task recovery will be retried"));
    reply.header("Cache-Control", "private, no-store");
    return reply.code(result.created ? 201 : 200).send(await options.tasks.readAgentApiTask(principal, result.task.id, options.github));
  });

  typed.get(`${prefix}/tasks/:taskId`, {
    schema: {
      params: AgentApiRuntimeOperations.getTask.params,
      response: { ...AgentApiRuntimeOperations.getTask.response, 304: AgentApiTaskReadProjectionSchema.nullable() },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const task = await options.tasks.readAgentApiTask(principal, request.params.taskId, options.github);
    const etag = `\"${task.revision}\"`;
    reply.header("Cache-Control", "private, no-store");
    reply.header("ETag", etag);
    if (request.headers["if-match"] && request.headers["if-match"] !== etag) throw new TaskFailure("Task revision is stale", 412, "revision_stale");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send(null);
    return reply.code(200).send(task);
  });

  typed.post(`${prefix}/tasks/:taskId/commands`, {
    config: { agentApiRuntime: true },
    schema: { params: AgentApiRuntimeOperations.commandTask.params, body: AgentApiRuntimeOperations.commandTask.body, response: AgentApiRuntimeOperations.commandTask.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const task = await options.tasks.commandAgentApiTask(authenticate(request.headers.authorization), request.params.taskId, request.body);
    if (["start_task", "cancel_task", "send_task_note", "recheck_delivery_wait"].includes(request.body.command)) void options.host?.recover(task.id).catch(error => app.log.warn({ taskId: task.id, err: error }, "Task recovery will be retried"));
    return reply.header("Cache-Control", "private, no-store").code(200).send(task);
  });

  typed.get(`${prefix}/tasks`, {
    schema: {
      querystring: AgentApiTaskListQuerySchema,
      response: { 200: AgentApiTaskListResponseSchema },
    },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const query = request.query;
    const result = await options.tasks.readAgentApiTasks(principal, {
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

  typed.put(`${prefix}/tasks/:taskId/dependencies`, {
    config: { agentApiRuntime: true },
    schema: { params: AgentApiRuntimeOperations.setTaskDependencies.params, body: AgentApiRuntimeOperations.setTaskDependencies.body, response: AgentApiRuntimeOperations.setTaskDependencies.response },
    preValidation: async (request) => { authenticate(request.headers.authorization); },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const task = options.tasks.setAgentApiTaskDependencies(principal, request.params.taskId, request.body.dependsOn);
    reply.headers(noStore);
    return reply.code(200).send(task);
  });

  const delivery = options.agentDelivery;
  if (!delivery) return;

  typed.get(`${prefix}/merge-train`, {
    schema: { querystring: AgentApiMergeTrainQuerySchema, response: { 200: AgentApiMergeTrainResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.mergeTrain(principal, request.query.projectId);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.post(`${prefix}/tasks/:taskId/delivery/refresh`, {
    schema: { params: AgentApiTaskIdParamsSchema, response: { 200: AgentApiDeliveryRefreshResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.refresh(principal, request.params.taskId);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.post(`${prefix}/tasks/:taskId/delivery/repair`, {
    schema: { params: AgentApiTaskIdParamsSchema, response: { 202: AgentApiDeliveryRepairResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.requestReconciliation(principal, request.params.taskId);
    reply.headers(noStore);
    return reply.code(202).send(result);
  });

  typed.post(`${prefix}/tasks/:taskId/delivery/decision`, {
    schema: { params: AgentApiTaskIdParamsSchema, body: AgentApiDeliveryDecisionBodySchema, response: { 200: AgentApiDeliveryDecisionResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = delivery.decide(principal, request.params.taskId, request.body.decision);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.post(`${prefix}/tasks/:taskId/delivery/approvals`, {
    schema: { params: AgentApiTaskIdParamsSchema, body: AgentApiMergeApprovalBodySchema, response: { 201: AgentApiMergeApprovalResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.issueApproval(principal, request.params.taskId, request.body);
    reply.headers(noStore);
    return reply.code(201).send(result);
  });

  typed.post(`${prefix}/tasks/:taskId/delivery/merge`, {
    schema: { params: AgentApiTaskIdParamsSchema, body: AgentApiMergeBodySchema, response: { 200: AgentApiMergeResponseSchema } },
  }, async (request, reply) => {
    const principal = authenticate(request.headers.authorization);
    const result = await delivery.merge(principal, request.params.taskId, request.body);
    reply.headers(noStore);
    return reply.code(200).send(result);
  });

  typed.get(`${prefix}/tasks/:taskId/delivery/provenance`, {
    schema: { params: AgentApiTaskIdParamsSchema, response: { 200: AgentApiProvenanceResponseSchema } },
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
  };

  registerRoutes("/api/agent");
  registerRoutes("/api/hermes");
}
