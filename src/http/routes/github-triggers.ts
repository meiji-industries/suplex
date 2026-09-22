import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import type { FastifyPluginAsync } from "fastify";

import type { AuthService } from "../../identity/auth.js";
import type { SuplexConfig } from "../../platform/config.js";
import type { GithubTriggerService } from "../../integrations/github/triggers.js";
import { GithubTriggerActivityResponseSchema, GithubTriggerCompanyParamsSchema, GithubTriggerCreateSchema, GithubTriggerListSchema, GithubTriggerParamsSchema, GithubTriggerPatchSchema, GithubTriggerRuleSchema } from "../contracts/github-triggers.js";
import { sessionUser } from "../session.js";

export interface GithubTriggerRoutesOptions { auth: AuthService; config: SuplexConfig; triggers: GithubTriggerService; }

const githubTriggerRoutes: FastifyPluginAsync<GithubTriggerRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.addHook("preHandler", async (request, reply) => { const user = await sessionUser(options.auth, request, reply, options.config); if (!user) return reply.code(401).send({ error: "Authentication required" }); request.suplexUser = user; });
  typed.get("/api/companies/:companyId/github-triggers", { schema: { params: GithubTriggerCompanyParamsSchema, response: { 200: GithubTriggerListSchema } } }, async request => ({ rules: options.triggers.list(request.suplexUser.id, request.params.companyId) }));
  typed.post("/api/companies/:companyId/github-triggers", { schema: { params: GithubTriggerCompanyParamsSchema, body: GithubTriggerCreateSchema, response: { 201: GithubTriggerRuleSchema } } }, async (request, reply) => reply.code(201).send(await options.triggers.create(request.suplexUser.id, request.params.companyId, request.body)));
  typed.patch("/api/companies/:companyId/github-triggers/:ruleId", { schema: { params: GithubTriggerParamsSchema, body: GithubTriggerPatchSchema, response: { 200: GithubTriggerRuleSchema } } }, async request => options.triggers.update(request.suplexUser.id, request.params.companyId, request.params.ruleId, request.body));
  typed.post("/api/companies/:companyId/github-triggers/:ruleId/check", { schema: { params: GithubTriggerParamsSchema, response: { 200: GithubTriggerActivityResponseSchema } } }, async request => ({ activity: await options.triggers.check(request.suplexUser.id, request.params.companyId, request.params.ruleId) }));
  typed.get("/api/companies/:companyId/github-triggers/:ruleId/activity", { schema: { params: GithubTriggerParamsSchema, response: { 200: GithubTriggerActivityResponseSchema } } }, async request => ({ activity: options.triggers.activity(request.suplexUser.id, request.params.companyId, request.params.ruleId) }));
};

export default githubTriggerRoutes;
