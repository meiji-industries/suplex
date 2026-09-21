import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { ExternalAgentService } from "../../identity/external-agents.js";
import { AgentApiPairingExchangeBodySchema, AgentApiPairingExchangeResponseSchema } from "../contracts/agent-api.js";

const externalAgentPairing: FastifyPluginAsync<{ externalAgent: ExternalAgentService }> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const registerExchange = (path: "/api/agent/pairing/exchange" | "/api/agent/pair" | "/api/hermes/pairing/exchange" | "/api/hermes/pair"): void => {
    typed.post(path, {
    schema: {
      body: AgentApiPairingExchangeBodySchema,
      response: { 200: AgentApiPairingExchangeResponseSchema },
    },
    }, async (request, reply) => {
      return reply.header("Cache-Control", "private, no-store").send(options.externalAgent.exchange(request.body));
    });
  };

  registerExchange("/api/agent/pairing/exchange");
  registerExchange("/api/agent/pair");
  registerExchange("/api/hermes/pairing/exchange");
  registerExchange("/api/hermes/pair");
};

export default externalAgentPairing;
