import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { TaskEvent } from "../../tasks.js";
import type { TaskService } from "../../tasks.js";
import type { ProjectRole } from "../../projects.js";
import type { PlanCommandInput } from "../../temporal/issue-contracts.js";
import type { PlanBlockerSubject } from "../../plan-governance.js";
import { CompanyIdParamsSchema, ExpectedRevisionBodySchema, ExpectedRevisionNoteBodySchema, HttpPlanBlockerResponseBodySchema, HttpPlanDecisionBodySchema, HttpSupplementalReviewBodySchema, RequiredRevisionNoteBodySchema, TaskArtifactParamsSchema, TaskExecutionParamsSchema, TaskIdParamsSchema } from "../contracts/common.js";
import { ContinueWorkBodySchema, ContinueWorkResponseSchema, DeveloperExecutionEventsResponseSchema, PlanRevisionBodySchema, TaskBodySchema, TaskDeveloperDiffResponseSchema, TaskListResponseSchema, TaskReleaseResponseSchema, TaskResponseSchema } from "../contracts/tasks.js";

export interface TaskRoutesOptions {
  tasks: TaskService;
}

function cleanRoleProfiles(value: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined }): Partial<Record<ProjectRole, string>> {
  const result: Partial<Record<ProjectRole, string>> = {};
  if (value.lead !== undefined) result.lead = value.lead;
  if (value.developer !== undefined) result.developer = value.developer;
  if (value.reviewer !== undefined) result.reviewer = value.reviewer;
  return result;
}

const tasks: FastifyPluginAsync<TaskRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { tasks } = options;
  const taskResponse = { response: { 200: TaskResponseSchema } };
  const revisionSchema = { body: ExpectedRevisionBodySchema, response: { 200: TaskResponseSchema } };
  const noteSchema = { body: ExpectedRevisionNoteBodySchema, response: { 200: TaskResponseSchema } };
  const requiredNoteSchema = { body: RequiredRevisionNoteBodySchema, response: { 200: TaskResponseSchema } };

  typed.get("/api/tasks", { schema: { response: { 200: TaskListResponseSchema } } }, async (request, reply) => reply.send({ tasks: tasks.listTasks(request.forgeUser.id) }));
  typed.get("/api/companies/:companyId/tasks", { schema: { params: CompanyIdParamsSchema, response: { 200: TaskListResponseSchema } } }, async (request, reply) => reply.send({ tasks: tasks.listTasks(request.forgeUser.id, request.params.companyId) }));
  typed.post("/api/companies/:companyId/tasks", { schema: { params: CompanyIdParamsSchema, body: TaskBodySchema, response: { 200: TaskResponseSchema, 201: TaskResponseSchema } } }, async (request, reply) => {
    const { roleProfiles: rawRoleProfiles, ...body } = request.body;
    const result = await tasks.createTask(request.forgeUser.id, request.params.companyId, { ...body, ...(rawRoleProfiles ? { roleProfiles: cleanRoleProfiles(rawRoleProfiles) } : {}) });
    return reply.code(result.created ? 201 : 200).send(result.task);
  });
  typed.get("/api/tasks/:taskId", { schema: { params: TaskIdParamsSchema, ...taskResponse } }, async (request, reply) => reply.send(tasks.getTask(request.forgeUser.id, request.params.taskId)));
  typed.get("/api/tasks/:taskId/release", { schema: { params: TaskIdParamsSchema, response: { 200: TaskReleaseResponseSchema, 404: z.object({ error: z.string() }) } } }, async (request, reply) => {
    const release = tasks.getRelease(request.forgeUser.id, request.params.taskId);
    if (!release) return reply.code(404).send({ error: "Not found" });
    return reply.header("Cache-Control", "private, no-store").send(release);
  });
  typed.get("/api/tasks/:taskId/developer-diff", { schema: { params: TaskIdParamsSchema, response: { 200: TaskDeveloperDiffResponseSchema } } }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(await tasks.getDeveloperDiff(request.forgeUser.id, request.params.taskId));
  });
  typed.post("/api/tasks/:taskId/start-planning", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.startPlanning(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/request-supplemental-review", { schema: { params: TaskIdParamsSchema, body: HttpSupplementalReviewBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => {
    const body = request.body;
    return reply.send(await tasks.requestSupplementalReview(request.forgeUser.id, request.params.taskId, { expectedRevision: body.expectedRevision, actorUserId: request.forgeUser.id, subject: body.subject as PlanCommandInput["subject"], idempotencyKey: body.idempotencyKey }));
  });
  typed.post("/api/tasks/:taskId/approve-plan", { schema: { params: TaskIdParamsSchema, body: HttpPlanDecisionBodySchema.extend({ expectedRevision: ExpectedRevisionBodySchema.shape.expectedRevision }), response: { 200: TaskResponseSchema } } }, async (request, reply) => {
    const body = request.body;
    return reply.send(await tasks.approvePlanCommand(request.forgeUser.id, request.params.taskId, { expectedRevision: body.expectedRevision, actorUserId: request.forgeUser.id, subject: body.subject as PlanCommandInput["subject"], note: body.note, idempotencyKey: body.idempotencyKey }));
  });
  typed.post("/api/tasks/:taskId/reject-plan", { schema: { params: TaskIdParamsSchema, body: HttpPlanDecisionBodySchema.extend({ expectedRevision: ExpectedRevisionBodySchema.shape.expectedRevision }), response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.requestPlanRevision(request.forgeUser.id, request.params.taskId, { expectedRevision: request.body.expectedRevision, actorUserId: request.forgeUser.id, subject: request.body.subject as PlanCommandInput["subject"], note: request.body.note, idempotencyKey: request.body.idempotencyKey })));
  typed.post("/api/tasks/:taskId/request-plan-revision", { schema: { params: TaskIdParamsSchema, body: HttpPlanDecisionBodySchema.extend({ expectedRevision: ExpectedRevisionBodySchema.shape.expectedRevision }), response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.requestPlanRevision(request.forgeUser.id, request.params.taskId, { expectedRevision: request.body.expectedRevision, actorUserId: request.forgeUser.id, subject: request.body.subject as PlanCommandInput["subject"], note: request.body.note, idempotencyKey: request.body.idempotencyKey })));
  typed.post("/api/tasks/:taskId/respond-plan-blocker", { schema: { params: TaskIdParamsSchema, body: HttpPlanBlockerResponseBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.respondPlanBlocker(request.forgeUser.id, request.params.taskId, { expectedRevision: request.body.expectedWorkflowRevision, expectedWorkflowRevision: request.body.expectedWorkflowRevision, actorUserId: request.forgeUser.id, subject: request.body.subject as PlanCommandInput["subject"], blockerSubject: request.body.subject as PlanBlockerSubject, note: request.body.answer, idempotencyKey: request.body.idempotencyKey })));
  typed.post("/api/tasks/:taskId/revise-plan", { schema: { params: TaskIdParamsSchema, body: PlanRevisionBodySchema, response: { 200: TaskResponseSchema } } }, async (request, reply) => reply.send(await tasks.revisePlan(request.forgeUser.id, request.params.taskId, { ...request.body, actorUserId: request.forgeUser.id })));
  typed.post("/api/tasks/:taskId/continue-work", { schema: { params: TaskIdParamsSchema, body: ContinueWorkBodySchema, response: { 200: ContinueWorkResponseSchema } } }, async (request, reply) => reply.send(await tasks.continueWork(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.reason)));
  typed.post("/api/tasks/:taskId/start-development", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.startDevelopment(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/review-delivery", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.reviewDelivery(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/repair-delivery", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.repairDelivery(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/record-delivery-decision", { schema: { params: TaskIdParamsSchema, ...noteSchema } }, async (request, reply) => reply.send(await tasks.recordDeliveryDecision(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.note)));
  typed.post("/api/tasks/:taskId/retry-development", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.retryDevelopment(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/cancel-development", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.cancelDevelopment(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/verify-developer-ownership", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.verifyDeveloperOwnership(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));

  typed.post("/api/tasks/:taskId/publish-draft", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.publishDraft(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/resolve-merge-conflict", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.resolveMergeConflict(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/retry-target-base-reconciliation", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.retryTargetBaseReconciliation(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/retry-forward-merge-verification", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.retryForwardMergeVerification(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/reconcile-ci", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.reconcileCI(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/repair-ci", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.repairCI(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/final-review", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.finalReview(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/accept-delivery", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.acceptDelivery(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/request-delivery-changes", { schema: { params: TaskIdParamsSchema, ...requiredNoteSchema } }, async (request, reply) => reply.send(await tasks.requestDeliveryChanges(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.note)));
  typed.post("/api/tasks/:taskId/cancel", { schema: { params: TaskIdParamsSchema, ...noteSchema } }, async (request, reply) => reply.send(await tasks.cancelIssue(request.forgeUser.id, request.params.taskId, request.body.expectedRevision, request.body.note)));
  typed.post("/api/tasks/:taskId/reconcile-acceptance", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.reconcileAcceptance(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/reconcile-merge", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.reconcileMerge(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));
  typed.post("/api/tasks/:taskId/retry-capacity", { schema: { params: TaskIdParamsSchema, ...revisionSchema } }, async (request, reply) => reply.send(await tasks.retryCapacity(request.forgeUser.id, request.params.taskId, request.body.expectedRevision)));

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
