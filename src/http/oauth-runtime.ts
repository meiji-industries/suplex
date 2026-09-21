import type { FastifyRequest } from "fastify";

export function isOAuthProtocolRequest(request: FastifyRequest): boolean {
  return (request.routeOptions.config as { oauthProtocol?: unknown }).oauthProtocol === true;
}
