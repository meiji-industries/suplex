import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AttentionService } from "../../attention.js";
import { AttentionListResponseSchema } from "../contracts/attention.js";

export interface AttentionRoutesOptions {
  attention: AttentionService;
}

const attention: FastifyPluginAsync<AttentionRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/attention", { schema: { response: { 200: AttentionListResponseSchema } } }, async (request, reply) => reply.send({ companies: options.attention.list(request.forgeUser.id) }));
};

export default attention;
