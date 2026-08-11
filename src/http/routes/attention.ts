import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AttentionService } from "../../attention.js";
import { AttentionDetailResponseSchema, AttentionListResponseSchema } from "../contracts/attention.js";
import { TaskIdParamsSchema } from "../contracts/common.js";

export interface AttentionRoutesOptions {
  attention: AttentionService;
}

const attention: FastifyPluginAsync<AttentionRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/attention", { schema: { response: { 200: AttentionListResponseSchema } } }, async (request, reply) => reply.send({ companies: options.attention.list(request.forgeUser.id) }));
  typed.get("/api/attention/:taskId", { schema: { params: TaskIdParamsSchema, response: { 200: AttentionDetailResponseSchema } } }, async (request, reply) => reply.send({ items: options.attention.get(request.forgeUser.id, request.params.taskId) }));
};

export default attention;
