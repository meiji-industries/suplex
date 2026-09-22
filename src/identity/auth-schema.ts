import { blob, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const suplexUsers = sqliteTable("suplex_users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  username: text("username").notNull(),
  avatarSeed: text("avatar_seed").notNull().default(""),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  status: text("status", { enum: ["pending", "active", "revoked"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  identityVersion: integer("identity_version").notNull(),
});

export const suplexCredentials = sqliteTable("suplex_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  credentialId: text("credential_id").notNull(),
  publicKey: blob("public_key", { mode: "buffer" }).notNull(),
  counter: integer("counter").notNull(),
  transports: text("transports").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => ({ credentialIdUnique: unique("suplex_credentials_credential_id_unique").on(table.credentialId) }));

export const suplexSessions = sqliteTable("suplex_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
  tokenVersion: integer("token_version").notNull(),
  legacyTokenHash: text("legacy_token_hash"),
  legacyTokenExpiresAt: text("legacy_token_expires_at"),
});

export const suplexInvitations = sqliteTable("suplex_invitations", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  kind: text("kind", { enum: ["bootstrap", "user", "recovery"] }).notNull(),
  displayName: text("display_name").notNull(),
  userId: text("user_id"),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  replacedAt: text("replaced_at"),
  createdAt: text("created_at").notNull(),
  metadataJson: text("metadata_json").notNull(),
});

export const suplexChallenges = sqliteTable("suplex_challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  kind: text("kind").notNull(),
  invitationId: text("invitation_id"),
  userId: text("user_id"),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  createdAt: text("created_at").notNull(),
});

export const suplexCompanies = sqliteTable("suplex_companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "paused", "archived"] }).notNull(),
  issueCode: text("issue_code"),
  nextIssueNumber: integer("next_issue_number").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

export const suplexMemberships = sqliteTable("suplex_memberships", {
  userId: text("user_id").notNull(),
  companyId: text("company_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({ membershipPrimaryKey: primaryKey({ columns: [table.userId, table.companyId] }) }));

export const suplexAuditEvents = sqliteTable("suplex_audit_events", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id"),
  actorAgentId: text("actor_agent_id"),
  action: text("action").notNull(),
  targetUserId: text("target_user_id"),
  companyId: text("company_id"),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const authSchema = {
  suplexUsers,
  suplexCredentials,
  suplexSessions,
  suplexInvitations,
  suplexChallenges,
  suplexCompanies,
  suplexMemberships,
  suplexAuditEvents,
};

export type AuthSchema = typeof authSchema;
