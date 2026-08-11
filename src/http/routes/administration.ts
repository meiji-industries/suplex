import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { AttentionService } from "../../attention.js";
import type { AuthService } from "../../auth.js";
import type { ForgeDatabase } from "../../database.js";
import type { ProjectService } from "../../projects.js";
import { AuditEventListResponseSchema, CredentialIdParamsSchema, CredentialListResponseSchema, ErrorResponseSchema, InvitationResponseSchema, InvitationSummaryListResponseSchema, UserIdParamsSchema, UserListResponseSchema } from "../contracts/common.js";
import { DisplayNameBodySchema } from "../contracts/auth.js";
import { ProfileBodySchema, ProfileResponseSchema } from "../contracts/projects.js";

export interface AdministrationRoutesOptions {
  auth: AuthService;
  projects?: ProjectService;
  database?: ForgeDatabase;
  attention?: AttentionService;
}

const administration: FastifyPluginAsync<AdministrationRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { auth, projects, database, attention } = options;
  typed.post("/api/admin/invitations", { schema: { body: DisplayNameBodySchema, response: { 201: InvitationResponseSchema } } }, async (request, reply) => reply.code(201).send(auth.inviteUser(request.forgeUser.id, { displayName: request.body.displayName })));
  typed.get("/api/admin/invitations", { schema: { response: { 200: InvitationSummaryListResponseSchema } } }, async (request, reply) => reply.send({ invitations: auth.listInvitations(request.forgeUser.id) }));
  typed.get("/api/admin/users", { schema: { response: { 200: UserListResponseSchema } } }, async (request, reply) => reply.send({ users: auth.listUsers(request.forgeUser.id) }));
  typed.get("/api/admin/credentials", { schema: { response: { 200: CredentialListResponseSchema } } }, async (request, reply) => reply.send({ credentials: auth.listCredentials(request.forgeUser.id) }));
  typed.post("/api/admin/credentials/:credentialId/revoke", { schema: { params: CredentialIdParamsSchema } }, async (request, reply) => {
    auth.revokeCredential(request.forgeUser.id, request.params.credentialId);
    return reply.code(204).send();
  });
  typed.post("/api/admin/users/:userId/revoke", { schema: { params: UserIdParamsSchema } }, async (request, reply) => {
    auth.revokeUser(request.forgeUser.id, request.params.userId);
    return reply.code(204).send();
  });
  typed.get("/api/admin/audit", { schema: { response: { 200: AuditEventListResponseSchema } } }, async (request, reply) => reply.send({ events: auth.listAuditEvents(request.forgeUser.id) }));
  if (projects) {
    typed.post("/api/admin/profiles", { schema: { body: ProfileBodySchema, response: { 201: ProfileResponseSchema } } }, async (request, reply) => reply.code(201).send(projects.createProfile(request.forgeUser.id, request.body)));
  }
  if (database && attention) {
    typed.post("/api/admin/rebuild-projections", { schema: { response: { 200: z.object({ rebuilt: z.number() }), 403: ErrorResponseSchema } } }, async (request, reply) => {
      if (request.forgeUser.role !== "admin") return reply.code(403).send({ error: "Administrator access required" });
      const rebuilt = database.rebuildIssueProjections();
      for (const company of auth.listVisibleCompanies(request.forgeUser.id)) attention.rebuild(company.id);
      return reply.send({ rebuilt });
    });
  }
};

export default administration;
