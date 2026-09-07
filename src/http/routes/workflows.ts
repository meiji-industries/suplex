import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import type { FastifyPluginAsync } from "fastify";

import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { WorkflowRecordService } from "../../workflow-records.js";
import { WorkflowListQuerySchema, WorkflowListResponseSchema, WorkflowRecordInputSchema, WorkflowRecordParamsSchema, WorkflowRecordPatchSchema, WorkflowRecordSchema } from "../contracts/workflows.js";
import { sessionUser } from "../session.js";

export interface WorkflowRoutesOptions { auth: AuthService; config: ForgeConfig; workflows: WorkflowRecordService; }

const workflowRoutes: FastifyPluginAsync<WorkflowRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.addHook("preHandler", async (request, reply) => {
    const user = await sessionUser(options.auth, request, reply, options.config);
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    request.forgeUser = user;
  });
  typed.get("/api/workflows", { schema: { querystring: WorkflowListQuerySchema, response: { 200: WorkflowListResponseSchema } } }, async (request, reply) => reply.send({ workflows: options.workflows.list(request.forgeUser.id, request.query.includeArchived === "true") }));
  typed.post("/api/admin/workflows", { schema: { body: WorkflowRecordInputSchema, response: { 201: WorkflowRecordSchema } } }, async (request, reply) => reply.code(201).send(options.workflows.create(request.forgeUser.id, request.body)));
  typed.patch("/api/admin/workflows/:workflowId", { schema: { params: WorkflowRecordParamsSchema, body: WorkflowRecordPatchSchema, response: { 200: WorkflowRecordSchema } } }, async (request, reply) => reply.send(options.workflows.update(request.forgeUser.id, request.params.workflowId, request.body)));
  typed.post("/api/admin/workflows/:workflowId/duplicate", { schema: { params: WorkflowRecordParamsSchema, response: { 201: WorkflowRecordSchema } } }, async (request, reply) => reply.code(201).send(options.workflows.duplicate(request.forgeUser.id, request.params.workflowId)));
};

export default workflowRoutes;
