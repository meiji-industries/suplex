import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { AuthFailure, type AuthService, type AuthUser } from "../../identity/auth.js";
import type { ForgeConfig } from "../../platform/config.js";
import type { HealthSnapshot } from "../../platform/health.js";
import type { AgentProfileService } from "../../profiles/agent-profiles.js";
import type { ProjectService } from "../../projects/projects.js";
import { profileHarness } from "../../runtimes/task-harness.js";
import type { ProviderHarnessKind } from "../../platform/health-contract.js";
import { HARNESS_KINDS } from "../../runtimes/task-harness-registry.js";
import { ErrorResponseSchema, HealthSnapshotResponseSchema } from "../contracts/common.js";
import { sessionUser } from "../session.js";

export interface HealthContext {
  providers: readonly ProviderHarnessKind[];
}

export interface HealthRoutesOptions {
  auth?: AuthService;
  config?: ForgeConfig;
  profiles?: AgentProfileService;
  projects?: ProjectService;
  readHealth: (force?: boolean, context?: HealthContext) => Promise<HealthSnapshot>;
}

export function cachedHealthReader(readHealth: () => Promise<HealthSnapshot>, now = Date.now): (force?: boolean) => Promise<HealthSnapshot> {
  const cacheTtlMs = 10_000;
  let cached: { snapshot: HealthSnapshot; expiresAt: number } | undefined;
  let pending: Promise<HealthSnapshot> | undefined;
  return async (force = false): Promise<HealthSnapshot> => {
    if (!force && cached && now() < cached.expiresAt) return cached.snapshot;
    if (!pending) {
      pending = readHealth().then((snapshot) => {
        cached = { snapshot, expiresAt: now() + cacheTtlMs };
        return snapshot;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

const HealthQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  profileIds: z.string().min(1).optional(),
}).strict();

/**
 * Resolves the requested provider context through the owning services. The
 * session user's authorization comes from AgentProfileService/ProjectService;
 * a context the user cannot read throws their not-found failure.
 */
function resolveProviderContext(options: HealthRoutesOptions, user: AuthUser, query: { projectId?: string | undefined; profileIds?: string | undefined }): HealthContext | undefined {
  if (query.projectId === undefined && query.profileIds === undefined) return undefined;
  if (query.projectId !== undefined && query.profileIds !== undefined) throw new AuthFailure("Select one provider context", 400);
  if (!options.profiles) throw new AuthFailure("Not found", 404);
  const profiles = new Map(options.profiles.list(user.id, true).map((profile) => [profile.id, profile.provider]));
  const profileIds = query.projectId !== undefined
    ? (() => {
      if (!options.projects) throw new AuthFailure("Not found", 404);
      const project = options.projects.getProject(user.id, query.projectId);
      return [project.rootProfileId, project.workerProfileId].filter((id) => profiles.has(id));
    })()
    : [...new Set(query.profileIds!.split(",").map((id) => id.trim()).filter((id) => id.length > 0))];
  if (query.profileIds !== undefined && profileIds.some((id) => !profiles.has(id))) throw new AuthFailure("Not found", 404);
  const providers = [...new Set(profileIds.map((id) => profileHarness(profiles.get(id)!)).filter((provider): provider is (typeof HARNESS_KINDS)[number] => HARNESS_KINDS.includes(provider as (typeof HARNESS_KINDS)[number])))];
  return { providers };
}

const health: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/health", { schema: { querystring: HealthQuerySchema, response: { 200: HealthSnapshotResponseSchema, 401: ErrorResponseSchema } } }, async (request, reply) => {
    const user = options.auth ? await sessionUser(options.auth, request, reply, options.config) : undefined;
    if (options.auth && !user) return reply.code(401).send({ error: "Authentication required" });
    const force = request.headers["cache-control"] === "no-cache";
    const wantsContext = request.query.projectId !== undefined || request.query.profileIds !== undefined;
    if (wantsContext && !user) return reply.code(401).send({ error: "Authentication required" });
    const context = user === undefined ? undefined : resolveProviderContext(options, user, request.query);
    return reply.send(await options.readHealth(force, context));
  });
};

export default health;
