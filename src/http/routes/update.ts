import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { UpdateAvailability } from "../../update.js";
import { ErrorResponseSchema } from "../contracts/common.js";
import { UpdateResponseSchema } from "../contracts/update.js";

export interface UpdateRoutesOptions {
  readUpdate: () => Promise<UpdateAvailability>;
}

const update: FastifyPluginAsync<UpdateRoutesOptions> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/update", { schema: { response: { 200: UpdateResponseSchema, 401: ErrorResponseSchema } } }, async (_request, reply) => {
    try {
      return reply.header("Cache-Control", "private, no-store").send(UpdateResponseSchema.parse(await options.readUpdate()));
    } catch {
      return reply.header("Cache-Control", "private, no-store").send({ available: false });
    }
  });
};

export default update;
