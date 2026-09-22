import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";

import type { AgentProfileService } from "../../profiles/agent-profiles.js";
import type { AuthService } from "../../identity/auth.js";
import type { SuplexDatabase } from "../../platform/database.js";
import type { ProjectService } from "../../projects/projects.js";
import type { SuplexConfig } from "../../platform/config.js";
import { AuditEventListResponseSchema, CredentialIdParamsSchema, CredentialListResponseSchema, ErrorResponseSchema, InvitationResponseSchema, InvitationSummaryListResponseSchema, UserIdParamsSchema, UserListResponseSchema } from "../contracts/common.js";
import { DisplayNameBodySchema } from "../contracts/auth.js";
import { ProfileBodySchema, ProfilePatchBodySchema, ProfileResponseSchema, ProfileListQuerySchema, ProfileListResponseSchema, ModelListResponseSchema } from "../contracts/projects.js";
import { ProviderListResponseSchema, type ProviderListResponse } from "../contracts/providers.js";
import { ProviderInstanceCreateBodySchema, ProviderInstanceListResponseSchema, ProviderInstanceSchema, type ProviderInstance } from "../contracts/providers.js";
import type { ProviderInstanceService } from "../../profiles/provider-instances.js";
import { createProviderConnectionProbe, providerConnectionFromHealth } from "../../profiles/provider-connection.js";
import { createProviderReadinessCheck } from "../../profiles/provider-readiness.js";
import { readProviders as readHostProviders, type ReadProviders } from "../../profiles/provider-catalog.js";
import { MAX_MIN_FREE_DISK_GB, readEnvironmentSettings, updateEnvironmentSettings } from "../../platform/environment-settings.js";

const EnvironmentSettingsSchema = z.object({ minFreeDiskGb: z.number(), defaultBudgetUsd: z.number(), defaultMaxTurns: z.number().int() });
const EnvironmentSettingsBodySchema = z.object({ minFreeDiskGb: z.number().finite().min(0).max(MAX_MIN_FREE_DISK_GB).optional(), defaultBudgetUsd: z.number().finite().min(0).optional(), defaultMaxTurns: z.number().int().min(0).optional() }).refine((body) => Object.keys(body).length > 0);

export interface AdministrationRoutesOptions {
  auth: AuthService;
  projects?: ProjectService;
  profiles?: AgentProfileService;
  database?: SuplexDatabase;
  config?: SuplexConfig;
  readProviders?: ReadProviders;
  providerInstances?: ProviderInstanceService;
  readProviderInstanceReadiness?: (homeDirectory: string) => Promise<{ status: "healthy" | "warning" | "unhealthy"; summary: string }>;
}

const administration: FastifyPluginAsync<AdministrationRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { auth, projects, profiles, database } = options;
  const requireAdmin = (role: string, reply: FastifyReply): boolean => {
    if (role === "admin") return true;
    reply.code(403).send({ error: "Administrator access required" });
    return false;
  };
  typed.get("/api/admin/environment", { schema: { response: { 200: EnvironmentSettingsSchema, 403: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.suplexUser.role, reply)) return;
    if (!database) throw new Error("Database is unavailable");
    return reply.header("Cache-Control", "private, no-store").send(readEnvironmentSettings(database));
  });
  typed.patch("/api/admin/environment", { schema: { body: EnvironmentSettingsBodySchema, response: { 200: EnvironmentSettingsSchema, 403: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.suplexUser.role, reply)) return;
    if (!database) throw new Error("Database is unavailable");
    const previous = readEnvironmentSettings(database);
    const updated = updateEnvironmentSettings(database, { minFreeDiskGb: request.body.minFreeDiskGb ?? previous.minFreeDiskGb, defaultBudgetUsd: request.body.defaultBudgetUsd ?? previous.defaultBudgetUsd, defaultMaxTurns: request.body.defaultMaxTurns ?? previous.defaultMaxTurns });
    auth.recordAuditEvent(request.suplexUser.id, "environment_settings_updated", undefined, undefined, { previousMinFreeDiskGb: String(previous.minFreeDiskGb), minFreeDiskGb: String(updated.minFreeDiskGb), previousDefaultBudgetUsd: String(previous.defaultBudgetUsd), defaultBudgetUsd: String(updated.defaultBudgetUsd), previousDefaultMaxTurns: String(previous.defaultMaxTurns), defaultMaxTurns: String(updated.defaultMaxTurns) });
    return reply.header("Cache-Control", "private, no-store").send(updated);
  });
  const readProviders = options.readProviders ?? (() => readHostProviders({ directory: process.cwd(), connection: createProviderConnectionProbe() }));
  let providerObservation: Promise<ProviderListResponse> | undefined;
  typed.get("/api/admin/providers", { schema: { response: { 200: ProviderListResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
    if (!requireAdmin(request.suplexUser.role, reply)) return;
    reply.header("Cache-Control", "private, no-store");
    try {
      providerObservation ??= readProviders().finally(() => { providerObservation = undefined; });
      return reply.send(await providerObservation);
    } catch (error) {
      request.log.warn({ err: error }, "Provider observation failed");
      return reply.code(503).send({ error: "Provider configuration is not available. Check OpenCode or Claude Code on the Suplex host." });
    }
  });
  if (options.providerInstances) {
    let instanceObservation: Promise<ProviderInstance[]> | undefined;
    const readiness = options.readProviderInstanceReadiness ?? (async (homeDirectory: string) => {
      const check = await createProviderReadinessCheck("claude-code", { env: { ...process.env, CLAUDE_CONFIG_DIR: homeDirectory } })();
      return { status: check.status, summary: check.summary };
    });
    typed.get("/api/admin/provider-instances", { schema: { response: { 200: ProviderInstanceListResponseSchema } } }, async request => {
      instanceObservation ??= Promise.resolve(options.providerInstances!.list(request.suplexUser.id)).finally(() => { instanceObservation = undefined; });
      const instances = await instanceObservation;
      return { instances: await Promise.all(instances.map(async instance => {
        const check = await readiness(instance.homeDirectory);
        return { ...instance, readiness: check, connection: providerConnectionFromHealth(check) };
      })) };
    });
    typed.post("/api/admin/provider-instances", { schema: { body: ProviderInstanceCreateBodySchema, response: { 201: ProviderInstanceSchema } } }, async (request, reply) => reply.code(201).send(await options.providerInstances!.create(request.suplexUser.id, request.body)));
    typed.delete("/api/admin/provider-instances/:instanceId", { schema: { params: z.object({ instanceId: z.string() }), response: { 204: z.null() } } }, async (request, reply) => { await options.providerInstances!.delete(request.suplexUser.id, request.params.instanceId); return reply.code(204).send(null); });
  }
  typed.post("/api/admin/invitations", { schema: { body: DisplayNameBodySchema, response: { 201: InvitationResponseSchema } } }, async (request, reply) => reply.code(201).send(auth.inviteUser(request.suplexUser.id, { displayName: request.body.displayName })));
  typed.get("/api/admin/invitations", { schema: { response: { 200: InvitationSummaryListResponseSchema } } }, async (request, reply) => reply.send({ invitations: auth.listInvitations(request.suplexUser.id) }));
  typed.get("/api/admin/users", { schema: { response: { 200: UserListResponseSchema } } }, async (request, reply) => reply.send({ users: auth.listUsers(request.suplexUser.id) }));
  typed.get("/api/admin/credentials", { schema: { response: { 200: CredentialListResponseSchema } } }, async (request, reply) => reply.send({ credentials: auth.listCredentials(request.suplexUser.id) }));
  typed.post("/api/admin/credentials/:credentialId/revoke", { schema: { params: CredentialIdParamsSchema } }, async (request, reply) => {
    auth.revokeCredential(request.suplexUser.id, request.params.credentialId);
    return reply.code(204).send();
  });
  typed.post("/api/admin/users/:userId/revoke", { schema: { params: UserIdParamsSchema } }, async (request, reply) => {
    auth.revokeUser(request.suplexUser.id, request.params.userId);
    return reply.code(204).send();
  });
  typed.get("/api/admin/audit", { schema: { response: { 200: AuditEventListResponseSchema } } }, async (request, reply) => reply.send({ events: auth.listAuditEvents(request.suplexUser.id) }));
  if (profiles) {
    typed.get("/api/profiles", { schema: { querystring: ProfileListQuerySchema, response: { 200: ProfileListResponseSchema } } }, async (request, reply) => reply.send({ profiles: profiles.list(request.suplexUser.id, request.query.includeArchived === "true") }));
    typed.post("/api/admin/profiles", { schema: { body: ProfileBodySchema, response: { 201: ProfileResponseSchema } } }, async (request, reply) => reply.code(201).send(profiles.create(request.suplexUser.id, request.body)));
    typed.patch("/api/admin/profiles/:agentId", { schema: { params: z.object({ agentId: z.string() }), body: ProfilePatchBodySchema, response: { 200: ProfileResponseSchema } } }, async (request, reply) => reply.send(profiles.update(request.suplexUser.id, request.params.agentId, request.body)));
    typed.post("/api/admin/profiles/:agentId/duplicate", { schema: { params: z.object({ agentId: z.string() }), response: { 201: ProfileResponseSchema } } }, async (request, reply) => reply.code(201).send(profiles.duplicate(request.suplexUser.id, request.params.agentId)));
    typed.delete("/api/admin/profiles/:agentId", { schema: { params: z.object({ agentId: z.string() }), response: { 204: z.null() } } }, async (request, reply) => { profiles.delete(request.suplexUser.id, request.params.agentId); return reply.code(204).send(null); });
  }
  if (projects) {
    typed.get("/api/admin/models", { schema: { response: { 200: ModelListResponseSchema } } }, async (request, reply) => reply.send({ models: await projects.listModels(request.suplexUser.id) }));
  }
};

export default administration;
