import type { FastifyPluginAsync } from "fastify";

import type { AuthService } from "../../auth.js";
import type { ForgeConfig } from "../../config.js";
import type { HealthSnapshot } from "../../health.js";
import { ErrorResponseSchema, HealthSnapshotResponseSchema } from "../contracts/common.js";
import { sessionUser } from "../session.js";

export interface HealthRoutesOptions {
  auth?: AuthService;
  config?: ForgeConfig;
  readHealth: () => Promise<HealthSnapshot>;
}

const health: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  app.get("/api/health", { schema: { response: { 200: HealthSnapshotResponseSchema, 401: ErrorResponseSchema } } }, async (request, reply) => {
    if (options.auth && !(await sessionUser(options.auth, request, reply, options.config))) return reply.code(401).send({ error: "Authentication required" });
    return reply.send(await options.readHealth());
  });
};

export default health;
