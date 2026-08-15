import type { FastifyPluginAsync } from "fastify";
import { type ZodTypeProvider } from "@fastify/type-provider-zod";

import type { HermesAgentService } from "../../hermes-agents.js";
import {
  HermesAdminAgentParamsSchema,
  HermesAdminCreateBodySchema,
  HermesAdminCreateResponseSchema,
  HermesAdminListQuerySchema,
  HermesAgentListResponseSchema,
  HermesAdminPairingCodeResponseSchema,
  HermesAdminProjectsBodySchema,
  HermesAdminProjectsResponseSchema,
} from "../contracts/hermes.js";

const hermesAdministration: FastifyPluginAsync<{ hermes: HermesAgentService }> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get("/api/admin/hermes-agents", {
    schema: {
      querystring: HermesAdminListQuerySchema,
      response: { 200: HermesAgentListResponseSchema },
    },
  }, async (request) => {
    const agents = options.hermes.list(request.forgeUser.id, request.query.companyId);
    return { agents };
  });

  typed.post("/api/admin/hermes-agents", {
    schema: {
      body: HermesAdminCreateBodySchema,
      response: { 201: HermesAdminCreateResponseSchema },
    },
  }, async (request, reply) => {
    const result = options.hermes.create(request.forgeUser.id, request.body);
    return reply.header("Cache-Control", "private, no-store").code(201).send(result);
  });

  typed.put("/api/admin/hermes-agents/:agentId/projects", {
    schema: {
      params: HermesAdminAgentParamsSchema,
      body: HermesAdminProjectsBodySchema,
      response: { 200: HermesAdminProjectsResponseSchema },
    },
  }, async (request) => {
    const agent = options.hermes.replaceProjects(request.forgeUser.id, request.params.agentId, request.body.projectIds);
    return { agent };
  });

  typed.post("/api/admin/hermes-agents/:agentId/pairing-code", {
    schema: {
      params: HermesAdminAgentParamsSchema,
      response: { 200: HermesAdminPairingCodeResponseSchema },
    },
  }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(options.hermes.issueInitialPairing(request.forgeUser.id, request.params.agentId));
  });

  typed.post("/api/admin/hermes-agents/:agentId/rotate", {
    schema: {
      params: HermesAdminAgentParamsSchema,
      response: { 200: HermesAdminPairingCodeResponseSchema },
    },
  }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(options.hermes.rotate(request.forgeUser.id, request.params.agentId));
  });

  typed.post("/api/admin/hermes-agents/:agentId/revoke", {
    schema: {
      params: HermesAdminAgentParamsSchema,
      response: { 204: { type: "null" } },
    },
  }, async (request, reply) => {
    options.hermes.revoke(request.forgeUser.id, request.params.agentId);
    return reply.code(204).send();
  });
};

export default hermesAdministration;
