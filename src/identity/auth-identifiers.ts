import { randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "sid_v1";
export const LEGACY_SESSION_COOKIE_NAME = "suplex_session";
export const CSRF_COOKIE_NAME = "csrf_v1";
export const CSRF_HEADER_NAME = "x-csrf-v1";
export const INVITATION_TOKEN_PATTERN = /^invite_v1_(bootstrap|user|recovery)_[A-Za-z0-9_-]{43}$/;
export const LEGACY_INVITATION_TOKEN_PATTERN = /^suplex_(bootstrap|user|recovery)_[A-Za-z0-9_-]{43}$/;

export function newInvitationToken(kind: "bootstrap" | "user" | "recovery"): string {
  return `invite_v1_${kind}_${randomBytes(32).toString("base64url")}`;
}

export function newSessionToken(): string {
  return `session_v1_${randomBytes(32).toString("base64url")}`;
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function neutralUsername(userId: string): string {
  return `user_v1_${userId}`;
}
