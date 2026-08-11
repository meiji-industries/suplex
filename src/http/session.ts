import type { FastifyRequest } from "fastify";

import type { AuthService, AuthUser } from "../auth.js";
import type { ForgeConfig } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    forgeUser: AuthUser;
  }
}

export async function sessionUser(auth: AuthService | undefined, request: Pick<FastifyRequest, "cookies">): Promise<AuthUser | undefined> {
  return auth?.getUserBySession(request.cookies.forge_session ?? "");
}

export function authenticatedUser(request: FastifyRequest): AuthUser {
  if (!request.forgeUser) {
    throw new Error("Authenticated request context is missing");
  }
  return request.forgeUser;
}

export function setSessionCookie(config: ForgeConfig, reply: { setCookie: (name: string, value: string, options: { httpOnly: boolean; sameSite: "lax"; secure: boolean; path: string; maxAge: number }) => unknown }, sessionToken: string): void {
  reply.setCookie("forge_session", sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.reachableAddress.startsWith("https:"),
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}
