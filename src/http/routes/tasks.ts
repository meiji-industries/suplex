import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { TaskEvent } from "../../tasks.js";
import { TaskFailure, type TaskService } from "../../tasks.js";
import { GithubReleaseFailure, type ReleaseService } from "../../github-release.js";
import type { PlanCommandInput } from "../../temporal/issue-contracts.js";
import { routedIssueCommands, type IssueCommand } from "../../commands/registry.js";
import { CompanyIdParamsSchema, ExpectedRevisionBodySchema, HttpPlanDecisionBodySchema, ResolveDecisionBlockerBodySchema, TaskArtifactParamsSchema, TaskExecutionParamsSchema, TaskIdParamsSchema } from "../contracts/common.js";
import { ContinueWorkBodySchema, ContinueWorkResponseSchema, DeveloperExecutionEventsResponseSchema, DuplicateTaskBodySchema, PlanRevisionBodySchema, TaskAgentsBodySchema, TaskBodySchema, TaskDetailsBodySchema, TaskDeveloperDiffResponseSchema, TaskListResponseSchema, TaskReleaseResponseSchema, TaskResponseSchema } from "../contracts/tasks.js";
import developmentEvents from "./development-events.js";

export interface TaskRoutesOptions {
  tasks: TaskService;
  release?: ReleaseService;
}

const tasks: FastifyPluginAsync<TaskRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { tasks } = options;
  const taskResponse = { response: { 200: TaskResponseSchema } };
  await app.register(developmentEvents, { tasks });

  typed.get("/api/tasks", { schema: { response: { 200: TaskListResponseSchema } } }, async (request, reply) => reply.send({ tasks: tasks.listTasks(request.forgeUser.id) }));
  typed.get("/api/companies/:companyId/tasks", { schema: { params: CompanyIdParamsSchema, response: { 200: TaskListResponseSchema } } }, async (request, reply) => reply.send({ tasks: tasks.listTasks(request.forgeUser.id, request.params.companyId) }));
  typed.post("/api/companies/:companyId/tasks", { schema: { params: CompanyIdParamsSchema, body: TaskBodySchema, response: { 200: TaskResponseSchema, 201: TaskResponseSchema } } }, async (request, reply) => {
    const { roleAgents: rawRoleAgents, ...body } = request.body;
    const result = await tasks.createTask(request.forgeUser.id, request.params.companyId, { ...body, ...(rawRoleAgents ? { roleAgents: rawRoleAgents } : {}) });
    return reply.code(result.created ? 201 : 200).send(result.task);
  });
  typed.get("/api/tasks/:taskId", { schema: { params: TaskIdParamsSchema, ...taskResponse } }, async (request, reply) => reply.send(tasks.getTask(request.forgeUser.id, request.params.taskId)));
  typed.post("/api/tasks/:taskId/duplicate", { schema: { params: TaskIdParamsSchema, body: DuplicateTaskBodySchema, response: { 201: TaskResponseSchema } } }, async (request, reply) => reply.code(201).send(await tasks.duplicateTask(request.forgeUser.id, request.params.taskId, request.body.idempotencyKey)));
  typed.patch("/api/tasks/:taskId", { schema: { params: TaskIdParamsSchema, body: TaskDetailsBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.updateTaskDetails(request.forgeUser.id, request.params.taskId, request.body)));
  typed.patch("/api/tasks/:taskId/agents", { schema: { params: TaskIdParamsSchema, body: TaskAgentsBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(tasks.updateTaskAgents(request.forgeUser.id, request.params.taskId, request.body)));
  typed.get("/api/tasks/:taskId/release", { schema: { params: TaskIdParamsSchema, response: { 200: TaskReleaseResponseSchema, 404: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const release = tasks.getRelease(request.forgeUser.id, request.params.taskId);
    if (!release) return reply.code(404).send({ error: "Not found" });
    return reply.header("Cache-Control", "private, no-store").send(release);
  });
  if (options.release) typed.post("/api/tasks/:taskId/mark-ready", { schema: { params: TaskIdParamsSchema, body: ExpectedRevisionBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => {
    const task = tasks.getTask(request.forgeUser.id, request.params.taskId);
    if (request.body.expectedRevision !== task.revision) throw new TaskFailure("Task changed before this action was accepted", [], 409, task);
    const release = task.release;
    if (!release?.pullRequestUrl || release.pullRequestNumber === null || !release.isDraft) return reply.send(task);
    try {
      await options.release!.markReadyForReview({ taskId: task.id, companyId: task.companyId, workflowId: task.workflowId, releaseId: release.id, repository: release.repository, pullRequestNumber: release.pullRequestNumber });
    } catch (error) {
      if (error instanceof GithubReleaseFailure) throw new TaskFailure(error.summary, [], error.code === "provider-unavailable" || error.code === "provider-rate-limited" ? 503 : 409, task);
      throw error;
    }
    const updated = tasks.getTask(request.forgeUser.id, task.id);
    if (updated.allowedCommands.includes("reconcile_ci")) return reply.send(await tasks.executeCommand(request.forgeUser.id, task.id, "reconcile_ci", { expectedRevision: updated.revision }));
    return reply.send(updated);
  });
  typed.get("/api/tasks/:taskId/developer-diff", { schema: { params: TaskIdParamsSchema, response: { 200: TaskDeveloperDiffResponseSchema } } }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(await tasks.getDeveloperDiff(request.forgeUser.id, request.params.taskId));
  });
  for (const descriptor of routedIssueCommands) {
    typed.post(`/api/tasks/:taskId/${descriptor.slug!}`, { schema: { params: TaskIdParamsSchema, body: descriptor.body!, response: { 200: TaskResponseSchema } } }, async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      return reply.send(await tasks.executeCommand(request.forgeUser.id, request.params.taskId, descriptor.name as IssueCommand, {
        expectedRevision: (body.expectedRevision ?? body.expectedWorkflowRevision) as number,
        ...(body.note !== undefined ? { note: body.note as string } : {}),
        ...(body.answer !== undefined ? { note: body.answer as string } : {}),
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey as string } : {}),
      }));
    });
  }
  typed.post("/api/tasks/:taskId/resolve-decision-blocker", { schema: { params: TaskIdParamsSchema, body: ResolveDecisionBlockerBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.resolveDecisionBlocker(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.answer)));
  typed.post("/api/tasks/:taskId/reject-plan", { schema: { params: TaskIdParamsSchema, body: HttpPlanDecisionBodySchema.extend({ expectedRevision: ExpectedRevisionBodySchema.shape.expectedRevision }), response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.requestPlanRevision(request.forgeUser.id, request.params.taskId, { expectedRevision: request.body.expectedRevision, actorUserId: request.forgeUser.id, subject: request.body.subject as PlanCommandInput["subject"], note: request.body.note, idempotencyKey: request.body.idempotencyKey })));
  typed.post("/api/tasks/:taskId/revise-plan", { schema: { params: TaskIdParamsSchema, body: PlanRevisionBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.revisePlan(request.forgeUser.id, request.params.taskId, { ...request.body, actorUserId: request.forgeUser.id })));
  typed.post("/api/tasks/:taskId/continue-work", { schema: { params: TaskIdParamsSchema, body: ContinueWorkBodySchema, response: { 200: ContinueWorkResponseSchema } } }, async (request, reply) => reply.send(await tasks.continueWork(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.reason)));

  typed.get("/api/tasks/:taskId/images/:artifactId", { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const image = await tasks.getTaskImage(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").type(image.artifact.mimeType).send(image.bytes);
  });
  typed.get("/api/tasks/:taskId/developer-artifacts/:artifactId", { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const artifact = await tasks.getDeveloperArtifact(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").type(artifact.artifact.mimeType).send(artifact.bytes);
  });
  typed.get("/api/tasks/:taskId/developer-executions/:executionId/events", { schema: { params: TaskExecutionParamsSchema, response: { 200: DeveloperExecutionEventsResponseSchema } } }, async (request, reply) => {
    const events = tasks.getDeveloperExecutionEvents(request.forgeUser.id, request.params.taskId, request.params.executionId);
    return reply.header("Cache-Control", "private, no-store").send(events);
  });
  typed.get("/api/tasks/:taskId/review-artifacts/:artifactId", { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const artifact = await tasks.getTaskReviewArtifact(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").type(artifact.artifact.mimeType).send(artifact.bytes);
  });
  typed.get("/api/tasks/:taskId/artifacts/:artifactId", { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const artifact = await tasks.getTaskArtifact(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").type(artifact.artifact.mimeType).send(artifact.bytes);
  });
  typed.get("/api/tasks/:taskId/release/artifacts/:artifactId", { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const artifact = await tasks.getReleaseArtifact(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").type(artifact.mimeType).send(artifact.bytes);
  });
  typed.get("/api/tasks/:taskId/reconciliation-artifacts/:artifactId", { schema: { params: TaskArtifactParamsSchema } }, async (request, reply) => {
    const artifact = await tasks.getTargetBaseArtifact(request.forgeUser.id, request.params.taskId, request.params.artifactId);
    return reply.header("Cache-Control", "private, no-store").type(artifact.artifact.mimeType).send(artifact.bytes);
  });
  typed.get("/api/tasks/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" });
    const cursor = tasks.taskEventCursor();
    const send = (event: TaskEvent, eventCursor: number): void => { reply.raw.write(`id: ${eventCursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    const unsubscribe = tasks.subscribe(request.forgeUser.id, send, cursor);
    reply.raw.write(`id: ${cursor}\nevent: ready\ndata: {}\n\n`);
    request.raw.on("close", unsubscribe);
    return reply;
  });
};

export default tasks;
