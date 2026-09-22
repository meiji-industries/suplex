import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { suplexAuditEvents, suplexChallenges, suplexCompanies, suplexCredentials, suplexInvitations, suplexMemberships, suplexSessions, suplexUsers, type AuthSchema } from "./auth-schema.js";

export type AuthDatabase = BetterSQLite3Database<AuthSchema>;
export type AuthUserRow = typeof suplexUsers.$inferSelect;
export type AuthCredentialRow = typeof suplexCredentials.$inferSelect;
export type AuthInvitationRow = typeof suplexInvitations.$inferSelect;
export type AuthChallengeRow = typeof suplexChallenges.$inferSelect;
export type AuthCompanyRow = typeof suplexCompanies.$inferSelect;
export type AuthSessionRow = typeof suplexSessions.$inferSelect;
export type AuthAuditRow = typeof suplexAuditEvents.$inferSelect;

export type SessionUserRow = Pick<AuthUserRow, "id" | "displayName" | "username" | "avatarSeed" | "role" | "status"> & { expiresAt: string };

export class AuthRepository {
  constructor(private readonly db: AuthDatabase) {}

  normalizeLegacyUsers(): void {
    this.db.update(suplexUsers).set({ username: sql`'user_v1_' || ${suplexUsers.id}`, identityVersion: 1 }).where(lt(suplexUsers.identityVersion, 1)).run();
  }

  activeAdminCount(): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(suplexUsers).where(and(eq(suplexUsers.role, "admin"), ne(suplexUsers.status, "revoked"))).get();
    return Number(row?.count ?? 0);
  }

  hasActiveAdmin(): boolean {
    return this.db.select({ id: suplexUsers.id }).from(suplexUsers).where(and(eq(suplexUsers.role, "admin"), ne(suplexUsers.status, "revoked"))).limit(1).get() !== undefined;
  }

  activeAdminIds(): string[] {
    return this.db.select({ id: suplexUsers.id }).from(suplexUsers).where(and(eq(suplexUsers.role, "admin"), eq(suplexUsers.status, "active"))).all().map((row) => row.id);
  }

  findUser(userId: string, status: "active" | "pending" | "any" = "any"): AuthUserRow | undefined {
    const query = this.db.select().from(suplexUsers).where(status === "any" ? eq(suplexUsers.id, userId) : and(eq(suplexUsers.id, userId), eq(suplexUsers.status, status)));
    return query.get();
  }

  listUsers(): AuthUserRow[] {
    return this.db.select().from(suplexUsers).orderBy(asc(suplexUsers.createdAt)).all();
  }

  createUser(user: AuthUserRow): void {
    this.db.insert(suplexUsers).values(user).run();
  }

  updateUserStatus(userId: string, status: "active" | "revoked", updatedAt: string): void {
    this.db.update(suplexUsers).set({ status, updatedAt }).where(eq(suplexUsers.id, userId)).run();
  }

  updateUsername(userId: string, username: string, updatedAt: string): void {
    this.db.update(suplexUsers).set({ username, updatedAt }).where(eq(suplexUsers.id, userId)).run();
  }

  updateDisplayName(userId: string, displayName: string, updatedAt: string): void {
    this.db.update(suplexUsers).set({ displayName, updatedAt }).where(eq(suplexUsers.id, userId)).run();
  }

  updateAvatarSeed(userId: string, avatarSeed: string, updatedAt: string): void {
    this.db.update(suplexUsers).set({ avatarSeed, updatedAt }).where(eq(suplexUsers.id, userId)).run();
  }

  userCompanyIds(userId: string): string[] {
    return this.db.select({ companyId: suplexMemberships.companyId }).from(suplexMemberships).where(eq(suplexMemberships.userId, userId)).orderBy(asc(suplexMemberships.companyId)).all().map((row) => row.companyId);
  }

  findCredentialForAuthentication(credentialId: string): (AuthCredentialRow & { userStatus: AuthUserRow["status"] }) | undefined {
    const row = this.db.select({
      id: suplexCredentials.id,
      userId: suplexCredentials.userId,
      credentialId: suplexCredentials.credentialId,
      publicKey: suplexCredentials.publicKey,
      counter: suplexCredentials.counter,
      transports: suplexCredentials.transports,
      createdAt: suplexCredentials.createdAt,
      revokedAt: suplexCredentials.revokedAt,
      userStatus: suplexUsers.status,
    }).from(suplexCredentials).innerJoin(suplexUsers, eq(suplexUsers.id, suplexCredentials.userId)).where(and(eq(suplexCredentials.credentialId, credentialId), isNull(suplexCredentials.revokedAt), eq(suplexUsers.status, "active"))).get();
    return row;
  }

  activeCredentialOptions(): Array<Pick<AuthCredentialRow, "credentialId" | "transports">> {
    return this.db.select({ credentialId: suplexCredentials.credentialId, transports: suplexCredentials.transports }).from(suplexCredentials).innerJoin(suplexUsers, eq(suplexUsers.id, suplexCredentials.userId)).where(and(isNull(suplexCredentials.revokedAt), eq(suplexUsers.status, "active"))).orderBy(asc(suplexCredentials.createdAt)).all();
  }

  credentialsForUser(userId: string): Array<Pick<AuthCredentialRow, "credentialId" | "transports">> {
    return this.db.select({ credentialId: suplexCredentials.credentialId, transports: suplexCredentials.transports }).from(suplexCredentials).where(and(eq(suplexCredentials.userId, userId), isNull(suplexCredentials.revokedAt))).all();
  }

  listCredentials(): AuthCredentialRow[] {
    return this.db.select().from(suplexCredentials).orderBy(asc(suplexCredentials.createdAt), asc(suplexCredentials.id)).all();
  }

  findCredential(id: string): AuthCredentialRow | undefined {
    return this.db.select().from(suplexCredentials).where(eq(suplexCredentials.id, id)).get();
  }

  createCredential(credential: AuthCredentialRow): void {
    this.db.insert(suplexCredentials).values(credential).run();
  }

  updateCredentialCounter(id: string, previousCounter: number, nextCounter: number): boolean {
    const result = this.db.update(suplexCredentials).set({ counter: nextCounter }).where(and(eq(suplexCredentials.id, id), isNull(suplexCredentials.revokedAt), eq(suplexCredentials.counter, previousCounter))).run();
    return result.changes === 1;
  }

  revokeCredential(id: string, revokedAt: string): boolean {
    const result = this.db.update(suplexCredentials).set({ revokedAt }).where(and(eq(suplexCredentials.id, id), isNull(suplexCredentials.revokedAt))).run();
    return result.changes === 1;
  }

  revokeCredentialsForUsers(userIds: string[], revokedAt: string): void {
    if (userIds.length === 0) return;
    this.db.update(suplexCredentials).set({ revokedAt }).where(and(inArray(suplexCredentials.userId, userIds), isNull(suplexCredentials.revokedAt))).run();
  }

  findSessionUser(rawHash: string, now: string): SessionUserRow | undefined {
    return this.db.select({ id: suplexUsers.id, displayName: suplexUsers.displayName, username: suplexUsers.username, avatarSeed: suplexUsers.avatarSeed, role: suplexUsers.role, status: suplexUsers.status, expiresAt: suplexSessions.expiresAt }).from(suplexSessions).innerJoin(suplexUsers, eq(suplexSessions.userId, suplexUsers.id)).where(and(or(eq(suplexSessions.tokenHash, rawHash), and(eq(suplexSessions.legacyTokenHash, rawHash), gt(suplexSessions.legacyTokenExpiresAt, now))), isNull(suplexSessions.revokedAt))).get();
  }

  createSession(session: AuthSessionRow): void {
    this.db.insert(suplexSessions).values(session).run();
  }

  revokeSessionByToken(rawHash: string, revokedAt: string): void {
    this.db.update(suplexSessions).set({ revokedAt }).where(and(or(eq(suplexSessions.tokenHash, rawHash), eq(suplexSessions.legacyTokenHash, rawHash)), isNull(suplexSessions.revokedAt))).run();
  }

  revokeSessionsForUsers(userIds: string[], revokedAt: string): void {
    if (userIds.length === 0) return;
    this.db.update(suplexSessions).set({ revokedAt }).where(and(inArray(suplexSessions.userId, userIds), isNull(suplexSessions.revokedAt))).run();
  }

  rolloverLegacySession(rawHash: string, replacementHash: string, legacyExpiresAt: string): boolean {
    const result = this.db.update(suplexSessions).set({ tokenHash: replacementHash, tokenVersion: 1, legacyTokenHash: rawHash, legacyTokenExpiresAt: legacyExpiresAt }).where(and(eq(suplexSessions.tokenHash, rawHash), eq(suplexSessions.tokenVersion, 0), isNull(suplexSessions.revokedAt))).run();
    return result.changes === 1;
  }

  findInvitation(tokenHash: string, kind: "bootstrap" | "user" | "recovery"): AuthInvitationRow | undefined {
    return this.db.select().from(suplexInvitations).where(and(eq(suplexInvitations.tokenHash, tokenHash), eq(suplexInvitations.kind, kind))).get();
  }

  listInvitations(): AuthInvitationRow[] {
    return this.db.select().from(suplexInvitations).orderBy(desc(suplexInvitations.createdAt), desc(suplexInvitations.id)).all();
  }

  replaceInvitations(kind: "bootstrap" | "recovery", replacedAt: string): void {
    this.db.update(suplexInvitations).set({ replacedAt }).where(and(eq(suplexInvitations.kind, kind), isNull(suplexInvitations.consumedAt), isNull(suplexInvitations.replacedAt))).run();
  }

  createInvitation(invitation: AuthInvitationRow): void {
    this.db.insert(suplexInvitations).values(invitation).run();
  }

  consumeInvitation(id: string, consumedAt: string): boolean {
    const result = this.db.update(suplexInvitations).set({ consumedAt }).where(and(eq(suplexInvitations.id, id), isNull(suplexInvitations.consumedAt), isNull(suplexInvitations.replacedAt))).run();
    return result.changes === 1;
  }

  findChallenge(id: string, kind: string): AuthChallengeRow | undefined {
    return this.db.select().from(suplexChallenges).where(and(eq(suplexChallenges.id, id), eq(suplexChallenges.kind, kind))).get();
  }

  createChallenge(challenge: AuthChallengeRow): void {
    this.db.insert(suplexChallenges).values(challenge).run();
  }

  consumeChallenge(id: string, consumedAt: string): boolean {
    const result = this.db.update(suplexChallenges).set({ consumedAt }).where(and(eq(suplexChallenges.id, id), isNull(suplexChallenges.consumedAt))).run();
    return result.changes === 1;
  }

  findCompany(companyId: string): AuthCompanyRow | undefined {
    return this.db.select().from(suplexCompanies).where(eq(suplexCompanies.id, companyId)).get();
  }

  listCompaniesForUser(userId: string, role: "admin" | "member"): AuthCompanyRow[] {
    if (role === "admin") return this.db.select().from(suplexCompanies).orderBy(asc(suplexCompanies.name)).all();
    return this.db.select({ id: suplexCompanies.id, name: suplexCompanies.name, status: suplexCompanies.status, issueCode: suplexCompanies.issueCode, nextIssueNumber: suplexCompanies.nextIssueNumber, createdAt: suplexCompanies.createdAt }).from(suplexCompanies).innerJoin(suplexMemberships, eq(suplexMemberships.companyId, suplexCompanies.id)).where(eq(suplexMemberships.userId, userId)).orderBy(asc(suplexCompanies.name)).all();
  }

  findCompanyForUser(userId: string, role: "admin" | "member", companyId: string): AuthCompanyRow | undefined {
    if (role === "admin") return this.findCompany(companyId);
    return this.db.select({ id: suplexCompanies.id, name: suplexCompanies.name, status: suplexCompanies.status, issueCode: suplexCompanies.issueCode, nextIssueNumber: suplexCompanies.nextIssueNumber, createdAt: suplexCompanies.createdAt }).from(suplexCompanies).innerJoin(suplexMemberships, eq(suplexMemberships.companyId, suplexCompanies.id)).where(and(eq(suplexCompanies.id, companyId), eq(suplexMemberships.userId, userId))).get();
  }

  createCompany(company: AuthCompanyRow): void {
    this.db.insert(suplexCompanies).values(company).run();
  }

  updateCompany(companyId: string, values: Partial<Pick<AuthCompanyRow, "name" | "status" | "issueCode">>): void {
    this.db.update(suplexCompanies).set(values).where(eq(suplexCompanies.id, companyId)).run();
  }

  addMembership(userId: string, companyId: string, createdAt: string): void {
    this.db.insert(suplexMemberships).values({ userId, companyId, createdAt }).run();
  }

  removeMembership(userId: string, companyId: string): boolean {
    return this.db.delete(suplexMemberships).where(and(eq(suplexMemberships.userId, userId), eq(suplexMemberships.companyId, companyId))).run().changes === 1;
  }

  listAuditEvents(): AuthAuditRow[] {
    return this.db.select().from(suplexAuditEvents).orderBy(asc(suplexAuditEvents.createdAt), asc(suplexAuditEvents.id)).all();
  }

  recordAuditEvent(event: AuthAuditRow): void {
    this.db.insert(suplexAuditEvents).values(event).run();
  }
}
