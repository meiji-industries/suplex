import { createHash, randomBytes } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import type { AuthService } from "./auth.js";
import type { ForgeDatabase } from "../platform/database.js";
import type { AgentApiAdminAgent, AgentApiPublicAgent } from "../http/contracts/agent-api.js";

const nameSchema = z.string().trim().min(1).max(80);
const idSchema = z.string().min(1).max(128);
const profileIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const pairingCodePattern = /^fhp_[A-Za-z0-9_-]{43}$/;
const credentialPattern = /^fha_[A-Za-z0-9_-]{43}$/;

export class ExternalAgentFailure extends Error {
  constructor(readonly publicMessage: string, readonly statusCode = 400, readonly code = "external_agent_failure") {
    super(publicMessage);
    this.name = "ExternalAgentFailure";
  }
}

export type { AgentApiAdminAgent, AgentApiPublicAgent };
export type ExternalAgentRecord = AgentApiPublicAgent;

export interface ExternalAgentPrincipal {
  agentId: string;
  companyId: string;
  profileId: string | null;
  projectIds: string[];
  cursorKey: string;
}

interface AgentQueryRow {
  id: string;
  name: string;
  avatar_seed: string;
  company_id: string;
  client_profile_id: string | null;
  status: "pending" | "paired" | "revoked";
  pairing_expires_at: string | null;
  paired_at: string | null;
  credential_created_at: string | null;
  connection_kind: "oauth" | "credential";
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PairingRow {
  id: string;
  agent_id: string;
  purpose: "initial" | "rotation";
  expires_at: string;
  consumed_at: string | null;
  replaced_at: string | null;
}

interface ExternalAgentServiceOptions {
  now?: () => Date;
  pairingTtlMs?: number;
}

const identifier = (prefix: string): string => `${prefix}_${randomBytes(16).toString("hex")}`;
const secret = (prefix: "fhp" | "fha"): string => `${prefix}_${randomBytes(32).toString("base64url")}`;
const hashSecret = (value: string): string => createHash("sha256").update(value).digest("hex");
const pairingFailure = (): ExternalAgentFailure => new ExternalAgentFailure("Pairing failed", 401, "pairing_invalid");
const authenticationFailure = (): ExternalAgentFailure => new ExternalAgentFailure("Authentication failed", 401, "credential_invalid");
const isSqliteConstraint = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT"));

export class ExternalAgentService {
  private readonly now: () => Date;
  private readonly pairingTtlMs: number;

  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, options: ExternalAgentServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
  }

  create(actorUserId: string, input: { name: string; companyId: string; projectIds: string[]; avatarSeed?: string | undefined }): { agent: AgentApiAdminAgent; pairingCode: string; expiresAt: string } {
    this.requireAdmin(actorUserId);
    const name = nameSchema.safeParse(input.name);
    const companyId = idSchema.safeParse(input.companyId);
    const projectIds = [...new Set(input.projectIds)].sort();
    if (!name.success || !companyId.success || projectIds.length === 0 || projectIds.some((projectId) => !idSchema.safeParse(projectId).success)) {
      throw new ExternalAgentFailure("External agent configuration is invalid", 400, "configuration_invalid");
    }
    const rawCode = secret("fhp");
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.pairingTtlMs).toISOString();
    const agentId = identifier("agent");
    const avatarSeed = input.avatarSeed?.trim() || randomBytes(16).toString("hex");
    if (avatarSeed.length > 128) throw new ExternalAgentFailure("External agent configuration is invalid", 400, "configuration_invalid");

    try {
      this.database.authTransaction((db) => {
        const company = db.prepare("SELECT id FROM forge_companies WHERE id = ?").get(companyId.data) as { id: string } | undefined;
        const projects = db.prepare(`SELECT id FROM forge_projects WHERE company_id = ? AND id IN (${projectIds.map(() => "?").join(",")})`).all(companyId.data, ...projectIds) as Array<{ id: string }>;
        if (!company || projects.length !== projectIds.length) throw new ExternalAgentFailure("Not found", 404, "scope_not_found");
        if (db.prepare("SELECT 1 FROM forge_agents WHERE name = ?").get(name.data)) throw new ExternalAgentFailure("An agent with this name already exists", 409, "configuration_conflict");
        db.prepare("INSERT INTO forge_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES (?, 'external', ?, ?, ?, ?)").run(agentId, name.data, avatarSeed, nowIso, nowIso);
        db.prepare("INSERT INTO forge_external_agents (id, company_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)").run(agentId, companyId.data, nowIso, nowIso);
        const grant = db.prepare("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?, ?, ?, ?)");
        for (const projectId of projectIds) grant.run(agentId, companyId.data, projectId, nowIso);
        db.prepare("INSERT INTO forge_external_agent_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, 'initial', ?, ?)").run(identifier("pairing"), agentId, hashSecret(rawCode), expiresAt, nowIso);
        this.auth.recordAuditEventInTransaction(db, actorUserId, "external_agent_created", undefined, companyId.data, { agentId });
        this.auth.recordAuditEventInTransaction(db, actorUserId, "external_agent_pairing_issued", undefined, companyId.data, { agentId, purpose: "initial" });
      });
    } catch (error) {
      if (error instanceof ExternalAgentFailure) throw error;
      if (isSqliteConstraint(error)) throw new ExternalAgentFailure("External agent configuration is invalid", 409, "configuration_conflict");
      throw error;
    }
    return { agent: this.getAdminAgent(agentId), pairingCode: rawCode, expiresAt };
  }

  list(actorUserId: string, companyId?: string): AgentApiAdminAgent[] {
    this.requireAdmin(actorUserId);
    if (companyId) this.auth.requireCompanyAccess(actorUserId, companyId);
    return this.database.authQuery((db) => {
      const condition = companyId ? "WHERE e.company_id = ?" : "";
      const params = companyId ? [companyId] : [];
      const rows = db.prepare(`
        SELECT e.id, ag.name, ag.avatar_seed, e.company_id, e.client_profile_id, e.status,
               (SELECT p.expires_at FROM forge_external_agent_pairing_codes p WHERE p.agent_id = e.id AND p.consumed_at IS NULL AND p.replaced_at IS NULL ORDER BY p.created_at DESC LIMIT 1) AS pairing_expires_at,
               e.paired_at,
               (SELECT c.created_at FROM forge_external_agent_credentials c WHERE c.agent_id = e.id AND c.revoked_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS credential_created_at,
               CASE WHEN EXISTS (SELECT 1 FROM forge_oauth_grants og WHERE og.agent_id = e.id) THEN 'oauth' ELSE 'credential' END AS connection_kind,
               e.last_used_at, e.revoked_at, e.created_at, e.updated_at
        FROM forge_external_agents e
        JOIN forge_agents ag ON ag.id = e.id
        ${condition}
        ORDER BY e.created_at DESC, e.id
      `).all(...params) as AgentQueryRow[];

      const grants = db.prepare("SELECT agent_id, project_id FROM forge_external_agent_project_grants ORDER BY project_id").all() as Array<{ agent_id: string; project_id: string }>;
      const grantMap = new Map<string, string[]>();
      for (const g of grants) {
        const list = grantMap.get(g.agent_id) ?? [];
        list.push(g.project_id);
        grantMap.set(g.agent_id, list);
      }

      return rows.map((row) => this.toAdminAgent(row, grantMap.get(row.id) ?? []));
    });
  }

  replaceProjects(actorUserId: string, agentId: string, projectIds: string[]): AgentApiAdminAgent {
    this.requireAdmin(actorUserId);
    if (!idSchema.safeParse(agentId).success) throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
    const uniqueProjectIds = [...new Set(projectIds)].sort();
    if (uniqueProjectIds.some((id) => !idSchema.safeParse(id).success)) {
      throw new ExternalAgentFailure("Project list is invalid", 400, "configuration_invalid");
    }
    const nowIso = this.now().toISOString();

    this.database.authTransaction((db) => {
      const agent = db.prepare("SELECT company_id, status FROM forge_external_agents WHERE id = ?").get(agentId) as { company_id: string; status: string } | undefined;
      if (!agent || agent.status === "revoked") throw new ExternalAgentFailure("Not found", 404, "agent_not_found");

      if (uniqueProjectIds.length > 0) {
        const matchingProjects = db.prepare(`SELECT id FROM forge_projects WHERE company_id = ? AND id IN (${uniqueProjectIds.map(() => "?").join(",")})`).all(agent.company_id, ...uniqueProjectIds) as Array<{ id: string }>;
        if (matchingProjects.length !== uniqueProjectIds.length) {
          throw new ExternalAgentFailure("Not found", 404, "scope_not_found");
        }
      }

      const existingGrants = (db.prepare("SELECT project_id FROM forge_external_agent_project_grants WHERE agent_id = ?").all(agentId) as Array<{ project_id: string }>).map((g) => g.project_id);
      const existingSet = new Set(existingGrants);
      const newSet = new Set(uniqueProjectIds);
      const addedProjects = uniqueProjectIds.filter((p) => !existingSet.has(p));
      const removedProjects = existingGrants.filter((p) => !newSet.has(p));

      db.prepare("DELETE FROM forge_external_agent_project_grants WHERE agent_id = ?").run(agentId);
      const insert = db.prepare("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?, ?, ?, ?)");
      for (const projectId of uniqueProjectIds) {
        insert.run(agentId, agent.company_id, projectId, nowIso);
      }
      db.prepare("UPDATE forge_external_agents SET updated_at = ? WHERE id = ?").run(nowIso, agentId);

      this.auth.recordAuditEventInTransaction(db, actorUserId, "external_agent_scope_updated", undefined, agent.company_id, {
        agentId,
        addedProjects: JSON.stringify(addedProjects),
        removedProjects: JSON.stringify(removedProjects),
      });
    });

    return this.getAdminAgent(agentId);
  }

  issueInitialPairing(actorUserId: string, agentId: string): { pairingCode: string; expiresAt: string } {
    this.requireAdmin(actorUserId);
    if (!idSchema.safeParse(agentId).success) throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
    const rawCode = secret("fhp");
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.pairingTtlMs).toISOString();

    this.database.authTransaction((db) => {
      const agent = db.prepare("SELECT company_id, status FROM forge_external_agents WHERE id = ?").get(agentId) as { company_id: string; status: string } | undefined;
      if (!agent || agent.status !== "pending") throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
      db.prepare("UPDATE forge_external_agent_pairing_codes SET replaced_at = ? WHERE agent_id = ? AND consumed_at IS NULL AND replaced_at IS NULL").run(nowIso, agentId);
      db.prepare("INSERT INTO forge_external_agent_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, 'initial', ?, ?)").run(identifier("pairing"), agentId, hashSecret(rawCode), expiresAt, nowIso);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "external_agent_pairing_issued", undefined, agent.company_id, { agentId, purpose: "initial" });
    });
    return { pairingCode: rawCode, expiresAt };
  }

  rotate(actorUserId: string, agentId: string): { pairingCode: string; expiresAt: string } {
    this.requireAdmin(actorUserId);
    if (!idSchema.safeParse(agentId).success) throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
    const rawCode = secret("fhp");
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.pairingTtlMs).toISOString();
    this.database.authTransaction((db) => {
      const agent = db.prepare("SELECT company_id, status FROM forge_external_agents WHERE id = ?").get(agentId) as { company_id: string; status: string } | undefined;
      if (!agent || agent.status !== "paired") throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
      db.prepare("UPDATE forge_external_agent_pairing_codes SET replaced_at = ? WHERE agent_id = ? AND consumed_at IS NULL AND replaced_at IS NULL").run(nowIso, agentId);
      db.prepare("INSERT INTO forge_external_agent_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, 'rotation', ?, ?)").run(identifier("pairing"), agentId, hashSecret(rawCode), expiresAt, nowIso);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "external_agent_pairing_issued", undefined, agent.company_id, { agentId, purpose: "rotation" });
    });
    return { pairingCode: rawCode, expiresAt };
  }

  exchange(input: { pairingCode: string; profileId?: string | undefined }): { agent: AgentApiPublicAgent; credential: string } {
    if (!pairingCodePattern.test(input.pairingCode)) throw pairingFailure();
    const parsedProfileId = input.profileId === undefined ? null : profileIdSchema.safeParse(input.profileId);
    if (parsedProfileId !== null && !parsedProfileId.success) throw pairingFailure();
    const profileId = parsedProfileId === null ? null : parsedProfileId.data;
    const rawCredential = secret("fha");
    const nowIso = this.now().toISOString();
    let agentId = "";
    try {
      this.database.authTransaction((db) => {
        const pairing = db.prepare("SELECT id, agent_id, purpose, expires_at, consumed_at, replaced_at FROM forge_external_agent_pairing_codes WHERE code_hash = ?").get(hashSecret(input.pairingCode)) as PairingRow | undefined;
        if (!pairing || pairing.consumed_at || pairing.replaced_at || Date.parse(pairing.expires_at) <= this.now().getTime()) throw pairingFailure();
        const agent = db.prepare("SELECT e.*, ag.name, ag.avatar_seed FROM forge_external_agents e JOIN forge_agents ag ON ag.id = e.id WHERE e.id = ?").get(pairing.agent_id) as (AgentQueryRow) | undefined;
        if (!agent || agent.status === "revoked" || (pairing.purpose === "rotation" && agent.status !== "paired")) throw pairingFailure();
        if (db.prepare("UPDATE forge_external_agent_pairing_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND replaced_at IS NULL").run(nowIso, pairing.id).changes !== 1) throw pairingFailure();
        if (pairing.purpose === "rotation") db.prepare("UPDATE forge_external_agent_credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(nowIso, agent.id);
        db.prepare("INSERT INTO forge_external_agent_credentials (id, agent_id, credential_hash, created_at) VALUES (?, ?, ?, ?)").run(identifier("agent_credential"), agent.id, hashSecret(rawCredential), nowIso);
        db.prepare("UPDATE forge_external_agents SET client_profile_id = ?, status = 'paired', paired_at = COALESCE(paired_at, ?), revoked_at = NULL, updated_at = ? WHERE id = ?").run(profileId, nowIso, nowIso, agent.id);
        this.auth.recordAgentAuditEventInTransaction(db, agent.id, pairing.purpose === "rotation" ? "external_agent_rotated" : "external_agent_paired", undefined, agent.company_id, { ...(profileId === null ? {} : { profileId }) });
        agentId = agent.id;
      });
    } catch (error) {
      if (error instanceof ExternalAgentFailure) throw error;
      throw pairingFailure();
    }
    return { agent: this.getPublicAgent(agentId), credential: rawCredential };
  }

  authenticate(rawCredential: string): ExternalAgentPrincipal {
    if (!credentialPattern.test(rawCredential)) throw authenticationFailure();
    const nowIso = this.now().toISOString();
    return this.database.authTransaction((db) => {
      const row = db.prepare(`SELECT c.id AS credential_id, c.credential_hash, a.id AS agent_id, a.company_id, a.client_profile_id
        FROM forge_external_agent_credentials c JOIN forge_external_agents a ON a.id = c.agent_id
        WHERE c.credential_hash = ? AND c.revoked_at IS NULL AND a.status = 'paired' AND a.revoked_at IS NULL`).get(hashSecret(rawCredential)) as { credential_id: string; credential_hash: string; agent_id: string; company_id: string; client_profile_id: string | null } | undefined;
      if (!row) throw authenticationFailure();
      const projectIds = (db.prepare("SELECT project_id FROM forge_external_agent_project_grants WHERE agent_id = ? ORDER BY project_id").all(row.agent_id) as Array<{ project_id: string }>).map(({ project_id }) => project_id);
      db.prepare("UPDATE forge_external_agent_credentials SET last_used_at = ? WHERE id = ?").run(nowIso, row.credential_id);
      db.prepare("UPDATE forge_external_agents SET last_used_at = ?, updated_at = ? WHERE id = ?").run(nowIso, nowIso, row.agent_id);
      return { agentId: row.agent_id, companyId: row.company_id, profileId: row.client_profile_id, projectIds, cursorKey: row.credential_hash };
    });
  }

  provisionOAuthAgentInTransaction(db: Database.Database, input: { actorUserId: string; clientId: string; clientName: string; companyId: string; projectIds: string[]; cursorKey: string }): ExternalAgentPrincipal {
    this.requireAdmin(input.actorUserId);
    this.auth.requireCompanyAccess(input.actorUserId, input.companyId);
    const projectIds = [...new Set(input.projectIds)].sort();
    if (projectIds.length === 0 || projectIds.some((projectId) => !idSchema.safeParse(projectId).success)) {
      throw new ExternalAgentFailure("Select at least one project", 400, "configuration_invalid");
    }
    const matching = db.prepare(`SELECT id FROM forge_projects WHERE company_id = ? AND id IN (${projectIds.map(() => "?").join(",")})`).all(input.companyId, ...projectIds) as Array<{ id: string }>;
    if (matching.length !== projectIds.length) throw new ExternalAgentFailure("Not found", 404, "scope_not_found");

    const nowIso = this.now().toISOString();
    const agentId = identifier("agent");
    const suffix = input.clientId.slice(-8);
    const base = input.clientName.trim().slice(0, 60) || "OAuth client";
    let name = `${base} (${suffix})`.slice(0, 80);
    let collision = 1;
    while (db.prepare("SELECT 1 FROM forge_agents WHERE name = ?").get(name)) {
      collision += 1;
      name = `${base.slice(0, 68)} (${suffix}-${collision})`.slice(0, 80);
    }
    db.prepare("INSERT INTO forge_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES (?, 'external', ?, ?, ?, ?)").run(agentId, name, randomBytes(16).toString("hex"), nowIso, nowIso);
    db.prepare("INSERT INTO forge_external_agents (id, company_id, status, paired_at, created_at, updated_at) VALUES (?, ?, 'paired', ?, ?, ?)").run(agentId, input.companyId, nowIso, nowIso, nowIso);
    const grant = db.prepare("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?, ?, ?, ?)");
    for (const projectId of projectIds) grant.run(agentId, input.companyId, projectId, nowIso);
    this.auth.recordAuditEventInTransaction(db, input.actorUserId, "external_agent_oauth_authorized", undefined, input.companyId, { agentId, clientId: input.clientId });
    return { agentId, companyId: input.companyId, profileId: null, projectIds, cursorKey: input.cursorKey };
  }

  oauthPrincipal(agentId: string, cursorKey: string): ExternalAgentPrincipal {
    const nowIso = this.now().toISOString();
    return this.database.authTransaction((db) => {
      const row = db.prepare("SELECT id, company_id, client_profile_id FROM forge_external_agents WHERE id = ? AND status = 'paired' AND revoked_at IS NULL").get(agentId) as { id: string; company_id: string; client_profile_id: string | null } | undefined;
      if (!row) throw authenticationFailure();
      const projectIds = (db.prepare("SELECT project_id FROM forge_external_agent_project_grants WHERE agent_id = ? ORDER BY project_id").all(agentId) as Array<{ project_id: string }>).map(({ project_id }) => project_id);
      db.prepare("UPDATE forge_external_agents SET last_used_at = ?, updated_at = ? WHERE id = ?").run(nowIso, nowIso, agentId);
      return { agentId, companyId: row.company_id, profileId: row.client_profile_id, projectIds, cursorKey };
    });
  }

  assertOAuthAgentActive(agentId: string): void {
    const active = this.database.authQuery((db) => db.prepare("SELECT 1 FROM forge_external_agents WHERE id = ? AND status = 'paired' AND revoked_at IS NULL").get(agentId));
    if (!active) throw authenticationFailure();
  }

  revoke(actorUserId: string, agentId: string): void {
    this.requireAdmin(actorUserId);
    const nowIso = this.now().toISOString();
    this.database.authTransaction((db) => {
      const agent = db.prepare("SELECT company_id, status FROM forge_external_agents WHERE id = ?").get(agentId) as { company_id: string; status: string } | undefined;
      if (!agent || agent.status === "revoked") throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
      db.prepare("UPDATE forge_external_agents SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?").run(nowIso, nowIso, agentId);
      db.prepare("UPDATE forge_external_agent_credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(nowIso, agentId);
      db.prepare("UPDATE forge_external_agent_pairing_codes SET replaced_at = ? WHERE agent_id = ? AND consumed_at IS NULL AND replaced_at IS NULL").run(nowIso, agentId);
      db.prepare("UPDATE forge_oauth_grants SET revoked_at = ?, updated_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(nowIso, nowIso, agentId);
      db.prepare("UPDATE forge_oauth_token_families SET revoked_at = ? WHERE grant_id IN (SELECT id FROM forge_oauth_grants WHERE agent_id = ?) AND revoked_at IS NULL").run(nowIso, agentId);
      db.prepare("UPDATE forge_oauth_access_tokens SET revoked_at = ? WHERE family_id IN (SELECT id FROM forge_oauth_token_families WHERE grant_id IN (SELECT id FROM forge_oauth_grants WHERE agent_id = ?)) AND revoked_at IS NULL").run(nowIso, agentId);
      db.prepare("UPDATE forge_oauth_authorization_codes SET consumed_at = ? WHERE grant_id IN (SELECT id FROM forge_oauth_grants WHERE agent_id = ?) AND consumed_at IS NULL").run(nowIso, agentId);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "external_agent_revoked", undefined, agent.company_id, { agentId });
    });
  }

  getAdminAgent(agentId: string): AgentApiAdminAgent {
    return this.database.authQuery((db) => {
      const row = db.prepare(`
        SELECT e.id, ag.name, ag.avatar_seed, e.company_id, e.client_profile_id, e.status,
               (SELECT p.expires_at FROM forge_external_agent_pairing_codes p WHERE p.agent_id = e.id AND p.consumed_at IS NULL AND p.replaced_at IS NULL ORDER BY p.created_at DESC LIMIT 1) AS pairing_expires_at,
               e.paired_at,
               (SELECT c.created_at FROM forge_external_agent_credentials c WHERE c.agent_id = e.id AND c.revoked_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS credential_created_at,
               CASE WHEN EXISTS (SELECT 1 FROM forge_oauth_grants og WHERE og.agent_id = e.id) THEN 'oauth' ELSE 'credential' END AS connection_kind,
               e.last_used_at, e.revoked_at, e.created_at, e.updated_at
        FROM forge_external_agents e
        JOIN forge_agents ag ON ag.id = e.id
        WHERE e.id = ?
      `).get(agentId) as AgentQueryRow | undefined;
      if (!row) throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
      const projectIds = (db.prepare("SELECT project_id FROM forge_external_agent_project_grants WHERE agent_id = ? ORDER BY project_id").all(agentId) as Array<{ project_id: string }>).map(({ project_id }) => project_id);
      return this.toAdminAgent(row, projectIds);
    });
  }

  getPublicAgent(agentId: string): AgentApiPublicAgent {
    return this.database.authQuery((db) => {
      const row = db.prepare(`
        SELECT e.id, ag.name, ag.avatar_seed, e.company_id, e.client_profile_id, e.status,
               NULL AS pairing_expires_at,
               e.paired_at,
               NULL AS credential_created_at,
               CASE WHEN EXISTS (SELECT 1 FROM forge_oauth_grants og WHERE og.agent_id = e.id) THEN 'oauth' ELSE 'credential' END AS connection_kind,
               e.last_used_at, e.revoked_at, e.created_at, e.updated_at
        FROM forge_external_agents e
        JOIN forge_agents ag ON ag.id = e.id
        WHERE e.id = ?
      `).get(agentId) as AgentQueryRow | undefined;
      if (!row) throw new ExternalAgentFailure("Not found", 404, "agent_not_found");
      const projectIds = (db.prepare("SELECT project_id FROM forge_external_agent_project_grants WHERE agent_id = ? ORDER BY project_id").all(agentId) as Array<{ project_id: string }>).map(({ project_id }) => project_id);
      return {
        id: row.id,
        kind: "external",
        name: row.name,
        avatarSeed: row.avatar_seed,
        companyId: row.company_id,
        profileId: row.client_profile_id,
        status: row.status,
        projectIds,
        pairedAt: row.paired_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  get(agentId: string): AgentApiPublicAgent {
    return this.getPublicAgent(agentId);
  }

  private requireAdmin(userId: string): void {
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new ExternalAgentFailure("Authentication required", 401, "authentication_required");
    if (user.role !== "admin") throw new ExternalAgentFailure("Not found", 404, "not_found");
  }

  private toAdminAgent(row: AgentQueryRow, projectIds: string[]): AgentApiAdminAgent {
    return {
      id: row.id,
      kind: "external",
      name: row.name,
      avatarSeed: row.avatar_seed,
      companyId: row.company_id,
      clientProfileId: row.client_profile_id,
      status: row.status,
      projectIds,
      pairingExpiresAt: row.pairing_expires_at,
      pairedAt: row.paired_at,
      credentialCreatedAt: row.credential_created_at,
      connectionKind: row.connection_kind,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
