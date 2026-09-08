import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AuthUser } from "../../identity/auth.js";
import { SelfUpdateFailure } from "../../platform/updates/self-update.js";
import type { UpdateObservation } from "../../platform/updates/self-update.js";
import type { UpdateAvailability } from "../../platform/updates/update.js";
import { ErrorResponseSchema } from "../contracts/common.js";
import { RestartUpdateBodySchema, UpdateRestartResponseSchema, UpdateResponseSchema, type UpdateRestartResponse } from "../contracts/update.js";

export interface UpdateRoutesOptions {
  readUpdate: (user: AuthUser) => Promise<UpdateAvailability | UpdateObservation>;
  requestRestart?: (revision: string) => Promise<UpdateRestartResponse>;
  launchRestart?: (operationId: string) => Promise<void>;
  instanceId?: string;
}

function adminOnly(role: AuthUser["role"], reply: FastifyReply): boolean {
  if (role === "admin") return true;
  reply.code(403).send({ error: "Administrator access required" });
  return false;
}

const update: FastifyPluginAsync<UpdateRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/update", { schema: { response: { 200: UpdateResponseSchema, 401: ErrorResponseSchema } } }, async (request, reply) => {
    try {
      const observed = UpdateResponseSchema.parse(await options.readUpdate(request.forgeUser));
      return reply.header("Cache-Control", "private, no-store").send({
        ...observed,
        canRestart: request.forgeUser.role === "admin",
        ...(options.instanceId && !observed.instanceId ? { instanceId: options.instanceId } : {}),
      });
    } catch {
      return reply.header("Cache-Control", "private, no-store").send({ available: false, canRestart: request.forgeUser.role === "admin", ...(options.instanceId ? { instanceId: options.instanceId } : {}) });
    }
  });
  if (options.requestRestart && options.launchRestart) {
    typed.post("/api/update/restart", { schema: { body: RestartUpdateBodySchema, response: { 202: UpdateRestartResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema, 409: ErrorResponseSchema, 503: ErrorResponseSchema } } }, async (request, reply) => {
      if (!adminOnly(request.forgeUser.role, reply)) return;
      let accepted: UpdateRestartResponse;
      try {
        accepted = await options.requestRestart!(request.body.revision);
      } catch (error: unknown) {
        if (error instanceof SelfUpdateFailure) return reply.code(error.statusCode).send({ error: error.publicMessage, code: error.code });
        throw error;
      }
      let launched = false;
      const launch = (): void => {
        if (launched) return;
        launched = true;
        reply.raw.off("finish", launch);
        reply.raw.off("close", launch);
        void options.launchRestart!(accepted.operation.operationId).catch((error: unknown) => {
          request.log.error({ err: error, operationId: accepted.operation.operationId }, "Forge update helper could not be launched");
        });
      };
      reply.raw.once("finish", launch);
      reply.raw.once("close", launch);
      return reply.code(202).send(accepted);
    });
  }
};

export default update;
