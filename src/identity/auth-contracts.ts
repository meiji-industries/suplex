import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";

import {
  INVITATION_TOKEN_PATTERN,
  LEGACY_INVITATION_TOKEN_PATTERN,
} from "./auth-identifiers.js";
import type { WebAuthnAdapter } from "./auth-webauthn.js";

export type UserRole = "admin" | "member";
export type UserStatus = "pending" | "active" | "revoked";
export type InvitationKind = "bootstrap" | "user" | "recovery";

export interface AuthUser {
  id: string;
  displayName: string;
  username: string;
  avatarSeed: string;
  role: UserRole;
  status: UserStatus;
  companyIds: string[];
}
export interface Company {
  id: string;
  name: string;
  status: "active" | "paused" | "archived";
  issueCode: string | null;
  createdAt: string;
}
export interface IssuedInvitation {
  token: string;
  kind: InvitationKind;
  expiresAt: string;
  user?: AuthUser;
}
export interface InvitationSummary {
  id: string;
  kind: InvitationKind;
  displayName: string;
  expiresAt: string;
  status: "active" | "expired" | "consumed" | "replaced";
  createdAt: string;
}
export interface AuthCredential {
  id: string;
  userId: string;
  credentialId: string;
  createdAt: string;
  revokedAt?: string;
}
export interface LocalRecoveryRequest {
  confirmed: true;
  initiationMethod: "local-cli";
  installationId: string;
}
export interface AuthOptions<TOptions> {
  challengeId: string;
  options: TOptions;
}
export interface AuthResult {
  user: AuthUser;
  sessionToken: string;
}
export interface AuditEvent {
  id: string;
  actorUserId?: string;
  action: string;
  targetUserId?: string;
  companyId?: string;
  metadata: Record<string, string>;
  createdAt: string;
}
export interface AuthServiceOptions {
  now?: () => Date;
  invitationTtlMs?: number;
  sessionTtlMs?: number;
  webAuthn?: WebAuthnAdapter;
}
export interface InvitationRow {
  id: string;
  kind: InvitationKind;
  display_name: string;
  user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  replaced_at: string | null;
  metadata_json: string;
}

export class AuthFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly code: string;

  constructor(publicMessage: string, statusCode = 400, code = "auth_failure") {
    super(publicMessage);
    this.name = "AuthFailure";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.code = code;
  }
}

export const invitationTokenSchema = z
  .string()
  .refine(
    (value) =>
      INVITATION_TOKEN_PATTERN.test(value) ||
      LEGACY_INVITATION_TOKEN_PATTERN.test(value),
    "invalid invitation",
  );
export const idSchema = z.string().min(1).max(128);
export const responseSchema = z
  .object({ id: z.string().min(1).max(512), type: z.literal("public-key") })
  .passthrough();
export const displayNameSchema = z.string().trim().min(1).max(120);
export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{1,63}$/);
export const companyNameSchema = z.string().trim().min(1).max(120);
export const companyIssueCodeSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);

export const invitationFailure = (): AuthFailure =>
  new AuthFailure(
    "Invitation is invalid or expired",
    400,
    "invitation_invalid",
  );
export const passkeyFailure = (): AuthFailure =>
  new AuthFailure("Passkey could not be verified", 400, "passkey_invalid");

export function parseResponse(
  value: unknown,
): RegistrationResponseJSON & AuthenticationResponseJSON {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw passkeyFailure();
  return parsed.data as unknown as RegistrationResponseJSON &
    AuthenticationResponseJSON;
}

export type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
};
