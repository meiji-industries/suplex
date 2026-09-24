import { createHash, randomBytes } from "node:crypto";

import type { Database } from "better-sqlite3";

import type { SuplexConfig } from "../platform/config.js";
import type { SuplexDatabase } from "../platform/database.js";
import { AuthRepository, type AuthCompanyRow } from "./auth-repository.js";
import { neutralUsername, newInvitationToken, newSessionToken } from "./auth-identifiers.js";
import { jsonRequired } from "../shared/json.js";
import {
  productionWebAuthnAdapter,
  type AuthenticationVerification,
  type AuthenticatorTransportFuture,
  type WebAuthnAdapter,
} from "./auth-webauthn.js";
import {
  AuthFailure, companyIssueCodeSchema, companyNameSchema, displayNameSchema, idSchema,
  invitationFailure, invitationTokenSchema, parseResponse, passkeyFailure, usernameSchema,
  type AuditEvent, type AuthCredential, type AuthOptions, type AuthResult, type AuthServiceOptions,
  type AuthUser, type Company, type InvitationKind, type InvitationRow, type InvitationSummary, type IssuedInvitation,
  type LocalRecoveryRequest, type UserRole, type UserStatus,
} from "./auth-contracts.js";
import { beginRegistration as beginRegistrationFlow, completeRegistration as completeRegistrationFlow } from "./registration.js";

export type { AuthenticationVerification, RegistrationVerification, WebAuthnAdapter } from "./auth-webauthn.js";
export { productionWebAuthnAdapter } from "./auth-webauthn.js";
export {
  AuthFailure,
  type AuditEvent,
  type AuthCredential,
  type AuthOptions,
  type AuthResult,
  type AuthUser,
  type Company,
  type InvitationKind,
  type InvitationSummary,
  type IssuedInvitation,
  type LocalRecoveryRequest,
  type UserRole,
  type UserStatus,
} from "./auth-contracts.js";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? "{}";
}

function safeMetadata(value: string): Record<string, string> {
  try {
    const parsed = jsonRequired(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly now: () => Date;
  private readonly invitationTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly webAuthn: WebAuthnAdapter;
  private readonly rpId: string;
  private readonly origin: string;
  private readonly installationId: string;

  constructor(private readonly database: SuplexDatabase, config: SuplexConfig, options: AuthServiceOptions = {}) {
    this.repository = new AuthRepository(database.authOrm());
    this.now = options.now ?? (() => new Date());
    this.invitationTtlMs = options.invitationTtlMs ?? 72 * 60 * 60 * 1000;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.webAuthn = options.webAuthn ?? productionWebAuthnAdapter;
    this.installationId = config.installationId;
    const reachable = new URL(config.reachableAddress);
    this.rpId = reachable.hostname;
    this.origin = reachable.origin;
    if (reachable.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(reachable.hostname)) {
      throw new Error("Suplex passkey authentication requires an HTTPS reachable address");
    }
    // A database can be upgraded while the process is stopped, or an older
    // fixture can be attached after migrations have already run. Normalize any
    // remaining version-zero usernames at the repository boundary as well.
    this.repository.normalizeLegacyUsers();
  }

  getBootstrapState(): { required: boolean } {
    return { required: this.repository.activeAdminCount() === 0 };
  }

  ensureBootstrapInvitation(): IssuedInvitation | undefined {
    if (!this.getBootstrapState().required) {
      return undefined;
    }
    return this.database.authTransaction((db) => this.issueInvitation(db, "bootstrap", "Suplex administrator"));
  }

  createRecoveryInvitation(request: LocalRecoveryRequest): IssuedInvitation {
    if (!request.confirmed || request.initiationMethod !== "local-cli" || request.installationId !== this.installationId) {
      throw new AuthFailure("Local recovery confirmation is required", 403, "recovery_local_confirmation_required");
    }
    return this.database.authTransaction((db) => this.issueInvitation(db, "recovery", "Administrator recovery", undefined, {
      initiationMethod: request.initiationMethod,
      installationId: this.installationId,
      confirmedAt: this.now().toISOString(),
    }));
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
    const credentials = this.repository.activeCredentialOptions();
    if (credentials.length === 0) {
      throw new AuthFailure("No passkey is enrolled", 400);
    }
    const options = await this.webAuthn.generateAuthenticationOptions({
      rpId: this.rpId,
      allowCredentials: credentials.map((credential) => {
        const transports = this.parseTransports(credential.transports);
        return { id: credential.credentialId, ...(transports ? { transports } : {}) };
      }),
    });
    const challengeId = id("challenge");
    const expiresAt = new Date(this.now().getTime() + 5 * 60 * 1000).toISOString();
    this.repository.createChallenge({ id: challengeId, challenge: options.challenge, kind: "authentication", invitationId: null, userId: null, expiresAt, consumedAt: null, createdAt: this.now().toISOString() });
    return { challengeId, options };
  }

  async completeAuthentication(input: { challengeId: string; response: unknown }): Promise<AuthResult> {
    const challengeId = idSchema.safeParse(input.challengeId);
    if (!challengeId.success) {
      throw passkeyFailure();
    }
    const response = parseResponse(input.response);
    const challenge = this.database.authTransaction(() => {
      const row = this.repository.findChallenge(input.challengeId, "authentication");
      if (!row || row.consumedAt || Date.parse(row.expiresAt) <= this.now().getTime()) {
        throw passkeyFailure();
      }
      if (!this.repository.consumeChallenge(row.id, this.now().toISOString())) throw passkeyFailure();
      return row;
    });
    const credential = this.repository.findCredentialForAuthentication(response.id);
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
          id: credential.credentialId,
          publicKey: Uint8Array.from(credential.publicKey),
          counter: credential.counter,
          ...(transports ? { transports } : {}),
        },
      });
    } catch {
      throw passkeyFailure();
    }
    if (!verification.verified || (credential.counter > 0 && verification.newCounter <= credential.counter)) {
      throw passkeyFailure();
    }
    return this.database.authTransaction(() => {
      if (!this.repository.updateCredentialCounter(credential.id, credential.counter, verification.newCounter)) {
        throw passkeyFailure();
      }
      const user = this.repository.findUser(credential.userId, "active");
      if (!user) {
        throw passkeyFailure();
      }
      return { user: this.publicRepositoryUser(user), sessionToken: this.createSession(user.id) };
    });
  }

  async getUserBySession(rawToken: string): Promise<AuthUser | undefined> {
    if (!rawToken) {
      return undefined;
    }
    const row = this.repository.findSessionUser(hashSecret(rawToken), this.now().toISOString());
    if (!row || row.status !== "active" || Date.parse(row.expiresAt) <= this.now().getTime()) {
      return undefined;
    }
    return this.publicRepositoryUser(row);
  }

  ensureDevelopmentUser(): AuthUser {
    return this.database.authTransaction(() => {
      const userId = "user_development";
      const now = this.now().toISOString();
      let user = this.repository.findUser(userId);
      if (!user) {
        this.repository.createUser({ id: userId, displayName: "Operator", username: "operator@suplex.local", avatarSeed: "operator@suplex.local", role: "admin", status: "active", createdAt: now, updatedAt: now, identityVersion: 1 });
        user = this.repository.findUser(userId)!;
      }
      if (user.role !== "admin" || user.status !== "active") throw new AuthFailure("Development user is unavailable", 409);
      return this.publicRepositoryUser(user);
    });
  }

  developmentSignIn(): AuthResult {
    const user = this.ensureDevelopmentUser();
    return { user, sessionToken: this.createSession(user.id) };
  }

  getUserForAuthority(userId: string): AuthUser | undefined {
    const row = this.repository.findUser(userId, "active");
    return row ? this.publicRepositoryUser(row) : undefined;
  }

  updateUsername(actorUserId: string, rawUsername: string): AuthUser {
    return this.updateProfile(actorUserId, { username: rawUsername });
  }

  updateProfile(actorUserId: string, input: { displayName?: string | undefined; username?: string | undefined; avatarSeed?: string | undefined }): AuthUser {
    const displayName = input.displayName === undefined ? undefined : displayNameSchema.safeParse(input.displayName);
    if (displayName && !displayName.success) throw new AuthFailure("Name must be 1–120 characters");
    const username = input.username === undefined ? undefined : usernameSchema.safeParse(input.username);
    if (username && !username.success) throw new AuthFailure("Username must be 2–64 characters and use letters, numbers, dots, hyphens, underscores, or @");
    const avatarSeed = input.avatarSeed?.trim();
    if (avatarSeed !== undefined && (avatarSeed.length === 0 || avatarSeed.length > 128)) throw new AuthFailure("Avatar seed is invalid");
    return this.database.authTransaction(() => {
      const user = this.repository.findUser(actorUserId, "active");
      if (!user) throw new AuthFailure("Authentication required", 401);
      const nextDisplayName = displayName?.data ?? user.displayName;
      const nextUsername = username?.data ?? user.username;
      const nextAvatarSeed = (avatarSeed ?? user.avatarSeed) || nextUsername;
      if (user.displayName === nextDisplayName && user.username === nextUsername && (user.avatarSeed || user.username) === nextAvatarSeed) return this.publicRepositoryUser(user);
      const updatedAt = this.now().toISOString();
      if (user.username !== nextUsername) {
        try { this.repository.updateUsername(user.id, nextUsername, updatedAt); }
        catch { throw new AuthFailure("Username is already in use", 409, "username_taken"); }
      }
      if (user.displayName !== nextDisplayName) this.repository.updateDisplayName(user.id, nextDisplayName, updatedAt);
      if ((user.avatarSeed || user.username) !== nextAvatarSeed) this.repository.updateAvatarSeed(user.id, nextAvatarSeed, updatedAt);
      if (user.displayName !== nextDisplayName) this.recordAuditEventInTransaction(undefined, user.id, "display_name_updated", user.id, undefined, {});
      if (user.username !== nextUsername) this.recordAuditEventInTransaction(undefined, user.id, "username_updated", user.id, undefined, {});
      if ((user.avatarSeed || user.username) !== nextAvatarSeed) this.recordAuditEventInTransaction(undefined, user.id, "avatar_updated", user.id, undefined, {});
      return this.publicRepositoryUser({ ...user, displayName: nextDisplayName, username: nextUsername, avatarSeed: nextAvatarSeed });
    });
  }

  recordAuditEvent(actorUserId: string | undefined, action: string, targetUserId?: string, companyId?: string, metadata: Record<string, string> = {}): void {
    this.repository.recordAuditEvent({ id: id("audit"), actorUserId: actorUserId ?? null, actorAgentId: null, action, targetUserId: targetUserId ?? null, companyId: companyId ?? null, metadataJson: safeJson(metadata), createdAt: this.now().toISOString() });
  }

  recordAuditEventInTransaction(_database: Database | undefined, actorUserId: string | undefined, action: string, targetUserId?: string, companyId?: string, metadata: Record<string, string> = {}): void {
    this.repository.recordAuditEvent({ id: id("audit"), actorUserId: actorUserId ?? null, actorAgentId: null, action, targetUserId: targetUserId ?? null, companyId: companyId ?? null, metadataJson: safeJson(metadata), createdAt: this.now().toISOString() });
  }

  recordAgentAuditEvent(actorAgentId: string | undefined, action: string, targetUserId?: string, companyId?: string, metadata: Record<string, string> = {}): void {
    this.repository.recordAuditEvent({ id: id("audit"), actorUserId: null, actorAgentId: actorAgentId ?? null, action, targetUserId: targetUserId ?? null, companyId: companyId ?? null, metadataJson: safeJson(metadata), createdAt: this.now().toISOString() });
  }

  recordAgentAuditEventInTransaction(_database: Database | undefined, actorAgentId: string | undefined, action: string, targetUserId?: string, companyId?: string, metadata: Record<string, string> = {}): void {
    this.repository.recordAuditEvent({ id: id("audit"), actorUserId: null, actorAgentId: actorAgentId ?? null, action, targetUserId: targetUserId ?? null, companyId: companyId ?? null, metadataJson: safeJson(metadata), createdAt: this.now().toISOString() });
  }

  signOut(rawToken: string): void {
    if (!rawToken) {
      return;
    }
    this.repository.revokeSessionByToken(hashSecret(rawToken), this.now().toISOString());
  }

  /**
   * Upgrade a pre-neutral session in place. The row identity is preserved so
   * rollover cannot create a second active session for the same login.
   */
  rolloverLegacySession(rawToken: string): string | undefined {
    if (!rawToken) return undefined;
    return this.database.authTransaction(() => {
      const nextToken = newSessionToken();
      const legacyHash = hashSecret(rawToken);
      return this.repository.rolloverLegacySession(legacyHash, hashSecret(nextToken), new Date(this.now().getTime() + this.sessionTtlMs).toISOString()) ? nextToken : undefined;
    });
  }

  inviteUser(actorUserId: string, input: { displayName: string }): IssuedInvitation {
    const displayName = displayNameSchema.safeParse(input.displayName);
    if (!displayName.success) {
      throw new AuthFailure("Display name is invalid");
    }
    return this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const userId = id("user");
      const now = this.now().toISOString();
      this.repository.createUser({ id: userId, displayName: displayName.data, username: neutralUsername(userId), avatarSeed: neutralUsername(userId), role: "member", status: "pending", createdAt: now, updatedAt: now, identityVersion: 1 });
      const invitation = this.issueInvitation(undefined, "user", displayName.data, userId);
      this.recordAuditEventInTransaction(undefined, actorUserId, "user_invited", userId, undefined, {});
      return { ...invitation, user: this.publicRepositoryUser(this.repository.findUser(userId)!) };
    });
  }

  listUsers(actorUserId: string): AuthUser[] {
    this.requireAdminById(actorUserId);
    return this.repository.listUsers().map((row) => this.publicRepositoryUser(row));
  }

  listInvitations(actorUserId: string): InvitationSummary[] {
    this.requireAdminById(actorUserId);
    return this.repository.listInvitations().map((row) => ({
      id: row.id,
      kind: row.kind,
      displayName: row.displayName,
      expiresAt: row.expiresAt,
      status: row.consumedAt ? "consumed" : row.replacedAt ? "replaced" : Date.parse(row.expiresAt) <= this.now().getTime() ? "expired" : "active",
      createdAt: row.createdAt,
    }));
  }

  listCredentials(actorUserId: string): AuthCredential[] {
    this.requireAdminById(actorUserId);
    return this.repository.listCredentials().map((row) => ({ id: row.id, userId: row.userId, credentialId: row.credentialId, createdAt: row.createdAt, ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}) }));
  }

  revokeCredential(actorUserId: string, credentialId: string): void {
    this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const credential = this.repository.findCredential(credentialId);
      if (!credential || credential.revokedAt || credential.userId === actorUserId) {
        throw new AuthFailure("Not found", 404);
      }
      const now = this.now().toISOString();
      this.repository.revokeCredential(credential.id, now);
      this.recordAuditEventInTransaction(undefined, actorUserId, "credential_revoked", credential.userId, undefined, {});
    });
  }

  revokeUser(actorUserId: string, targetUserId: string): void {
    this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const target = this.repository.findUser(targetUserId);
      if (!target || target.id === actorUserId || target.status === "revoked") {
        throw new AuthFailure("Not found", 404);
      }
      const now = this.now().toISOString();
      this.repository.updateUserStatus(target.id, "revoked", now);
      this.repository.revokeCredentialsForUsers([target.id], now);
      this.repository.revokeSessionsForUsers([target.id], now);
      this.recordAuditEventInTransaction(undefined, actorUserId, "user_revoked", target.id, undefined, {});
    });
  }

  createCompany(actorUserId: string, rawName: string): Company {
    const name = companyNameSchema.safeParse(rawName);
    if (!name.success) {
      throw new AuthFailure("Company name is invalid");
    }
    return this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const company = { id: id("company"), name: name.data, status: "active" as const, issueCode: null, nextIssueNumber: 1, createdAt: this.now().toISOString() };
      try {
        this.repository.createCompany(company);
      } catch {
        throw new AuthFailure("Company name is already in use");
      }
      this.recordAuditEventInTransaction(undefined, actorUserId, "company_created", undefined, company.id, {});
      return this.publicCompany(company);
    });
  }

  renameCompany(actorUserId: string, companyId: string, rawName: string): Company {
    return this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      if (!idSchema.safeParse(companyId).success) {
        throw new AuthFailure("Not found", 404);
      }
      const name = companyNameSchema.safeParse(rawName);
      if (!name.success) {
        throw new AuthFailure("Company name is invalid");
      }
      const company = this.repository.findCompany(companyId);
      if (!company) {
        throw new AuthFailure("Not found", 404);
      }
      if (company.name === name.data) {
        return this.publicCompany(company);
      }
      try {
        this.repository.updateCompany(companyId, { name: name.data });
      } catch {
        throw new AuthFailure("Company name is already in use");
      }
      this.recordAuditEventInTransaction(undefined, actorUserId, "company_renamed", undefined, companyId, { previousName: company.name, newName: name.data });
      return this.publicCompany({ ...company, name: name.data });
    });
  }

  setCompanyIssueCode(actorUserId: string, companyId: string, rawIssueCode: string | null): Company {
    if (!idSchema.safeParse(companyId).success) throw new AuthFailure("Not found", 404);
    return this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const issueCode = rawIssueCode === null ? null : rawIssueCode.trim().toUpperCase();
      if (issueCode !== null && !companyIssueCodeSchema.safeParse(issueCode).success) {
        throw new AuthFailure("Issue code must be 2–10 letters or numbers and start with a letter");
      }
      const company = this.repository.findCompany(companyId);
      if (!company) throw new AuthFailure("Not found", 404);
      if (company.issueCode === issueCode) return this.publicCompany(company);
      if (company.issueCode !== null && company.nextIssueNumber > 1) {
        throw new AuthFailure("Issue code cannot be changed after issues have been created", 409, "company_issue_code_locked");
      }
      this.repository.updateCompany(companyId, { issueCode });
      this.recordAuditEventInTransaction(undefined, actorUserId, "company_issue_code_updated", undefined, companyId, { previousIssueCode: company.issueCode ?? "", newIssueCode: issueCode ?? "" });
      return this.publicCompany({ ...company, issueCode });
    });
  }

  setCompanyStatus(actorUserId: string, companyId: string, status: "active" | "paused" | "archived"): Company {
    if (!["active", "paused", "archived"].includes(status)) throw new AuthFailure("Company status is invalid");
    if (!idSchema.safeParse(companyId).success) throw new AuthFailure("Not found", 404);
    return this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const company = this.repository.findCompany(companyId);
      if (!company) throw new AuthFailure("Not found", 404);
      this.repository.updateCompany(companyId, { status });
      this.recordAuditEventInTransaction(undefined, actorUserId, `company_${status}`, undefined, companyId, {});
      return this.publicCompany({ ...company, status });
    });
  }

  listVisibleCompanies(actorUserId: string): Company[] {
    const user = this.repository.findUser(actorUserId, "active");
    if (!user) throw new AuthFailure("Authentication required", 401);
    return this.repository.listCompaniesForUser(actorUserId, user.role).map((row) => this.publicCompany(row));
  }

  requireCompanyAccess(actorUserId: string, companyId: string): Company {
    const parsedId = idSchema.safeParse(companyId);
    if (!parsedId.success) {
      throw new AuthFailure("Not found", 404);
    }
    const user = this.repository.findUser(actorUserId, "active");
    if (!user) throw new AuthFailure("Authentication required", 401);
    const company = this.repository.findCompanyForUser(actorUserId, user.role, companyId);
    if (!company) throw new AuthFailure("Not found", 404);
    return this.publicCompany(company);
  }

  addMembership(actorUserId: string, targetUserId: string, companyId: string): void {
    this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      const target = this.repository.findUser(targetUserId);
      const company = this.repository.findCompany(companyId);
      if (!target || target.status === "revoked" || !company) {
        throw new AuthFailure("Not found", 404);
      }
      try {
        this.repository.addMembership(targetUserId, companyId, this.now().toISOString());
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: suplex_memberships/i.test(error.message)) {
          throw new AuthFailure("Membership already exists", 409, "membership_duplicate");
        }
        throw error;
      }
      this.recordAuditEventInTransaction(undefined, actorUserId, "membership_added", targetUserId, companyId, {});
    });
  }

  removeMembership(actorUserId: string, targetUserId: string, companyId: string): void {
    this.database.authTransaction(() => {
      this.requireAdminById(actorUserId);
      if (!this.repository.removeMembership(targetUserId, companyId)) {
        throw new AuthFailure("Not found", 404);
      }
      this.recordAuditEventInTransaction(undefined, actorUserId, "membership_removed", targetUserId, companyId, {});
    });
  }

  listAuditEvents(actorUserId: string): AuditEvent[] {
    this.requireAdminById(actorUserId);
    return this.repository.listAuditEvents().map((row) => ({
      id: row.id,
      ...(row.actorUserId ? { actorUserId: row.actorUserId } : {}),
      action: row.action,
      ...(row.targetUserId ? { targetUserId: row.targetUserId } : {}),
      ...(row.companyId ? { companyId: row.companyId } : {}),
      metadata: safeMetadata(row.metadataJson),
      createdAt: row.createdAt,
    }));
  }

  private registrationDependencies() {
    return {
      database: this.database,
      repository: this.repository,
      webAuthn: this.webAuthn,
      rpId: this.rpId,
      origin: this.origin,
      now: this.now,
      createId: id,
      hashSecret,
      findValidInvitation: (tokenHash: string, kind: InvitationKind) => this.findValidInvitation(undefined, tokenHash, kind),
      validInvitation: (rawToken: string, kind: InvitationKind) => this.validInvitation(rawToken, kind),
      parseTransports: (value: string) => this.parseTransports(value),
      safeJson,
      recordAuditEvent: (action: string, userId: string, metadata: Record<string, string>) => this.recordAuditEventInTransaction(undefined, undefined, action, userId, undefined, metadata),
      publicUser: (user: { id: string; displayName: string; username: string; avatarSeed?: string; role: UserRole; status: UserStatus }) => this.publicRepositoryUser(user),
      createSession: (userId: string) => this.createSession(userId),
      safeMetadata,
    };
  }

  private async beginRegistration(kind: "bootstrap" | "user" | "recovery", rawToken: string): Promise<AuthOptions<PublicKeyCredentialCreationOptionsJSON>> {
    return beginRegistrationFlow(this.registrationDependencies(), kind, rawToken);
  }

  private async completeRegistration(kind: "bootstrap" | "user" | "recovery", input: { token: string; challengeId: string; response: unknown }): Promise<AuthResult> {
    return completeRegistrationFlow(this.registrationDependencies(), kind, input);
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

  private findValidInvitation(_db: Database | undefined, tokenHash: string, kind: InvitationKind): InvitationRow | undefined {
    const row = this.repository.findInvitation(tokenHash, kind);
    if (!row || row.consumedAt || row.replacedAt || Date.parse(row.expiresAt) <= this.now().getTime()) {
      return undefined;
    }
    if (kind === "bootstrap" && this.repository.hasActiveAdmin()) {
      return undefined;
    }
    if (kind === "user" && (!row.userId || !this.repository.findUser(row.userId, "pending"))) {
      return undefined;
    }
    return { id: row.id, kind: row.kind, display_name: row.displayName, user_id: row.userId, expires_at: row.expiresAt, consumed_at: row.consumedAt, replaced_at: row.replacedAt, metadata_json: row.metadataJson };
  }

  private issueInvitation(_db: Database | undefined, kind: InvitationKind, displayName: string, userId?: string, metadata: Record<string, string> = {}): IssuedInvitation {
    const now = this.now();
    const nowIso = now.toISOString();
    if (kind !== "user") {
      this.repository.replaceInvitations(kind, nowIso);
    }
    const rawToken = newInvitationToken(kind);
    const expiresAt = new Date(now.getTime() + this.invitationTtlMs).toISOString();
    this.repository.createInvitation({ id: id("invitation"), tokenHash: hashSecret(rawToken), kind, displayName, userId: userId ?? null, expiresAt, consumedAt: null, replacedAt: null, createdAt: nowIso, metadataJson: safeJson(metadata) });
    this.recordAuditEventInTransaction(undefined, undefined, `${kind}_invitation_created`, userId, undefined, metadata);
    return { token: rawToken, kind, expiresAt };
  }

  private requireAdminById(userId: string): void {
    const user = this.repository.findUser(userId, "active");
    if (!user) throw new AuthFailure("Authentication required", 401);
    if (user.role !== "admin") throw new AuthFailure("Not found", 404);
  }

  private publicRepositoryUser(row: { id: string; displayName: string; username: string; avatarSeed?: string; role: UserRole; status: UserStatus }): AuthUser {
    return { id: row.id, displayName: row.displayName, username: row.username, avatarSeed: row.avatarSeed || row.username, role: row.role, status: row.status, companyIds: this.repository.userCompanyIds(row.id) };
  }

  private publicCompany(row: AuthCompanyRow): Company {
    return { id: row.id, name: row.name, status: row.status, issueCode: row.issueCode, createdAt: row.createdAt };
  }

  private createSession(userId: string): string {
    const rawToken = newSessionToken();
    const now = this.now();
    this.repository.createSession({
      id: id("session"),
      tokenHash: hashSecret(rawToken),
      userId,
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
      createdAt: now.toISOString(),
      revokedAt: null,
      tokenVersion: 1,
      legacyTokenHash: null,
      legacyTokenExpiresAt: null,
    });
    return rawToken;
  }

  private parseTransports(value: string): AuthenticatorTransportFuture[] | undefined {
    try {
      const parsed = jsonRequired(value) as unknown;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      return parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === "string" && ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(item));
    } catch {
      return undefined;
    }
  }
}
