import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AuthUser } from "../../identity/auth.js";
import { ErrorResponseSchema } from "../contracts/common.js";
import { UpdateQuerySchema, UpdateRestartResponseSchema, UpdateResponseSchema, type UpdateResponse, type UpdateRestartResponse } from "../contracts/update.js";

export interface UpdateRoutesOptions {
  readUpdate: (check: boolean, user: AuthUser) => Promise<UpdateResponse>;
  requestRestart?: (user: AuthUser) => Promise<UpdateRestartResponse>;
  instanceId?: string;
}

function adminOnly(role: AuthUser["role"], reply: FastifyReply): boolean {
  if (role === "admin") return true;
  reply.code(403).send({ error: "Administrator access necessary" });
  return false;
}

const update: FastifyPluginAsync<UpdateRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/update", { schema: { querystring: UpdateQuerySchema, response: { 200: UpdateResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } } }, async (request, reply) => {
    const observed = await options.readUpdate(request.query.check === "1", request.forgeUser);
    return reply.header("Cache-Control", "private, no-store").send({
      ...observed,
      canRestart: request.forgeUser.role === "admin" && observed.canRestart && options.requestRestart !== undefined,
      ...(options.instanceId && !observed.instanceId ? { instanceId: options.instanceId } : {}),
    });
  });
  if (options.requestRestart) {
    typed.post("/api/update/restart", { schema: { response: { 202: UpdateRestartResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
      if (!adminOnly(request.forgeUser.role, reply)) return;
      try {
        return reply.code(202).send(await options.requestRestart!(request.forgeUser));
      } catch (error) {
        request.log.error({ err: error }, "Forge update request failed");
        return reply.code(503).send({ error: error instanceof Error ? error.message : "Forge update control failed" });
      }
    });
  }
};

export default update;
