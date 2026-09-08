import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";

import type { HermesAgentService } from "../../identity/hermes-agents.js";
import { HermesPairingExchangeBodySchema, HermesPairingExchangeResponseSchema } from "../contracts/hermes.js";

const hermesPairing: FastifyPluginAsync<{ hermes: HermesAgentService }> = async (app, options) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post("/api/hermes/pairing/exchange", {
    schema: {
      body: HermesPairingExchangeBodySchema,
      response: { 200: HermesPairingExchangeResponseSchema },
    },
  }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(options.hermes.exchange(request.body));
  });

  typed.post("/api/hermes/pair", {
    schema: {
      body: HermesPairingExchangeBodySchema,
      response: { 200: HermesPairingExchangeResponseSchema },
    },
  }, async (request, reply) => {
    return reply.header("Cache-Control", "private, no-store").send(options.hermes.exchange(request.body));
  });
};

export default hermesPairing;
