import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { AttentionService } from "../../attention.js";
import type { AuthService } from "../../auth.js";
import type { ForgeDatabase } from "../../database.js";
import type { CapacityManager } from "../../capacity.js";
import type { ProjectService } from "../../projects.js";
import type { ForgeConfig } from "../../config.js";
import { ProjectionRebuildFailure, ProjectionRebuildService } from "../../projection-rebuild.js";
import { AuditEventListResponseSchema, CredentialIdParamsSchema, CredentialListResponseSchema, ErrorResponseSchema, InvitationResponseSchema, InvitationSummaryListResponseSchema, UserIdParamsSchema, UserListResponseSchema } from "../contracts/common.js";
import { DisplayNameBodySchema } from "../contracts/auth.js";
import { AdminCapacityListResponseSchema, AgentBodySchema, AgentPatchBodySchema, AgentResponseSchema, ModelBodySchema, ModelIdParamsSchema, ModelListResponseSchema, ModelResponseSchema, ModelStatusBodySchema } from "../contracts/projects.js";
import { ProviderListResponseSchema, type ProviderListResponse } from "../contracts/providers.js";
import { readOpenCodeProviders, type ReadOpenCodeProviders } from "../../opencode-providers.js";
import { MAX_MIN_FREE_DISK_GB, readEnvironmentSettings, updateEnvironmentSettings } from "../../environment-settings.js";

const ProjectionRebuildBodySchema = z.object({ companyId: z.string().optional(), taskId: z.string().optional() }).default({});
const EnvironmentSettingsSchema = z.object({ minFreeDiskGb: z.number() });
const EnvironmentSettingsBodySchema = z.object({ minFreeDiskGb: z.number().finite().min(0).max(MAX_MIN_FREE_DISK_GB) });

export interface AdministrationRoutesOptions {
  auth: AuthService;
  projects?: ProjectService;
  database?: ForgeDatabase;
  attention?: AttentionService;
  config?: ForgeConfig;
  capacity?: CapacityManager;
  readProviders?: ReadOpenCodeProviders;
}

const administration: FastifyPluginAsync<AdministrationRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { auth, projects, database, attention, config, capacity } = options;
  const requireAdmin = (role: string, reply: FastifyReply): boolean => {
    if (role === "admin") return true;
    reply.code(403).send({ error: "Administrator access required" });
    return false;
  };
  typed.get("/api/admin/environment", { schema: { response: { 200: EnvironmentSettingsSchema, 403: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.forgeUser.role, reply)) return;
    if (!database) throw new Error("Database is unavailable");
    return reply.header("Cache-Control", "private, no-store").send(readEnvironmentSettings(database));
  });
  typed.patch("/api/admin/environment", { schema: { body: EnvironmentSettingsBodySchema, response: { 200: EnvironmentSettingsSchema, 403: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.forgeUser.role, reply)) return;
    if (!database) throw new Error("Database is unavailable");
    const previous = readEnvironmentSettings(database);
    const updated = updateEnvironmentSettings(database, request.body);
    auth.recordAuditEvent(request.forgeUser.id, "environment_settings_updated", undefined, undefined, { previousMinFreeDiskGb: String(previous.minFreeDiskGb), minFreeDiskGb: String(updated.minFreeDiskGb) });
    return reply.header("Cache-Control", "private, no-store").send(updated);
  });
  const readProviders = options.readProviders ?? (() => readOpenCodeProviders({ directory: process.cwd() }));
  let providerObservation: Promise<ProviderListResponse> | undefined;
  typed.get("/api/admin/providers", { schema: { response: { 200: ProviderListResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.forgeUser.role, reply)) return;
    reply.header("Cache-Control", "private, no-store");
    try {
      providerObservation ??= readProviders().finally(() => { providerObservation = undefined; });
      return reply.send(await providerObservation);
    } catch (error) {
      request.log.warn({ err: error }, "OpenCode provider observation failed");
      return reply.code(503).send({ error: "OpenCode provider configuration is not available. Check OpenCode on the Forge host." });
    }
  });
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
    typed.post("/api/admin/agents", { schema: { body: AgentBodySchema, response: { 201: AgentResponseSchema } } }, async (request, reply) => reply.code(201).send(projects.createAgent(request.forgeUser.id, { ...request.body, capacity: request.body.capacity ?? null })));
    typed.patch("/api/admin/agents/:agentId", { schema: { params: z.object({ agentId: z.string() }), body: AgentPatchBodySchema, response: { 200: AgentResponseSchema } } }, async (request, reply) => reply.send(projects.updateAgent(request.forgeUser.id, request.params.agentId, request.body)));
    typed.post("/api/admin/agents/:agentId/duplicate", { schema: { params: z.object({ agentId: z.string() }), response: { 201: AgentResponseSchema } } }, async (request, reply) => reply.code(201).send(projects.duplicateAgent(request.forgeUser.id, request.params.agentId)));
    typed.get("/api/admin/models", { schema: { response: { 200: ModelListResponseSchema } } }, async (request, reply) => reply.send({ models: projects.listModels(request.forgeUser.id, true) }));
    typed.post("/api/admin/models", { schema: { body: ModelBodySchema, response: { 201: ModelResponseSchema } } }, async (request, reply) => reply.code(201).send(projects.createModel(request.forgeUser.id, request.body)));
    typed.patch("/api/admin/models/:modelId", { schema: { params: ModelIdParamsSchema, body: ModelStatusBodySchema, response: { 200: ModelResponseSchema } } }, async (request, reply) => reply.send(projects.setModelStatus(request.forgeUser.id, request.params.modelId, request.body.status)));
  }
  if (capacity) typed.get("/api/admin/capacity", { schema: { response: { 200: AdminCapacityListResponseSchema, 403: ErrorResponseSchema } } }, async (request, reply) => {
    if (request.forgeUser.role !== "admin") return reply.code(403).send({ error: "Administrator access required" });
    return reply.send({ lanes: capacity.listAdminLanes() });
  });
  if (database && attention) {
    typed.post("/api/admin/rebuild-projections", { schema: { body: ProjectionRebuildBodySchema, response: { 200: z.object({ source: z.literal("engine"), rebuilt: z.number(), findings: z.array(z.object({ taskId: z.string(), code: z.string(), summary: z.string() })) }), 403: ErrorResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
      if (request.forgeUser.role !== "admin") return reply.code(403).send({ error: "Administrator access required" });
      if (!config) return reply.code(503).send({ error: "Engine rebuild is unavailable" });
      let result;
      try {
        result = await new ProjectionRebuildService(database, config).rebuild({
          ...(request.body.companyId ? { companyId: request.body.companyId } : {}),
          ...(request.body.taskId ? { taskId: request.body.taskId } : {}),
        });
      } catch (error) {
        if (error instanceof ProjectionRebuildFailure) return reply.code(503).send({ error: error.message, code: error.code });
        throw error;
      }
      return reply.send({ source: "engine" as const, ...result });
    });
  }
};

export default administration;
