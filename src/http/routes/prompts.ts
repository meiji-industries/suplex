import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import { ForgeDatabase } from "../../database.js";
import { PromptOverrideFailure, PromptOverrideService } from "../../prompt-overrides.js";
import { loadPromptCatalog, type PromptTemplate } from "../../prompts.js";
import { resolvePrompt, validateOverrideContent, type PromptOverrideRow, type ResolvedPrompt } from "../../prompt-resolution.js";
import { ProjectService } from "../../projects.js";
import { sessionUser } from "../session.js";
import { PromptOverrideBodySchema, PromptPreviewBodySchema, PromptRollbackBodySchema, PromptScopeQuerySchema, PromptTemplateParamsSchema } from "../contracts/prompts.js";

export interface PromptRoutesOptions { auth: AuthService; config: ForgeConfig; database: ForgeDatabase; projects: ProjectService; }

type Scope = "global" | "project";

function templateId(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw new PromptOverrideFailure("Prompt template not found", 404); }
}

function templateView(template: PromptTemplate, override: PromptOverrideRow | undefined, resolved: ResolvedPrompt, revisions: unknown[] = []) {
  return { ...template, variables: [...template.variables], renamedFrom: [...template.renamedFrom], override: override ?? null, resolved, revisions };
}

const prompts: FastifyPluginAsync<PromptRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = new PromptOverrideService(options.database, options.auth, options.projects);
  typed.addHook("preHandler", async (request, reply) => {
    const user = await sessionUser(options.auth, request, reply, options.config);
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    request.forgeUser = user;
  });
  const view = (userId: string, scope: Scope, requestedProjectId: string | undefined, requestedTemplateId: string, includeHistory: boolean) => {
    const template = loadPromptCatalog().get(requestedTemplateId);
    if (!template) throw new PromptOverrideFailure("Prompt template not found", 404);
    const rows = service.listForScope(userId, scope, requestedProjectId);
    const override = rows.find((row) => row.templateId === requestedTemplateId || loadPromptCatalog().get(row.templateId)?.id === template.id);
    const resolved = scope === "global" ? resolvePrompt(template, override) : service.resolveForProject(requestedProjectId!).provenance[template.id]!;
    return templateView(template, override, resolved, includeHistory ? service.revisions(userId, scope, requestedTemplateId, requestedProjectId) : []);
  };
  const sendPromptFailure = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof PromptOverrideFailure) return reply.code(error.statusCode).send({ error: error.publicMessage, findings: error.findings });
    throw error;
  };

  typed.get("/api/prompts/templates", { schema: { querystring: PromptScopeQuerySchema } }, async (request, reply) => {
    const catalog = [...loadPromptCatalog().values()].filter((template, index, templates) => templates.findIndex(({ id }) => id === template.id) === index);
    return reply.send({ templates: catalog.map((template) => view(request.forgeUser.id, request.query.scope, request.query.projectId, template.id, false)) });
  });
  typed.get("/api/prompts/templates/:templateId", { schema: { params: PromptTemplateParamsSchema, querystring: PromptScopeQuerySchema } }, async (request, reply) => {
    try { return reply.send(view(request.forgeUser.id, request.query.scope, request.query.projectId, templateId(request.params.templateId), true)); } catch (error) { return sendPromptFailure(reply, error); }
  });
  typed.put("/api/prompts/templates/:templateId/override", { schema: { params: PromptTemplateParamsSchema, querystring: PromptScopeQuerySchema, body: PromptOverrideBodySchema } }, async (request, reply) => {
    try {
      const id = templateId(request.params.templateId);
      service.save(request.forgeUser.id, request.query.scope, id, request.body.note === undefined ? { mode: request.body.mode, content: request.body.content } : { mode: request.body.mode, content: request.body.content, note: request.body.note }, request.query.projectId);
      return reply.send(view(request.forgeUser.id, request.query.scope, request.query.projectId, id, true));
    } catch (error) { return sendPromptFailure(reply, error); }
  });
  typed.post("/api/prompts/templates/:templateId/preview", { schema: { params: PromptTemplateParamsSchema, querystring: PromptScopeQuerySchema, body: PromptPreviewBodySchema } }, async (request, reply) => {
    try {
      const id = templateId(request.params.templateId);
      const template = loadPromptCatalog().get(id);
      if (!template) throw new PromptOverrideFailure("Prompt template not found", 404);
      service.listForScope(request.forgeUser.id, request.query.scope, request.query.projectId);
      const findings = validateOverrideContent(template, request.body.content);
      const preview = { id: "preview", templateId: id, ...request.body, baseTemplateSha256: template.guidanceSha256, currentRevision: 0 };
      return reply.send({ resolved: resolvePrompt(template, request.query.scope === "global" ? preview : undefined, request.query.scope === "project" ? preview : undefined), findings });
    } catch (error) { return sendPromptFailure(reply, error); }
  });
  typed.post("/api/prompts/templates/:templateId/rollback", { schema: { params: PromptTemplateParamsSchema, querystring: PromptScopeQuerySchema, body: PromptRollbackBodySchema } }, async (request, reply) => {
    try {
      const id = templateId(request.params.templateId);
      service.rollback(request.forgeUser.id, request.query.scope, id, request.body.revision, request.query.projectId);
      return reply.send(view(request.forgeUser.id, request.query.scope, request.query.projectId, id, true));
    } catch (error) { return sendPromptFailure(reply, error); }
  });
};

export default prompts;
