import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";


import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { TaskTemplateService } from "../../task-templates.js";
import { CreateTaskTemplateBodySchema, ProjectTaskTemplatesParamsSchema, SaveTaskAsTemplateBodySchema, SaveTaskAsTemplateParamsSchema, TaskTemplateListResponseSchema, TaskTemplateParamsSchema, TaskTemplateResponseSchema, UpdateTaskTemplateBodySchema } from "../contracts/task-templates.js";
import { sessionUser } from "../session.js";
import { normalizeWorkflowInput, WorkflowInputFailure } from "../../workflows.js";

export interface TaskTemplateRoutesOptions { auth: AuthService; config: ForgeConfig; templates: TaskTemplateService; }

const taskTemplates: FastifyPluginAsync<TaskTemplateRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.addHook("preHandler", async (request, reply) => {
    const user = await sessionUser(options.auth, request, reply, options.config);
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    request.forgeUser = user;
  });
  typed.get("/api/projects/:projectId/task-templates", { schema: { params: ProjectTaskTemplatesParamsSchema, response: { 200: TaskTemplateListResponseSchema } } }, async (request, reply) => reply.send({ templates: options.templates.list(request.forgeUser.id, request.params.projectId) }));
  const normalizeWorkflow = async (request: { body: unknown }, reply: { code(status: number): { send(body: unknown): unknown } }): Promise<void> => {
    try { if (request.body && typeof request.body === "object") request.body = normalizeWorkflowInput(request.body as Record<string, unknown>, { requireSource: false }); }
    catch (error) { if (error instanceof WorkflowInputFailure) { reply.code(error.statusCode).send({ error: error.message }); return; } throw error; }
  };
  typed.post("/api/projects/:projectId/task-templates", { preValidation: normalizeWorkflow, schema: { params: ProjectTaskTemplatesParamsSchema, body: CreateTaskTemplateBodySchema, response: { 201: TaskTemplateResponseSchema } } }, async (request, reply) => reply.code(201).send(options.templates.create(request.forgeUser.id, request.params.projectId, request.body)));
  typed.post("/api/tasks/:taskId/save-as-template", { schema: { params: SaveTaskAsTemplateParamsSchema, body: SaveTaskAsTemplateBodySchema, response: { 201: TaskTemplateResponseSchema } } }, async (request, reply) => reply.code(201).send(options.templates.createFromTask(request.forgeUser.id, request.params.taskId, request.body.name)));
  typed.patch("/api/task-templates/:templateId", { schema: { params: TaskTemplateParamsSchema, body: UpdateTaskTemplateBodySchema, response: { 200: TaskTemplateResponseSchema } } }, async (request, reply) => reply.send(options.templates.update(request.forgeUser.id, request.params.templateId, request.body)));
  typed.delete("/api/task-templates/:templateId", { schema: { params: TaskTemplateParamsSchema, response: { 204: z.null() } } }, async (request, reply) => { options.templates.delete(request.forgeUser.id, request.params.templateId); return reply.code(204).send(null); });
};

export default taskTemplates;
