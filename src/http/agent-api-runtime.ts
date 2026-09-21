import type { FastifyRequest } from "fastify";

export function isAgentApiRuntimeRequest(request: FastifyRequest): boolean {
  return (request.routeOptions.config as { agentApiRuntime?: unknown }).agentApiRuntime === true;
}
