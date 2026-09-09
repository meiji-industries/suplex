import type { FastifyRequest } from "fastify";

export function isHermesRuntimeRequest(request: FastifyRequest): boolean {
  return (request.routeOptions.config as { hermesRuntime?: unknown }).hermesRuntime === true;
}
