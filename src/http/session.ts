import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthService, AuthUser } from "../auth.js";
import type { ForgeConfig } from "../config.js";
import {
  CSRF_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  newCsrfToken,
} from "../auth-identifiers.js";

declare module "fastify" {
  interface FastifyRequest {
    forgeUser: AuthUser;
  }
}

export async function sessionUser(auth: AuthService | undefined, request: Pick<FastifyRequest, "cookies">, reply?: FastifyReply, config?: ForgeConfig): Promise<AuthUser | undefined> {
  if (!auth) return undefined;
  const current = await auth.getUserBySession(request.cookies[SESSION_COOKIE_NAME] ?? "");
  if (current) return current;
  const legacyToken = request.cookies[LEGACY_SESSION_COOKIE_NAME] ?? "";
  const legacy = await auth.getUserBySession(legacyToken);
  if (legacy && reply && config) {
    const replacement = auth.rolloverLegacySession(legacyToken);
    if (replacement) setSessionCookie(config, reply, replacement);
  }
  return legacy;
}

export function authenticatedUser(request: FastifyRequest): AuthUser {
  if (!request.forgeUser) {
    throw new Error("Authenticated request context is missing");
  }
  return request.forgeUser;
}

export function setSessionCookie(config: ForgeConfig, reply: FastifyReply, sessionToken: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.reachableAddress.startsWith("https:"),
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  reply.setCookie(CSRF_COOKIE_NAME, newCsrfToken(), {
    httpOnly: false,
    sameSite: "strict",
    secure: config.reachableAddress.startsWith("https:"),
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  reply.clearCookie(LEGACY_SESSION_COOKIE_NAME, { path: "/" });
  reply.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
}
