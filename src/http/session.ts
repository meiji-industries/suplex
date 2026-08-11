import { randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthService, AuthUser } from "../auth.js";
import type { ForgeConfig } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    forgeUser: AuthUser;
  }
}

export const SESSION_COOKIE_NAME = "forge_session";
export const ORIGIN_TOKEN_COOKIE_NAME = "forge_origin";
export const ORIGIN_TOKEN_HEADER_NAME = "x-forge-origin";

export async function sessionUser(auth: AuthService | undefined, request: Pick<FastifyRequest, "cookies">): Promise<AuthUser | undefined> {
  return auth?.getUserBySession(request.cookies[SESSION_COOKIE_NAME] ?? "");
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
  reply.setCookie(ORIGIN_TOKEN_COOKIE_NAME, randomBytes(32).toString("base64url"), {
    httpOnly: false,
    sameSite: "strict",
    secure: config.reachableAddress.startsWith("https:"),
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  reply.clearCookie(ORIGIN_TOKEN_COOKIE_NAME, { path: "/" });
}
