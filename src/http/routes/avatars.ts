import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { AvatarService } from "../../identity/avatars.js";
import { MAX_AVATAR_IMAGE_BASE64_LENGTH, dicebearUrl } from "../../identity/avatar-kinds.js";
import type { ProjectService } from "../../projects/projects.js";
import { AvatarDirectoryResponseSchema, AvatarOwnerParamsSchema, AvatarRecordSchema, AvatarUpdateBodySchema } from "../contracts/avatars.js";

const avatars: FastifyPluginAsync<{ avatars: AvatarService; projects?: ProjectService }> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get("/api/avatars", { schema: { response: { 200: AvatarDirectoryResponseSchema } } }, async (request, reply) => reply.send({ avatars: options.avatars.list(request.suplexUser.id) }));
  typed.get("/api/avatars/:ownerId", { schema: { params: AvatarOwnerParamsSchema } }, async (request, reply) => {
    const uploaded = options.avatars.image(request.suplexUser.id, request.params.ownerId);
    reply.header("Cache-Control", "private, max-age=3600").header("X-Content-Type-Options", "nosniff");
    if (uploaded) return reply.type(uploaded.mimeType).send(uploaded.image);
    const owner = options.avatars.owner(request.suplexUser.id, request.params.ownerId);
    if (owner.kind === "project" && options.projects) {
      const favicon = await options.projects.getProjectFavicon(request.suplexUser.id, request.params.ownerId).catch(() => undefined);
      if (favicon) return reply.type("image/x-icon").send(favicon);
    }
    return reply.redirect(dicebearUrl(owner.kind, owner.seed), 302);
  });
  typed.put("/api/avatars/:ownerId", { bodyLimit: MAX_AVATAR_IMAGE_BASE64_LENGTH + 64 * 1024, schema: { params: AvatarOwnerParamsSchema, body: AvatarUpdateBodySchema, response: { 200: AvatarRecordSchema } } }, async (request, reply) => reply.send(options.avatars.update(request.suplexUser.id, request.params.ownerId, request.body)));
};

export default avatars;
