import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { forgeAuditEvents, forgeChallenges, forgeCompanies, forgeCredentials, forgeInvitations, forgeMemberships, forgeSessions, forgeUsers, type AuthSchema } from "./auth-schema.js";

export type AuthDatabase = BetterSQLite3Database<AuthSchema>;
export type AuthUserRow = typeof forgeUsers.$inferSelect;
export type AuthCredentialRow = typeof forgeCredentials.$inferSelect;
export type AuthInvitationRow = typeof forgeInvitations.$inferSelect;
export type AuthChallengeRow = typeof forgeChallenges.$inferSelect;
export type AuthCompanyRow = typeof forgeCompanies.$inferSelect;
export type AuthSessionRow = typeof forgeSessions.$inferSelect;
export type AuthAuditRow = typeof forgeAuditEvents.$inferSelect;

export type SessionUserRow = Pick<AuthUserRow, "id" | "displayName" | "username" | "role" | "status"> & { expiresAt: string };

export class AuthRepository {
  constructor(private readonly db: AuthDatabase) {}

  normalizeLegacyUsers(): void {
    this.db.update(forgeUsers).set({ username: sql`'user_v1_' || ${forgeUsers.id}`, identityVersion: 1 }).where(lt(forgeUsers.identityVersion, 1)).run();
  }

  activeAdminCount(): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(forgeUsers).where(and(eq(forgeUsers.role, "admin"), ne(forgeUsers.status, "revoked"))).get();
    return Number(row?.count ?? 0);
  }

  hasActiveAdmin(): boolean {
    return this.db.select({ id: forgeUsers.id }).from(forgeUsers).where(and(eq(forgeUsers.role, "admin"), ne(forgeUsers.status, "revoked"))).limit(1).get() !== undefined;
  }

  activeAdminIds(): string[] {
    return this.db.select({ id: forgeUsers.id }).from(forgeUsers).where(and(eq(forgeUsers.role, "admin"), eq(forgeUsers.status, "active"))).all().map((row) => row.id);
  }

  findUser(userId: string, status: "active" | "pending" | "any" = "any"): AuthUserRow | undefined {
    const query = this.db.select().from(forgeUsers).where(status === "any" ? eq(forgeUsers.id, userId) : and(eq(forgeUsers.id, userId), eq(forgeUsers.status, status)));
    return query.get();
  }

  listUsers(): AuthUserRow[] {
    return this.db.select().from(forgeUsers).orderBy(asc(forgeUsers.createdAt)).all();
  }

  createUser(user: AuthUserRow): void {
    this.db.insert(forgeUsers).values(user).run();
  }

  updateUserStatus(userId: string, status: "active" | "revoked", updatedAt: string): void {
    this.db.update(forgeUsers).set({ status, updatedAt }).where(eq(forgeUsers.id, userId)).run();
  }

  userCompanyIds(userId: string): string[] {
    return this.db.select({ companyId: forgeMemberships.companyId }).from(forgeMemberships).where(eq(forgeMemberships.userId, userId)).orderBy(asc(forgeMemberships.companyId)).all().map((row) => row.companyId);
  }

  findCredentialForAuthentication(credentialId: string): (AuthCredentialRow & { userStatus: AuthUserRow["status"] }) | undefined {
    const row = this.db.select({
      id: forgeCredentials.id,
      userId: forgeCredentials.userId,
      credentialId: forgeCredentials.credentialId,
      publicKey: forgeCredentials.publicKey,
      counter: forgeCredentials.counter,
      transports: forgeCredentials.transports,
      createdAt: forgeCredentials.createdAt,
      revokedAt: forgeCredentials.revokedAt,
      userStatus: forgeUsers.status,
    }).from(forgeCredentials).innerJoin(forgeUsers, eq(forgeUsers.id, forgeCredentials.userId)).where(and(eq(forgeCredentials.credentialId, credentialId), isNull(forgeCredentials.revokedAt), eq(forgeUsers.status, "active"))).get();
    return row;
  }

  activeCredentialOptions(): Array<Pick<AuthCredentialRow, "credentialId" | "transports">> {
    return this.db.select({ credentialId: forgeCredentials.credentialId, transports: forgeCredentials.transports }).from(forgeCredentials).innerJoin(forgeUsers, eq(forgeUsers.id, forgeCredentials.userId)).where(and(isNull(forgeCredentials.revokedAt), eq(forgeUsers.status, "active"))).orderBy(asc(forgeCredentials.createdAt)).all();
  }

  credentialsForUser(userId: string): Array<Pick<AuthCredentialRow, "credentialId" | "transports">> {
    return this.db.select({ credentialId: forgeCredentials.credentialId, transports: forgeCredentials.transports }).from(forgeCredentials).where(and(eq(forgeCredentials.userId, userId), isNull(forgeCredentials.revokedAt))).all();
  }

  listCredentials(): AuthCredentialRow[] {
    return this.db.select().from(forgeCredentials).orderBy(asc(forgeCredentials.createdAt), asc(forgeCredentials.id)).all();
  }

  findCredential(id: string): AuthCredentialRow | undefined {
    return this.db.select().from(forgeCredentials).where(eq(forgeCredentials.id, id)).get();
  }

  createCredential(credential: AuthCredentialRow): void {
    this.db.insert(forgeCredentials).values(credential).run();
  }

  updateCredentialCounter(id: string, previousCounter: number, nextCounter: number): boolean {
    const result = this.db.update(forgeCredentials).set({ counter: nextCounter }).where(and(eq(forgeCredentials.id, id), isNull(forgeCredentials.revokedAt), eq(forgeCredentials.counter, previousCounter))).run();
    return result.changes === 1;
  }

  revokeCredential(id: string, revokedAt: string): boolean {
    const result = this.db.update(forgeCredentials).set({ revokedAt }).where(and(eq(forgeCredentials.id, id), isNull(forgeCredentials.revokedAt))).run();
    return result.changes === 1;
  }

  revokeCredentialsForUsers(userIds: string[], revokedAt: string): void {
    if (userIds.length === 0) return;
    this.db.update(forgeCredentials).set({ revokedAt }).where(and(inArray(forgeCredentials.userId, userIds), isNull(forgeCredentials.revokedAt))).run();
  }

  findSessionUser(rawHash: string, now: string): SessionUserRow | undefined {
    return this.db.select({ id: forgeUsers.id, displayName: forgeUsers.displayName, username: forgeUsers.username, role: forgeUsers.role, status: forgeUsers.status, expiresAt: forgeSessions.expiresAt }).from(forgeSessions).innerJoin(forgeUsers, eq(forgeUsers.id, forgeSessions.userId)).where(and(or(eq(forgeSessions.tokenHash, rawHash), and(eq(forgeSessions.legacyTokenHash, rawHash), gt(forgeSessions.legacyTokenExpiresAt, now))), isNull(forgeSessions.revokedAt))).get();
  }

  createSession(session: AuthSessionRow): void {
    this.db.insert(forgeSessions).values(session).run();
  }

  revokeSessionByToken(rawHash: string, revokedAt: string): void {
    this.db.update(forgeSessions).set({ revokedAt }).where(and(or(eq(forgeSessions.tokenHash, rawHash), eq(forgeSessions.legacyTokenHash, rawHash)), isNull(forgeSessions.revokedAt))).run();
  }

  revokeSessionsForUsers(userIds: string[], revokedAt: string): void {
    if (userIds.length === 0) return;
    this.db.update(forgeSessions).set({ revokedAt }).where(and(inArray(forgeSessions.userId, userIds), isNull(forgeSessions.revokedAt))).run();
  }

  rolloverLegacySession(rawHash: string, replacementHash: string, legacyExpiresAt: string): boolean {
    const result = this.db.update(forgeSessions).set({ tokenHash: replacementHash, tokenVersion: 1, legacyTokenHash: rawHash, legacyTokenExpiresAt: legacyExpiresAt }).where(and(eq(forgeSessions.tokenHash, rawHash), eq(forgeSessions.tokenVersion, 0), isNull(forgeSessions.revokedAt))).run();
    return result.changes === 1;
  }

  findInvitation(tokenHash: string, kind: "bootstrap" | "user" | "recovery"): AuthInvitationRow | undefined {
    return this.db.select().from(forgeInvitations).where(and(eq(forgeInvitations.tokenHash, tokenHash), eq(forgeInvitations.kind, kind))).get();
  }

  listInvitations(): AuthInvitationRow[] {
    return this.db.select().from(forgeInvitations).orderBy(desc(forgeInvitations.createdAt), desc(forgeInvitations.id)).all();
  }

  replaceInvitations(kind: "bootstrap" | "recovery", replacedAt: string): void {
    this.db.update(forgeInvitations).set({ replacedAt }).where(and(eq(forgeInvitations.kind, kind), isNull(forgeInvitations.consumedAt), isNull(forgeInvitations.replacedAt))).run();
  }

  createInvitation(invitation: AuthInvitationRow): void {
    this.db.insert(forgeInvitations).values(invitation).run();
  }

  consumeInvitation(id: string, consumedAt: string): boolean {
    const result = this.db.update(forgeInvitations).set({ consumedAt }).where(and(eq(forgeInvitations.id, id), isNull(forgeInvitations.consumedAt), isNull(forgeInvitations.replacedAt))).run();
    return result.changes === 1;
  }

  findChallenge(id: string, kind: string): AuthChallengeRow | undefined {
    return this.db.select().from(forgeChallenges).where(and(eq(forgeChallenges.id, id), eq(forgeChallenges.kind, kind))).get();
  }

  createChallenge(challenge: AuthChallengeRow): void {
    this.db.insert(forgeChallenges).values(challenge).run();
  }

  consumeChallenge(id: string, consumedAt: string): boolean {
    const result = this.db.update(forgeChallenges).set({ consumedAt }).where(and(eq(forgeChallenges.id, id), isNull(forgeChallenges.consumedAt))).run();
    return result.changes === 1;
  }

  findCompany(companyId: string): AuthCompanyRow | undefined {
    return this.db.select().from(forgeCompanies).where(eq(forgeCompanies.id, companyId)).get();
  }

  listCompaniesForUser(userId: string, role: "admin" | "member"): AuthCompanyRow[] {
    if (role === "admin") return this.db.select().from(forgeCompanies).orderBy(asc(forgeCompanies.name)).all();
    return this.db.select({ id: forgeCompanies.id, name: forgeCompanies.name, status: forgeCompanies.status, issueCode: forgeCompanies.issueCode, nextIssueNumber: forgeCompanies.nextIssueNumber, createdAt: forgeCompanies.createdAt }).from(forgeCompanies).innerJoin(forgeMemberships, eq(forgeMemberships.companyId, forgeCompanies.id)).where(eq(forgeMemberships.userId, userId)).orderBy(asc(forgeCompanies.name)).all();
  }

  findCompanyForUser(userId: string, role: "admin" | "member", companyId: string): AuthCompanyRow | undefined {
    if (role === "admin") return this.findCompany(companyId);
    return this.db.select({ id: forgeCompanies.id, name: forgeCompanies.name, status: forgeCompanies.status, issueCode: forgeCompanies.issueCode, nextIssueNumber: forgeCompanies.nextIssueNumber, createdAt: forgeCompanies.createdAt }).from(forgeCompanies).innerJoin(forgeMemberships, eq(forgeMemberships.companyId, forgeCompanies.id)).where(and(eq(forgeCompanies.id, companyId), eq(forgeMemberships.userId, userId))).get();
  }

  createCompany(company: AuthCompanyRow): void {
    this.db.insert(forgeCompanies).values(company).run();
  }

  updateCompany(companyId: string, values: Partial<Pick<AuthCompanyRow, "name" | "status" | "issueCode">>): void {
    this.db.update(forgeCompanies).set(values).where(eq(forgeCompanies.id, companyId)).run();
  }

  addMembership(userId: string, companyId: string, createdAt: string): void {
    this.db.insert(forgeMemberships).values({ userId, companyId, createdAt }).run();
  }

  removeMembership(userId: string, companyId: string): boolean {
    return this.db.delete(forgeMemberships).where(and(eq(forgeMemberships.userId, userId), eq(forgeMemberships.companyId, companyId))).run().changes === 1;
  }

  listAuditEvents(): AuthAuditRow[] {
    return this.db.select().from(forgeAuditEvents).orderBy(asc(forgeAuditEvents.createdAt), asc(forgeAuditEvents.id)).all();
  }

  recordAuditEvent(event: AuthAuditRow): void {
    this.db.insert(forgeAuditEvents).values(event).run();
  }
}
