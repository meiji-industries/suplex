import { createHash, randomBytes } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { z } from "zod";

import type { ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";

export type UserRole = "admin" | "member";
export type UserStatus = "pending" | "active" | "revoked";
export type InvitationKind = "bootstrap" | "user" | "recovery";

export interface AuthUser {
  id: string;
  displayName: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  companyIds: string[];
}

export interface Company {
  id: string;
  name: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
}

export interface IssuedInvitation {
  token: string;
  kind: InvitationKind;
  expiresAt: string;
  user?: AuthUser;
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

export interface WebAuthnAdapter {
  generateRegistrationOptions(input: {
    userId: string;
    userName: string;
    displayName: string;
    rpId: string;
    excludeCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistrationResponse(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<RegistrationVerification>;
  generateAuthenticationOptions(input: {
    rpId: string;
    allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>;
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthenticationResponse(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: WebAuthnCredential;
  }): Promise<AuthenticationVerification>;
}

export type RegistrationVerification =
  | { verified: false }
  | {
      verified: true;
      credential: {
        id: string;
        publicKey: Uint8Array;
        counter: number;
        transports?: AuthenticatorTransportFuture[];
      };
    };

export type AuthenticationVerification =
  | { verified: false }
  | { verified: true; newCounter: number };

export class AuthFailure extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;

  constructor(publicMessage: string, statusCode = 400) {
    super(publicMessage);
    this.name = "AuthFailure";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

const invitationTokenSchema = z.string().regex(/^forge_[a-z]+_[A-Za-z0-9_-]{43}$/, "invalid invitation");
const idSchema = z.string().min(1).max(128);
const responseSchema = z.object({ id: z.string().min(1).max(512), type: z.literal("public-key") }).passthrough();
const displayNameSchema = z.string().trim().min(1).max(120);
const companyNameSchema = z.string().trim().min(1).max(120);

const invitationFailure = (): AuthFailure => new AuthFailure("Invitation is invalid or expired");
const passkeyFailure = (): AuthFailure => new AuthFailure("Passkey could not be verified");

interface UserRow {
  id: string;
  display_name: string;
  username: string;
  role: UserRole;
  status: UserStatus;
}

interface InvitationRow {
  id: string;
  kind: InvitationKind;
  display_name: string;
  user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  replaced_at: string | null;
}

interface ChallengeRow {
  id: string;
  challenge: string;
  kind: string;
  invitation_id: string | null;
  user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
}

interface SessionRow extends UserRow {
  expires_at: string;
}

interface CompanyRow {
  id: string;
  name: string;
  status: "active" | "paused" | "archived";
  created_at: string;
}

interface CountRow {
  count: number;
}

interface AuthServiceOptions {
  now?: () => Date;
  invitationTtlMs?: number;
  sessionTtlMs?: number;
  webAuthn?: WebAuthnAdapter;
}

const defaultWebAuthn: WebAuthnAdapter = {
  generateRegistrationOptions: async (input) => generateRegistrationOptions({
    rpName: "Forge",
    rpID: input.rpId,
    userID: Buffer.from(input.userId),
    userName: input.userName,
    userDisplayName: input.displayName,
    excludeCredentials: input.excludeCredentials,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  }),
  verifyRegistrationResponse: async (input) => {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
    });
    if (!result.verified) {
      return { verified: false };
    }
    const transports = result.registrationInfo.credential.transports;
    return {
      verified: true,
      credential: {
        id: result.registrationInfo.credential.id,
        publicKey: result.registrationInfo.credential.publicKey,
        counter: result.registrationInfo.credential.counter,
        ...(transports ? { transports } : {}),
      },
    };
  },
  generateAuthenticationOptions: async (input) => generateAuthenticationOptions({
    rpID: input.rpId,
    allowCredentials: input.allowCredentials,
    userVerification: "required",
  }),
  verifyAuthenticationResponse: async (input) => {
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      credential: input.credential,
      requireUserVerification: true,
    });
    return result.verified ? { verified: true, newCounter: result.authenticationInfo.newCounter } : { verified: false };
  },
};

export const productionWebAuthnAdapter: WebAuthnAdapter = defaultWebAuthn;

function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function token(kind: InvitationKind): string {
  return `forge_${kind}_${randomBytes(32).toString("base64url")}`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? "{}";
}

function publicUser(row: UserRow, companyIds: string[] = []): AuthUser {
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    role: row.role,
    status: row.status,
    companyIds,
  };
}

function parseResponse(value: unknown): RegistrationResponseJSON & AuthenticationResponseJSON {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    throw passkeyFailure();
  }
  return parsed.data as unknown as RegistrationResponseJSON & AuthenticationResponseJSON;
}

export class AuthService {
  private readonly now: () => Date;
  private readonly invitationTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly webAuthn: WebAuthnAdapter;
  private readonly rpId: string;
  private readonly origin: string;

  constructor(private readonly database: ForgeDatabase, config: ForgeConfig, options: AuthServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.invitationTtlMs = options.invitationTtlMs ?? 72 * 60 * 60 * 1000;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.webAuthn = options.webAuthn ?? defaultWebAuthn;
    const reachable = new URL(config.reachableAddress);
    this.rpId = reachable.hostname;
    this.origin = reachable.origin;
    if (reachable.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(reachable.hostname)) {
      throw new Error("Forge passkey authentication requires an HTTPS reachable address");
    }
  }

  getBootstrapState(): { required: boolean } {
    const row = this.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_users WHERE role = 'admin' AND status != 'revoked'").get() as CountRow);
    return { required: Number(row.count) === 0 };
  }

  ensureBootstrapInvitation(): IssuedInvitation | undefined {
    if (!this.getBootstrapState().required) {
      return undefined;
    }
    return this.database.authTransaction((db) => this.issueInvitation(db, "bootstrap", "Forge administrator"));
  }

  createRecoveryInvitation(): IssuedInvitation {
    return this.database.authTransaction((db) => this.issueInvitation(db, "recovery", "Recovered Forge administrator"));
  }

  async beginBootstrapRegistration(rawToken: string): Promise<AuthOptions<PublicKeyCredentialCreationOptionsJSON>> {
    return this.beginRegistration("bootstrap", rawToken);
  }

  async beginInvitationRegistration(rawToken: string): Promise<AuthOptions<PublicKeyCredentialCreationOptionsJSON>> {
    return this.beginRegistration("user", rawToken);
  }

  async beginRecoveryRegistration(rawToken: string): Promise<AuthOptions<PublicKeyCredentialCreationOptionsJSON>> {
    return this.beginRegistration("recovery", rawToken);
  }

  async completeBootstrapRegistration(input: { token: string; challengeId: string; response: unknown }): Promise<AuthResult> {
    return this.completeRegistration("bootstrap", input);
  }

  async completeInvitationRegistration(input: { token: string; challengeId: string; response: unknown }): Promise<AuthResult> {
    return this.completeRegistration("user", input);
  }

  async completeRecoveryRegistration(input: { token: string; challengeId: string; response: unknown }): Promise<AuthResult> {
    return this.completeRegistration("recovery", input);
  }

  async beginAuthentication(): Promise<AuthOptions<PublicKeyCredentialRequestOptionsJSON>> {
    const credentials = this.database.authQuery((db) => db.prepare(`
      SELECT c.credential_id, c.transports
      FROM forge_credentials c
      JOIN forge_users u ON u.id = c.user_id
      WHERE c.revoked_at IS NULL AND u.status = 'active'
      ORDER BY c.created_at
    `).all() as Array<{ credential_id: string; transports: string }>);
    if (credentials.length === 0) {
      throw new AuthFailure("No passkey is enrolled", 400);
    }
    const options = await this.webAuthn.generateAuthenticationOptions({
      rpId: this.rpId,
      allowCredentials: credentials.map((credential) => {
        const transports = this.parseTransports(credential.transports);
        return { id: credential.credential_id, ...(transports ? { transports } : {}) };
      }),
    });
    const challengeId = id("challenge");
    const expiresAt = new Date(this.now().getTime() + 5 * 60 * 1000).toISOString();
    this.database.authTransaction((db) => {
      db.prepare(`INSERT INTO forge_challenges (id, challenge, kind, invitation_id, user_id, expires_at, consumed_at, created_at)
        VALUES (?, ?, 'authentication', NULL, NULL, ?, NULL, ?)`).run(challengeId, options.challenge, expiresAt, this.now().toISOString());
    });
    return { challengeId, options };
  }

  async completeAuthentication(input: { challengeId: string; response: unknown }): Promise<AuthResult> {
    const challengeId = idSchema.safeParse(input.challengeId);
    if (!challengeId.success) {
      throw passkeyFailure();
    }
    const response = parseResponse(input.response);
    const challenge = this.database.authTransaction((db) => {
      const row = db.prepare("SELECT * FROM forge_challenges WHERE id = ? AND kind = 'authentication'").get(input.challengeId) as ChallengeRow | undefined;
      if (!row || row.consumed_at || Date.parse(row.expires_at) <= this.now().getTime()) {
        throw passkeyFailure();
      }
      db.prepare("UPDATE forge_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(this.now().toISOString(), row.id);
      return row;
    });
    const credential = this.database.authQuery((db) => db.prepare(`
      SELECT c.*, u.status AS user_status
      FROM forge_credentials c
      JOIN forge_users u ON u.id = c.user_id
      WHERE c.credential_id = ? AND c.revoked_at IS NULL AND u.status = 'active'
    `).get(response.id) as (CredentialRow & { user_status: UserStatus }) | undefined);
    if (!credential) {
      throw passkeyFailure();
    }
    let verification: AuthenticationVerification;
    try {
      const transports = this.parseTransports(credential.transports);
      verification = await this.webAuthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRpId: this.rpId,
        credential: {
          id: credential.credential_id,
          publicKey: Uint8Array.from(credential.public_key),
          counter: credential.counter,
          ...(transports ? { transports } : {}),
        },
      });
    } catch {
      throw passkeyFailure();
    }
    if (!verification.verified) {
      throw passkeyFailure();
    }
    return this.database.authTransaction((db) => {
      db.prepare("UPDATE forge_credentials SET counter = ? WHERE id = ? AND revoked_at IS NULL").run(verification.newCounter, credential.id);
      const user = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ? AND status = 'active'").get(credential.user_id) as UserRow | undefined;
      if (!user) {
        throw passkeyFailure();
      }
      return { user: this.userWithCompanies(db, user), sessionToken: this.createSession(db, user.id) };
    });
  }

  async getUserBySession(rawToken: string): Promise<AuthUser | undefined> {
    if (!rawToken) {
      return undefined;
    }
    const row = this.database.authQuery((db) => db.prepare(`
      SELECT u.id, u.display_name, u.username, u.role, u.status, s.expires_at
      FROM forge_sessions s JOIN forge_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `).get(hashSecret(rawToken)) as SessionRow | undefined);
    if (!row || row.status !== "active" || Date.parse(row.expires_at) <= this.now().getTime()) {
      return undefined;
    }
    return this.database.authQuery((db) => this.userWithCompanies(db, row));
  }

  getUserForAuthority(userId: string): AuthUser | undefined {
    return this.database.authQuery((db) => {
      const row = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ? AND status = 'active'").get(userId) as UserRow | undefined;
      return row ? this.userWithCompanies(db, row) : undefined;
    });
  }

  recordAuditEvent(actorUserId: string | undefined, action: string, targetUserId?: string, companyId?: string, metadata: Record<string, string> = {}): void {
    this.database.authTransaction((db) => this.audit(db, actorUserId ?? null, action, targetUserId ?? null, companyId ?? null, metadata));
  }

  recordAuditEventInTransaction(database: import("better-sqlite3").Database, actorUserId: string | undefined, action: string, targetUserId?: string, companyId?: string, metadata: Record<string, string> = {}): void {
    this.audit(database, actorUserId ?? null, action, targetUserId ?? null, companyId ?? null, metadata);
  }

  signOut(rawToken: string): void {
    if (!rawToken) {
      return;
    }
    this.database.authQuery((db) => {
      db.prepare("UPDATE forge_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(this.now().toISOString(), hashSecret(rawToken));
    });
  }

  inviteUser(actorUserId: string, input: { displayName: string }): IssuedInvitation {
    const displayName = displayNameSchema.safeParse(input.displayName);
    if (!displayName.success) {
      throw new AuthFailure("Display name is invalid");
    }
    return this.database.authTransaction((db) => {
      this.requireAdmin(db, actorUserId);
      const userId = id("user");
      const now = this.now().toISOString();
      db.prepare(`INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'member', 'pending', ?, ?)`).run(userId, displayName.data, `${userId}@forge.local`, now, now);
      const invitation = this.issueInvitation(db, "user", displayName.data, userId);
      this.audit(db, actorUserId, "user_invited", userId, null, {});
      return { ...invitation, user: this.userWithCompanies(db, db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ?").get(userId) as UserRow) };
    });
  }

  listUsers(actorUserId: string): AuthUser[] {
    return this.database.authQuery((db) => {
      this.requireAdmin(db, actorUserId);
      const rows = db.prepare("SELECT id, display_name, username, role, status FROM forge_users ORDER BY created_at").all() as UserRow[];
      return rows.map((row) => this.userWithCompanies(db, row));
    });
  }

  revokeUser(actorUserId: string, targetUserId: string): void {
    this.database.authTransaction((db) => {
      this.requireAdmin(db, actorUserId);
      const target = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ?").get(targetUserId) as UserRow | undefined;
      if (!target || target.id === actorUserId || target.status === "revoked") {
        throw new AuthFailure("Not found", 404);
      }
      const now = this.now().toISOString();
      db.prepare("UPDATE forge_users SET status = 'revoked', updated_at = ? WHERE id = ?").run(now, target.id);
      db.prepare("UPDATE forge_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, target.id);
      db.prepare("UPDATE forge_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, target.id);
      this.audit(db, actorUserId, "user_revoked", target.id, null, {});
    });
  }

  createCompany(actorUserId: string, rawName: string): Company {
    const name = companyNameSchema.safeParse(rawName);
    if (!name.success) {
      throw new AuthFailure("Company name is invalid");
    }
    return this.database.authTransaction((db) => {
      this.requireAdmin(db, actorUserId);
      const company = { id: id("company"), name: name.data, status: "active" as const, createdAt: this.now().toISOString() };
      try {
        db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(company.id, company.name, company.createdAt);
      } catch {
        throw new AuthFailure("Company name is already in use");
      }
      this.audit(db, actorUserId, "company_created", null, company.id, {});
      return company;
    });
  }

  setCompanyStatus(actorUserId: string, companyId: string, status: "active" | "paused" | "archived"): Company {
    if (!["active", "paused", "archived"].includes(status)) throw new AuthFailure("Company status is invalid");
    return this.database.authTransaction((db) => {
      this.requireAdmin(db, actorUserId);
      const company = db.prepare("SELECT id, name, status, created_at FROM forge_companies WHERE id = ?").get(companyId) as CompanyRow | undefined;
      if (!company) throw new AuthFailure("Not found", 404);
      db.prepare("UPDATE forge_companies SET status = ? WHERE id = ?").run(status, companyId);
      this.audit(db, actorUserId, `company_${status}`, null, companyId, {});
      return { id: company.id, name: company.name, status, createdAt: company.created_at };
    });
  }

  listVisibleCompanies(actorUserId: string): Company[] {
    return this.database.authQuery((db) => {
      const user = this.requireUser(db, actorUserId);
      const rows = user.role === "admin"
        ? db.prepare("SELECT id, name, status, created_at FROM forge_companies ORDER BY name").all()
        : db.prepare("SELECT c.id, c.name, c.status, c.created_at FROM forge_companies c JOIN forge_memberships m ON m.company_id = c.id WHERE m.user_id = ? ORDER BY c.name").all(actorUserId);
      return (rows as CompanyRow[]).map((row) => ({ id: row.id, name: row.name, status: row.status, createdAt: row.created_at }));
    });
  }

  requireCompanyAccess(actorUserId: string, companyId: string): Company {
    const parsedId = idSchema.safeParse(companyId);
    if (!parsedId.success) {
      throw new AuthFailure("Not found", 404);
    }
    return this.database.authQuery((db) => {
      const user = this.requireUser(db, actorUserId);
      const row = user.role === "admin"
        ? db.prepare("SELECT id, name, status, created_at FROM forge_companies WHERE id = ?").get(companyId)
        : db.prepare("SELECT c.id, c.name, c.status, c.created_at FROM forge_companies c JOIN forge_memberships m ON m.company_id = c.id WHERE c.id = ? AND m.user_id = ?").get(companyId, actorUserId);
      if (!row) {
        throw new AuthFailure("Not found", 404);
      }
      const company = row as CompanyRow;
      return { id: company.id, name: company.name, status: company.status, createdAt: company.created_at };
    });
  }

  addMembership(actorUserId: string, targetUserId: string, companyId: string): void {
    this.database.authTransaction((db) => {
      this.requireAdmin(db, actorUserId);
      const target = db.prepare("SELECT id FROM forge_users WHERE id = ? AND status != 'revoked'").get(targetUserId) as { id: string } | undefined;
      const company = db.prepare("SELECT id FROM forge_companies WHERE id = ?").get(companyId) as { id: string } | undefined;
      if (!target || !company) {
        throw new AuthFailure("Not found", 404);
      }
      db.prepare("INSERT OR IGNORE INTO forge_memberships (user_id, company_id, created_at) VALUES (?, ?, ?)").run(targetUserId, companyId, this.now().toISOString());
      this.audit(db, actorUserId, "membership_added", targetUserId, companyId, {});
    });
  }

  removeMembership(actorUserId: string, targetUserId: string, companyId: string): void {
    this.database.authTransaction((db) => {
      this.requireAdmin(db, actorUserId);
      const result = db.prepare("DELETE FROM forge_memberships WHERE user_id = ? AND company_id = ?").run(targetUserId, companyId);
      if (result.changes === 0) {
        throw new AuthFailure("Not found", 404);
      }
      this.audit(db, actorUserId, "membership_removed", targetUserId, companyId, {});
    });
  }

  listAuditEvents(actorUserId: string): AuditEvent[] {
    return this.database.authQuery((db) => {
      this.requireAdmin(db, actorUserId);
      const rows = db.prepare("SELECT id, actor_user_id, action, target_user_id, company_id, metadata_json, created_at FROM forge_audit_events ORDER BY created_at, id").all() as Array<{
        id: string;
        actor_user_id: string | null;
        action: string;
        target_user_id: string | null;
        company_id: string | null;
        metadata_json: string;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
        action: row.action,
        ...(row.target_user_id ? { targetUserId: row.target_user_id } : {}),
        ...(row.company_id ? { companyId: row.company_id } : {}),
        metadata: JSON.parse(row.metadata_json) as Record<string, string>,
        createdAt: row.created_at,
      }));
    });
  }

  private async beginRegistration(kind: "bootstrap" | "user" | "recovery", rawToken: string): Promise<AuthOptions<PublicKeyCredentialCreationOptionsJSON>> {
    const invitation = this.validInvitation(rawToken, kind);
    const userId = invitation.user_id ?? id("pending");
    const username = invitation.user_id ? `${invitation.user_id}@forge.local` : `${userId}@forge.local`;
    const existingCredentials = invitation.user_id
      ? this.database.authQuery((db) => db.prepare("SELECT credential_id, transports FROM forge_credentials WHERE user_id = ? AND revoked_at IS NULL").all(invitation.user_id) as Array<{ credential_id: string; transports: string }>)
      : [];
    let options: PublicKeyCredentialCreationOptionsJSON;
    try {
      options = await this.webAuthn.generateRegistrationOptions({
        userId: Buffer.from(userId).toString("base64url"),
        userName: username,
        displayName: invitation.display_name,
        rpId: this.rpId,
        excludeCredentials: existingCredentials.map((credential) => {
          const transports = this.parseTransports(credential.transports);
          return { id: credential.credential_id, ...(transports ? { transports } : {}) };
        }),
      });
    } catch {
      throw passkeyFailure();
    }
    const challengeId = id("challenge");
    const expiresAt = new Date(this.now().getTime() + 5 * 60 * 1000).toISOString();
    this.database.authTransaction((db) => {
      const current = this.findValidInvitation(db, hashSecret(rawToken), kind);
      if (!current) {
        throw invitationFailure();
      }
      db.prepare(`INSERT INTO forge_challenges (id, challenge, kind, invitation_id, user_id, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).run(challengeId, options.challenge, `registration:${kind}`, current.id, current.user_id, expiresAt, this.now().toISOString());
    });
    return { challengeId, options };
  }

  private async completeRegistration(kind: "bootstrap" | "user" | "recovery", input: { token: string; challengeId: string; response: unknown }): Promise<AuthResult> {
    const parsedToken = invitationTokenSchema.safeParse(input.token);
    const parsedChallenge = idSchema.safeParse(input.challengeId);
    if (!parsedToken.success || !parsedChallenge.success) {
      throw invitationFailure();
    }
    const response = parseResponse(input.response);
    const tokenHash = hashSecret(input.token);
    const ceremony = this.database.authTransaction((db) => {
      const invitation = this.findValidInvitation(db, tokenHash, kind);
      const challenge = db.prepare("SELECT * FROM forge_challenges WHERE id = ? AND kind = ?").get(input.challengeId, `registration:${kind}`) as ChallengeRow | undefined;
      if (!invitation || !challenge || challenge.invitation_id !== invitation.id || challenge.consumed_at || Date.parse(challenge.expires_at) <= this.now().getTime()) {
        throw invitationFailure();
      }
      db.prepare("UPDATE forge_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(this.now().toISOString(), challenge.id);
      return { invitation, challenge };
    });
    let verification: RegistrationVerification;
    try {
      verification = await this.webAuthn.verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge.challenge,
        expectedOrigin: this.origin,
        expectedRpId: this.rpId,
      });
    } catch {
      throw passkeyFailure();
    }
    if (!verification.verified) {
      throw passkeyFailure();
    }
    return this.database.authTransaction((db) => {
      const invitation = this.findValidInvitation(db, tokenHash, kind);
      if (!invitation) {
        throw invitationFailure();
      }
      let user: UserRow;
      const now = this.now().toISOString();
      if (kind === "bootstrap") {
        const admin = db.prepare("SELECT id FROM forge_users WHERE role = 'admin' AND status != 'revoked'").get() as { id: string } | undefined;
        if (admin) {
          throw invitationFailure();
        }
        const userId = id("user");
        db.prepare(`INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at)
          VALUES (?, ?, ?, 'admin', 'active', ?, ?)`).run(userId, invitation.display_name, `${userId}@forge.local`, now, now);
        user = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ?").get(userId) as UserRow;
      } else if (kind === "recovery") {
        db.prepare("UPDATE forge_users SET status = 'revoked', updated_at = ? WHERE role = 'admin' AND status = 'active'").run(now);
        db.prepare("UPDATE forge_credentials SET revoked_at = ? WHERE user_id IN (SELECT id FROM forge_users WHERE role = 'admin') AND revoked_at IS NULL").run(now);
        db.prepare("UPDATE forge_sessions SET revoked_at = ? WHERE user_id IN (SELECT id FROM forge_users WHERE role = 'admin') AND revoked_at IS NULL").run(now);
        const userId = id("user");
        db.prepare(`INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at)
          VALUES (?, ?, ?, 'admin', 'active', ?, ?)`).run(userId, invitation.display_name, `${userId}@forge.local`, now, now);
        user = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ?").get(userId) as UserRow;
      } else {
        if (!invitation.user_id) {
          throw invitationFailure();
        }
        const pending = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ? AND status = 'pending'").get(invitation.user_id) as UserRow | undefined;
        if (!pending) {
          throw invitationFailure();
        }
        user = pending;
        db.prepare("UPDATE forge_users SET status = 'active', updated_at = ? WHERE id = ?").run(now, user.id);
        user = { ...user, status: "active" };
      }
      try {
        db.prepare(`INSERT INTO forge_credentials (id, user_id, credential_id, public_key, counter, transports, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`).run(
          id("credential"),
          user.id,
          verification.credential.id,
          Buffer.from(verification.credential.publicKey),
          verification.credential.counter,
          safeJson(verification.credential.transports ?? []),
          now,
        );
      } catch {
        throw passkeyFailure();
      }
      db.prepare("UPDATE forge_invitations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND replaced_at IS NULL").run(now, invitation.id);
      this.audit(db, null, kind === "recovery" ? "recovery_completed" : "user_enrolled", user.id, null, {});
      return { user: this.userWithCompanies(db, user), sessionToken: this.createSession(db, user.id) };
    });
  }

  private validInvitation(rawToken: string, kind: InvitationKind): InvitationRow {
    if (!invitationTokenSchema.safeParse(rawToken).success) {
      throw invitationFailure();
    }
    const row = this.database.authQuery((db) => this.findValidInvitation(db, hashSecret(rawToken), kind));
    if (!row) {
      throw invitationFailure();
    }
    return row;
  }

  private findValidInvitation(db: import("better-sqlite3").Database, tokenHash: string, kind: InvitationKind): InvitationRow | undefined {
    const row = db.prepare("SELECT id, kind, display_name, user_id, expires_at, consumed_at, replaced_at FROM forge_invitations WHERE token_hash = ? AND kind = ?").get(tokenHash, kind) as InvitationRow | undefined;
    if (!row || row.consumed_at || row.replaced_at || Date.parse(row.expires_at) <= this.now().getTime()) {
      return undefined;
    }
    if (kind === "bootstrap" && db.prepare("SELECT id FROM forge_users WHERE role = 'admin' AND status != 'revoked' LIMIT 1").get()) {
      return undefined;
    }
    if (kind === "user" && (!row.user_id || !db.prepare("SELECT id FROM forge_users WHERE id = ? AND status = 'pending'").get(row.user_id))) {
      return undefined;
    }
    return row;
  }

  private issueInvitation(db: import("better-sqlite3").Database, kind: InvitationKind, displayName: string, userId?: string): IssuedInvitation {
    const now = this.now();
    const nowIso = now.toISOString();
    if (kind !== "user") {
      db.prepare("UPDATE forge_invitations SET replaced_at = ? WHERE kind = ? AND consumed_at IS NULL AND replaced_at IS NULL").run(nowIso, kind);
    }
    const rawToken = token(kind);
    const expiresAt = new Date(now.getTime() + this.invitationTtlMs).toISOString();
    db.prepare(`INSERT INTO forge_invitations (id, token_hash, kind, display_name, user_id, expires_at, consumed_at, replaced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`).run(id("invitation"), hashSecret(rawToken), kind, displayName, userId ?? null, expiresAt, nowIso);
    this.audit(db, null, `${kind}_invitation_created`, userId ?? null, null, {});
    return { token: rawToken, kind, expiresAt };
  }

  private requireUser(db: import("better-sqlite3").Database, userId: string): UserRow {
    const user = db.prepare("SELECT id, display_name, username, role, status FROM forge_users WHERE id = ? AND status = 'active'").get(userId) as UserRow | undefined;
    if (!user) {
      throw new AuthFailure("Authentication required", 401);
    }
    return user;
  }

  private requireAdmin(db: import("better-sqlite3").Database, userId: string): UserRow {
    const user = this.requireUser(db, userId);
    if (user.role !== "admin") {
      throw new AuthFailure("Not found", 404);
    }
    return user;
  }

  private userWithCompanies(db: import("better-sqlite3").Database, row: UserRow): AuthUser {
    const companyRows = db.prepare("SELECT company_id FROM forge_memberships WHERE user_id = ? ORDER BY company_id").all(row.id) as Array<{ company_id: string }>;
    return publicUser(row, companyRows.map((company) => company.company_id));
  }

  private createSession(db: import("better-sqlite3").Database, userId: string): string {
    const rawToken = `forge_session_${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    db.prepare(`INSERT INTO forge_sessions (id, token_hash, user_id, expires_at, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)`).run(id("session"), hashSecret(rawToken), userId, new Date(now.getTime() + this.sessionTtlMs).toISOString(), now.toISOString());
    return rawToken;
  }

  private audit(db: import("better-sqlite3").Database, actorUserId: string | null, action: string, targetUserId: string | null, companyId: string | null, metadata: Record<string, string>): void {
    db.prepare(`INSERT INTO forge_audit_events (id, actor_user_id, action, target_user_id, company_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id("audit"), actorUserId, action, targetUserId, companyId, safeJson(metadata), this.now().toISOString());
  }

  private parseTransports(value: string): AuthenticatorTransportFuture[] | undefined {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      return parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === "string" && ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(item));
    } catch {
      return undefined;
    }
  }
}
