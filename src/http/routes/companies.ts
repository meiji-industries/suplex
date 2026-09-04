import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AuthService } from "../../auth.js";
import { CompanyIdParamsSchema, CompanyStatusParamsSchema, CompanyListResponseSchema, CompanyResponseSchema } from "../contracts/common.js";
import { CompanyIssueCodeBodySchema, CompanyNameBodySchema, MembershipBodySchema } from "../contracts/auth.js";
import { UserIdParamsSchema } from "../contracts/common.js";

export interface CompanyRoutesOptions {
  auth: AuthService;
}

const companies: FastifyPluginAsync<CompanyRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { auth } = options;
  typed.get("/api/companies", { schema: { response: { 200: CompanyListResponseSchema } } }, async (request, reply) => reply.send({ companies: auth.listVisibleCompanies(request.forgeUser.id) }));
  typed.get("/api/companies/:companyId", { schema: { params: CompanyIdParamsSchema, response: { 200: CompanyResponseSchema } } }, async (request, reply) => reply.send(auth.requireCompanyAccess(request.forgeUser.id, request.params.companyId)));
  typed.post("/api/admin/companies", { schema: { body: CompanyNameBodySchema, response: { 201: CompanyResponseSchema } } }, async (request, reply) => reply.code(201).send(auth.createCompany(request.forgeUser.id, request.body.name)));
  typed.patch("/api/admin/companies/:companyId", { schema: { params: CompanyIdParamsSchema, body: CompanyNameBodySchema, response: { 200: CompanyResponseSchema } } }, async (request, reply) => reply.send(auth.renameCompany(request.forgeUser.id, request.params.companyId, request.body.name)));
  typed.patch("/api/admin/companies/:companyId/issue-code", { schema: { params: CompanyIdParamsSchema, body: CompanyIssueCodeBodySchema, response: { 200: CompanyResponseSchema } } }, async (request, reply) => reply.send(auth.setCompanyIssueCode(request.forgeUser.id, request.params.companyId, request.body.issueCode)));
  typed.post("/api/admin/companies/:companyId/status/:status", { schema: { params: CompanyStatusParamsSchema, response: { 200: CompanyResponseSchema } } }, async (request, reply) => reply.send(auth.setCompanyStatus(request.forgeUser.id, request.params.companyId, request.params.status)));
  typed.post("/api/admin/companies/:companyId/clear", { schema: { params: CompanyIdParamsSchema, response: { 200: CompanyResponseSchema } } }, async (request, reply) => reply.send(await auth.clearCompany(request.forgeUser.id, request.params.companyId)));
  typed.post("/api/admin/companies/:companyId/members", { schema: { params: CompanyIdParamsSchema, body: MembershipBodySchema } }, async (request, reply) => {
    auth.addMembership(request.forgeUser.id, request.body.userId, request.params.companyId);
    return reply.code(204).send();
  });
  typed.delete("/api/admin/companies/:companyId/members/:userId", { schema: { params: CompanyIdParamsSchema.merge(UserIdParamsSchema) } }, async (request, reply) => {
    auth.removeMembership(request.forgeUser.id, request.params.userId, request.params.companyId);
    return reply.code(204).send();
  });
};

export default companies;
