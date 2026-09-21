import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ExternalAgentService } from "../../identity/external-agents.js";
import {
  AgentApiAdminAgentParamsSchema,
  AgentApiAdminCreateBodySchema,
  AgentApiAdminCreateResponseSchema,
  AgentApiAdminListQuerySchema,
  AgentApiAgentListResponseSchema,
  AgentApiAdminPairingCodeResponseSchema,
  AgentApiAdminProjectsBodySchema,
  AgentApiAdminProjectsResponseSchema,
} from "../contracts/agent-api.js";

const externalAgentAdministration: FastifyPluginAsync<{ externalAgent: ExternalAgentService }> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const registerRoutes = (prefix: "/api/admin/external-agents" | "/api/admin/hermes-agents"): void => {

  typed.get(`${prefix}`, {
    schema: {
      querystring: AgentApiAdminListQuerySchema,
      response: { 200: AgentApiAgentListResponseSchema },
    },
  }, async (request) => {
    const agents = options.externalAgent.list(request.forgeUser.id, request.query.companyId);
    return { agents };
  });

  typed.post(`${prefix}`, {
    schema: {
      body: AgentApiAdminCreateBodySchema,
      response: { 201: AgentApiAdminCreateResponseSchema },
    },
  }, async (request, reply) => {
    const result = options.externalAgent.create(request.forgeUser.id, request.body);
    return reply.header("Cache-Control", "private, no-store").code(201).send(result);
  });

  typed.put(`${prefix}/:agentId/projects`, {
    schema: {
      params: AgentApiAdminAgentParamsSchema,
      body: AgentApiAdminProjectsBodySchema,
      response: { 200: AgentApiAdminProjectsResponseSchema },
    },
  }, async (request) => {
    const agent = options.externalAgent.replaceProjects(request.forgeUser.id, request.params.agentId, request.body.projectIds);
    return { agent };
  });

  typed.post(`${prefix}/:agentId/pairing-code`, {
    schema: {
      params: AgentApiAdminAgentParamsSchema,
      response: { 200: AgentApiAdminPairingCodeResponseSchema },
    },
  }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(options.externalAgent.issueInitialPairing(request.forgeUser.id, request.params.agentId));
  });

  typed.post(`${prefix}/:agentId/rotate`, {
    schema: {
      params: AgentApiAdminAgentParamsSchema,
      response: { 200: AgentApiAdminPairingCodeResponseSchema },
    },
  }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(options.externalAgent.rotate(request.forgeUser.id, request.params.agentId));
  });

  typed.post(`${prefix}/:agentId/revoke`, {
    schema: {
      params: AgentApiAdminAgentParamsSchema,
      response: { 204: { type: "null" } },
    },
  }, async (request, reply) => {
    options.externalAgent.revoke(request.forgeUser.id, request.params.agentId);
    return reply.code(204).send();
  });
  };

  registerRoutes("/api/admin/external-agents");
  registerRoutes("/api/admin/hermes-agents");
};

export default externalAgentAdministration;
