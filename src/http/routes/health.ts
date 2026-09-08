import type { FastifyPluginAsync } from "fastify";

import type { AuthService } from "../../identity/auth.js";
import type { ForgeConfig } from "../../platform/config.js";
import type { HealthSnapshot } from "../../platform/health.js";
import { ErrorResponseSchema, HealthSnapshotResponseSchema } from "../contracts/common.js";
import { sessionUser } from "../session.js";

export interface HealthRoutesOptions {
  auth?: AuthService;
  config?: ForgeConfig;
  readHealth: () => Promise<HealthSnapshot>;
  now?: () => number;
}

const health: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const cacheTtlMs = 10_000;
  const now = options.now ?? Date.now;
  let cached: { snapshot: HealthSnapshot; expiresAt: number } | undefined;
  let pending: Promise<HealthSnapshot> | undefined;
  const readCachedHealth = async (): Promise<HealthSnapshot> => {
    if (cached && now() < cached.expiresAt) return cached.snapshot;
    if (!pending) {
      pending = options.readHealth().then((snapshot) => {
        cached = { snapshot, expiresAt: now() + cacheTtlMs };
        return snapshot;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };

  app.get("/api/health", { schema: { response: { 200: HealthSnapshotResponseSchema, 401: ErrorResponseSchema } } }, async (request, reply) => {
    if (options.auth && !(await sessionUser(options.auth, request, reply, options.config))) return reply.code(401).send({ error: "Authentication required" });
    return reply.send(await readCachedHealth());
  });
};

export default health;
