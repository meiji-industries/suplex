import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";
import type Database from "better-sqlite3";

import type { AuthService } from "./auth.js";
import { ExternalAgentFailure, type ExternalAgentPrincipal, type ExternalAgentService } from "./external-agents.js";
import type { ForgeDatabase } from "../platform/database.js";

const clientIdSchema = z.string().min(1).max(128);
const boundedText = z.string().min(1).max(2_048);
const stateSchema = z.string().max(2_048).optional();
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifierSchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/);
const scopes = "forge:mcp";

interface ClientRow {
  id: string;
  client_name: string;
  redirect_uris_json: string;
}

interface PendingRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  scope: string;
  resource: string;
  code_challenge: string;
  expires_at: string;
  consumed_at: string | null;
  client_name: string;
}

interface GrantRow {
  id: string;
  client_id: string;
  user_id: string;
  company_id: string;
  agent_id: string;
  resource: string;
  cursor_key: string;
  revoked_at: string | null;
}

interface TokenRow extends GrantRow {
  family_id: string;
  token_id: string;
  expires_at: string;
  family_revoked_at: string | null;
}

export class OAuthFailure extends Error {
  constructor(readonly error: string, readonly publicMessage: string, readonly statusCode = 400, readonly redirectUri?: string, readonly state?: string) {
    super(publicMessage);
    this.name = "OAuthFailure";
  }
}

export interface OAuthClientMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface OAuthServiceOptions {
  now?: () => Date;
  authorizationTtlMs?: number;
  codeTtlMs?: number;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
}

const identifier = (prefix: string): string => `${prefix}_${randomBytes(16).toString("hex")}`;
const rawSecret = (prefix: "foc" | "foa" | "for"): string => `${prefix}_${randomBytes(32).toString("base64url")}`;
const hashSecret = (value: string): string => createHash("sha256").update(value).digest("hex");
const pkceChallenge = (value: string): string => createHash("sha256").update(value).digest("base64url");
const parseStringArray = (value: string): string[] => {
  const parsed: unknown = JSON.parse(value);
  return z.array(z.string()).parse(parsed);
};

function validRedirectUri(value: string): boolean {
  if (value.length > 2_048 || value.includes("*")) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export class OAuthService {
  private readonly now: () => Date;
  private readonly authorizationTtlMs: number;
  private readonly codeTtlMs: number;
  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  readonly issuer: string;
  readonly resource: string;
  readonly available: boolean;

  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly externalAgent: ExternalAgentService, reachableAddress: string, options: OAuthServiceOptions = {}) {
    const canonical = new URL(reachableAddress);
    this.issuer = canonical.origin;
    this.resource = `${canonical.origin}/mcp`;
    this.available = canonical.protocol === "https:" || (canonical.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(canonical.hostname));
    this.now = options.now ?? (() => new Date());
    this.authorizationTtlMs = options.authorizationTtlMs ?? 10 * 60_000;
    this.codeTtlMs = options.codeTtlMs ?? 5 * 60_000;
    this.accessTokenTtlMs = options.accessTokenTtlMs ?? 60 * 60_000;
    this.refreshTokenTtlMs = options.refreshTokenTtlMs ?? 30 * 24 * 60 * 60_000;
  }

  registerClient(metadata: OAuthClientMetadata): OAuthClientMetadata & { client_id: string; client_id_issued_at: number } {
    if (!this.available) throw new OAuthFailure("invalid_request", "Forge OAuth requires an HTTPS reachable address", 400);
    const name = z.string().trim().min(1).max(120).safeParse(metadata.client_name);
    const redirectUris = z.array(z.string()).min(1).max(10).safeParse(metadata.redirect_uris);
    const grantTypes = metadata.grant_types ?? ["authorization_code", "refresh_token"];
    const responseTypes = metadata.response_types ?? ["code"];
    const authMethod = metadata.token_endpoint_auth_method ?? "none";
    if (!name.success || !redirectUris.success || redirectUris.data.some((uri) => !validRedirectUri(uri)) || grantTypes.some((value) => !["authorization_code", "refresh_token"].includes(value)) || responseTypes.length !== 1 || responseTypes[0] !== "code" || authMethod !== "none") {
      throw new OAuthFailure("invalid_client_metadata", "Client metadata is invalid", 400);
    }
    const uniqueRedirects = [...new Set(redirectUris.data)];
    const clientId = identifier("oauth_client");
    const now = this.now();
    this.database.authTransaction((db) => {
      db.prepare("DELETE FROM forge_oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM forge_oauth_grants g WHERE g.client_id = forge_oauth_clients.id) AND NOT EXISTS (SELECT 1 FROM forge_oauth_pending_authorizations p WHERE p.client_id = forge_oauth_clients.id AND p.expires_at > ?)").run(new Date(now.getTime() - 24 * 60 * 60_000).toISOString(), now.toISOString());
      const clients = db.prepare("SELECT COUNT(*) AS count FROM forge_oauth_clients").get() as { count: number };
      if (clients.count >= 1_000) throw new OAuthFailure("temporarily_unavailable", "Client registration limit reached", 429);
      db.prepare("INSERT INTO forge_oauth_clients (id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'none', ?, ?)").run(clientId, name.data, JSON.stringify(uniqueRedirects), JSON.stringify(grantTypes), JSON.stringify(responseTypes), now.toISOString(), now.toISOString());
    });
    return { client_id: clientId, client_id_issued_at: Math.floor(now.getTime() / 1_000), client_name: name.data, redirect_uris: uniqueRedirects, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: "none" };
  }

  beginAuthorization(input: { clientId: string; redirectUri: string; responseType: string; state?: string; scope?: string; resource: string; codeChallenge: string; codeChallengeMethod: string }): { requestId: string } {
    if (!this.available) throw new OAuthFailure("invalid_request", "Forge OAuth requires an HTTPS reachable address", 400);
    if (!clientIdSchema.safeParse(input.clientId).success || !boundedText.safeParse(input.redirectUri).success) throw new OAuthFailure("invalid_request", "Authorization request is invalid", 400);
    const client = this.database.authQuery((db) => db.prepare("SELECT id, client_name, redirect_uris_json FROM forge_oauth_clients WHERE id = ?").get(input.clientId) as ClientRow | undefined);
    if (!client || !parseStringArray(client.redirect_uris_json).includes(input.redirectUri)) throw new OAuthFailure("invalid_request", "Client or redirect URI is invalid", 400);
    const fail = (error: string, message: string): never => { throw new OAuthFailure(error, message, 400, input.redirectUri, input.state); };
    if (input.responseType !== "code") fail("unsupported_response_type", "Response type is not supported");
    if (!stateSchema.safeParse(input.state).success || input.scope !== scopes || input.resource !== this.resource || input.codeChallengeMethod !== "S256" || !challengeSchema.safeParse(input.codeChallenge).success) fail("invalid_request", "Authorization request is invalid");
    const requestId = identifier("oauth_request");
    const now = this.now();
    this.database.authImmediateTransaction((db) => {
      db.prepare("DELETE FROM forge_oauth_pending_authorizations WHERE expires_at <= ?").run(now.toISOString());
      const pending = db.prepare("SELECT COUNT(*) AS count FROM forge_oauth_pending_authorizations WHERE client_id = ? AND consumed_at IS NULL").get(client.id) as { count: number };
      if (pending.count >= 20) throw new OAuthFailure("temporarily_unavailable", "Too many pending authorization requests", 429, input.redirectUri, input.state);
      db.prepare("INSERT INTO forge_oauth_pending_authorizations (id, client_id, redirect_uri, state, scope, resource, code_challenge, code_challenge_method, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?)").run(requestId, client.id, input.redirectUri, input.state ?? null, scopes, this.resource, input.codeChallenge, new Date(now.getTime() + this.authorizationTtlMs).toISOString(), now.toISOString());
    });
    return { requestId };
  }

  readConsent(userId: string, requestId: string): { requestId: string; clientName: string; redirectUri: string; redirectOrigin: string; scope: string; companies: Array<{ id: string; name: string }> } {
    const pending = this.pending(requestId);
    const user = this.auth.getUserForAuthority(userId);
    if (!user) throw new OAuthFailure("access_denied", "Authentication is necessary", 401);
    const companies = this.auth.listVisibleCompanies(userId).map(({ id, name }) => ({ id, name }));
    return { requestId, clientName: pending.client_name, redirectUri: pending.redirect_uri, redirectOrigin: new URL(pending.redirect_uri).origin, scope: pending.scope, companies };
  }

  approve(input: { userId: string; requestId: string; companyId: string; projectIds: string[] }): string {
    const rawCode = rawSecret("foc");
    const now = this.now();
    const result = this.database.authImmediateTransaction((db) => {
      const pending = db.prepare(`SELECT p.*, c.client_name FROM forge_oauth_pending_authorizations p JOIN forge_oauth_clients c ON c.id = p.client_id WHERE p.id = ?`).get(input.requestId) as PendingRow | undefined;
      if (!pending || pending.consumed_at || Date.parse(pending.expires_at) <= now.getTime()) throw new OAuthFailure("invalid_request", "Authorization request expired", 400);
      const user = this.auth.getUserForAuthority(input.userId);
      if (!user || user.role !== "admin") throw new OAuthFailure("access_denied", "Administrator access is necessary", 403);
      this.auth.requireCompanyAccess(input.userId, input.companyId);
      const existing = db.prepare("SELECT id, agent_id, cursor_key, revoked_at FROM forge_oauth_grants WHERE client_id = ? AND user_id = ? AND company_id = ?").get(pending.client_id, input.userId, input.companyId) as { id: string; agent_id: string; cursor_key: string; revoked_at: string | null } | undefined;
      let grantId = existing?.id;
      if (existing) {
        db.prepare("UPDATE forge_oauth_token_families SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?").run(now.toISOString(), existing.id);
        db.prepare("UPDATE forge_oauth_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id IN (SELECT id FROM forge_oauth_token_families WHERE grant_id = ?)").run(now.toISOString(), existing.id);
        db.prepare("UPDATE forge_oauth_authorization_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE grant_id = ?").run(now.toISOString(), existing.id);
        if (db.prepare("UPDATE forge_external_agents SET status = 'paired', revoked_at = NULL, paired_at = COALESCE(paired_at, ?), updated_at = ? WHERE id = ? AND company_id = ?").run(now.toISOString(), now.toISOString(), existing.agent_id, input.companyId).changes !== 1) throw new OAuthFailure("access_denied", "Connection is not available", 403);
        db.prepare("DELETE FROM forge_external_agent_project_grants WHERE agent_id = ?").run(existing.agent_id);
        const insert = db.prepare("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) SELECT ?, ?, id, ? FROM forge_projects WHERE id = ? AND company_id = ?");
        for (const projectId of [...new Set(input.projectIds)].sort()) {
          if (insert.run(existing.agent_id, input.companyId, now.toISOString(), projectId, input.companyId).changes !== 1) throw new OAuthFailure("invalid_request", "Project selection is invalid", 400);
        }
        if (input.projectIds.length === 0) throw new OAuthFailure("invalid_request", "Select at least one project", 400);
        db.prepare("UPDATE forge_oauth_grants SET scope = ?, resource = ?, revoked_at = NULL, updated_at = ? WHERE id = ?").run(scopes, this.resource, now.toISOString(), grantId);
      } else {
        grantId = identifier("oauth_grant");
        const cursorKey = randomBytes(32).toString("base64url");
        const principal = this.externalAgent.provisionOAuthAgentInTransaction(db, { actorUserId: input.userId, clientId: pending.client_id, clientName: pending.client_name, companyId: input.companyId, projectIds: input.projectIds, cursorKey });
        db.prepare("INSERT INTO forge_oauth_grants (id, client_id, user_id, company_id, agent_id, scope, resource, cursor_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(grantId, pending.client_id, input.userId, input.companyId, principal.agentId, scopes, this.resource, cursorKey, now.toISOString(), now.toISOString());
      }
      if (db.prepare("UPDATE forge_oauth_pending_authorizations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now.toISOString(), pending.id).changes !== 1) throw new OAuthFailure("invalid_request", "Authorization request was already used", 400);
      db.prepare("INSERT INTO forge_oauth_authorization_codes (id, grant_id, code_hash, redirect_uri, resource, code_challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(identifier("oauth_code"), grantId, hashSecret(rawCode), pending.redirect_uri, pending.resource, pending.code_challenge, new Date(now.getTime() + this.codeTtlMs).toISOString(), now.toISOString());
      return { redirectUri: pending.redirect_uri, state: pending.state };
    });
    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set("code", rawCode);
    redirect.searchParams.set("iss", this.issuer);
    if (result.state !== null) redirect.searchParams.set("state", result.state);
    return redirect.toString();
  }

  deny(userId: string, requestId: string): string {
    const now = this.now().toISOString();
    const result = this.database.authImmediateTransaction((db) => {
      const pending = db.prepare(`SELECT p.*, c.client_name FROM forge_oauth_pending_authorizations p JOIN forge_oauth_clients c ON c.id = p.client_id WHERE p.id = ?`).get(requestId) as PendingRow | undefined;
      if (!pending || pending.consumed_at || Date.parse(pending.expires_at) <= this.now().getTime()) throw new OAuthFailure("invalid_request", "Authorization request expired", 400);
      if (!this.auth.getUserForAuthority(userId)) throw new OAuthFailure("access_denied", "Authentication is necessary", 401);
      if (db.prepare("UPDATE forge_oauth_pending_authorizations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now, requestId).changes !== 1) throw new OAuthFailure("invalid_request", "Authorization request was already used", 400);
      return pending;
    });
    const redirect = new URL(result.redirect_uri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("iss", this.issuer);
    if (result.state !== null) redirect.searchParams.set("state", result.state);
    return redirect.toString();
  }

  exchangeCode(input: { code: string; clientId: string; redirectUri: string; resource: string; verifier: string }): { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string } {
    if (!verifierSchema.safeParse(input.verifier).success) throw new OAuthFailure("invalid_grant", "Authorization code is invalid", 400);
    const now = this.now();
    const accessToken = rawSecret("foa");
    const refreshToken = rawSecret("for");
    this.database.authImmediateTransaction((db) => {
      const row = db.prepare(`SELECT c.id AS code_id, c.redirect_uri, c.resource, c.code_challenge, c.expires_at, c.consumed_at, g.*, g.id AS grant_id FROM forge_oauth_authorization_codes c JOIN forge_oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = ?`).get(hashSecret(input.code)) as (GrantRow & { code_id: string; redirect_uri: string; code_challenge: string; expires_at: string; consumed_at: string | null; grant_id: string }) | undefined;
      if (!row || row.consumed_at || row.revoked_at || Date.parse(row.expires_at) <= now.getTime() || row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri || row.resource !== input.resource || input.resource !== this.resource || pkceChallenge(input.verifier) !== row.code_challenge) throw new OAuthFailure("invalid_grant", "Authorization code is invalid", 400);
      this.assertGrantAuthority(row);
      if (db.prepare("UPDATE forge_oauth_authorization_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now.toISOString(), row.code_id).changes !== 1) throw new OAuthFailure("invalid_grant", "Authorization code is invalid", 400);
      const familyId = identifier("oauth_family");
      db.prepare("INSERT INTO forge_oauth_token_families (id, grant_id, client_id, resource, created_at) VALUES (?, ?, ?, ?, ?)").run(familyId, row.grant_id, row.client_id, row.resource, now.toISOString());
      this.insertTokens(db, familyId, accessToken, refreshToken, 0, now);
    });
    return { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor(this.accessTokenTtlMs / 1_000), refresh_token: refreshToken, scope: scopes };
  }

  refresh(input: { refreshToken: string; clientId: string; resource: string; scope?: string }): { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string } {
    if (input.scope !== undefined && input.scope !== scopes) throw new OAuthFailure("invalid_scope", "Requested scope is not available", 400);
    const now = this.now();
    const accessToken = rawSecret("foa");
    const refreshToken = rawSecret("for");
    const outcome = this.database.authImmediateTransaction((db) => {
      const row = db.prepare(`SELECT r.id AS refresh_id, r.generation, r.expires_at, r.consumed_at, f.id AS family_id, f.revoked_at AS family_revoked_at, f.resource, g.* FROM forge_oauth_refresh_tokens r JOIN forge_oauth_token_families f ON f.id = r.family_id JOIN forge_oauth_grants g ON g.id = f.grant_id WHERE r.token_hash = ?`).get(hashSecret(input.refreshToken)) as (GrantRow & { refresh_id: string; generation: number; expires_at: string; consumed_at: string | null; family_id: string; family_revoked_at: string | null }) | undefined;
      if (!row || row.family_revoked_at || row.revoked_at || row.client_id !== input.clientId || row.resource !== input.resource || input.resource !== this.resource || Date.parse(row.expires_at) <= now.getTime()) return "invalid" as const;
      if (row.consumed_at) {
        db.prepare("UPDATE forge_oauth_token_families SET revoked_at = ?, reuse_detected_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), now.toISOString(), row.family_id);
        db.prepare("UPDATE forge_oauth_access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(now.toISOString(), row.family_id);
        return "reused" as const;
      }
      this.assertGrantAuthority(row);
      if (db.prepare("UPDATE forge_oauth_refresh_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now.toISOString(), row.refresh_id).changes !== 1) return "invalid" as const;
      this.insertTokens(db, row.family_id, accessToken, refreshToken, row.generation + 1, now);
      return "ok" as const;
    });
    if (outcome !== "ok") throw new OAuthFailure("invalid_grant", "Refresh token is invalid", 400);
    return { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor(this.accessTokenTtlMs / 1_000), refresh_token: refreshToken, scope: scopes };
  }

  authenticateAccessToken(rawToken: string): ExternalAgentPrincipal {
    const now = this.now();
    const row = this.database.authImmediateTransaction((db) => {
      const value = db.prepare(`SELECT a.id AS token_id, a.expires_at, f.id AS family_id, f.revoked_at AS family_revoked_at, g.* FROM forge_oauth_access_tokens a JOIN forge_oauth_token_families f ON f.id = a.family_id JOIN forge_oauth_grants g ON g.id = f.grant_id WHERE a.token_hash = ? AND a.revoked_at IS NULL`).get(hashSecret(rawToken)) as TokenRow | undefined;
      if (!value || value.family_revoked_at || value.revoked_at || value.resource !== this.resource || Date.parse(value.expires_at) <= now.getTime()) throw new OAuthFailure("invalid_token", "Access token is invalid", 401);
      this.assertGrantAuthority(value);
      db.prepare("UPDATE forge_oauth_access_tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), value.token_id);
      return value;
    });
    return this.externalAgent.oauthPrincipal(row.agent_id, row.cursor_key);
  }

  revoke(rawToken: string, clientId?: string): void {
    const now = this.now().toISOString();
    this.database.authImmediateTransaction((db) => {
      const hash = hashSecret(rawToken);
      const row = db.prepare(`SELECT f.id AS family_id, f.client_id FROM forge_oauth_token_families f WHERE f.id = (SELECT family_id FROM forge_oauth_access_tokens WHERE token_hash = ?) OR f.id = (SELECT family_id FROM forge_oauth_refresh_tokens WHERE token_hash = ?)`).get(hash, hash) as { family_id: string; client_id: string } | undefined;
      if (!row || (clientId && row.client_id !== clientId)) return;
      db.prepare("UPDATE forge_oauth_token_families SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, row.family_id);
      db.prepare("UPDATE forge_oauth_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(now, row.family_id);
    });
  }

  private pending(requestId: string): PendingRow {
    if (!clientIdSchema.safeParse(requestId).success) throw new OAuthFailure("invalid_request", "Authorization request is invalid", 400);
    const row = this.database.authQuery((db) => db.prepare(`SELECT p.*, c.client_name FROM forge_oauth_pending_authorizations p JOIN forge_oauth_clients c ON c.id = p.client_id WHERE p.id = ?`).get(requestId) as PendingRow | undefined);
    if (!row || row.consumed_at || Date.parse(row.expires_at) <= this.now().getTime()) throw new OAuthFailure("invalid_request", "Authorization request expired", 400);
    return row;
  }

  private assertGrantAuthority(grant: GrantRow): void {
    const user = this.auth.getUserForAuthority(grant.user_id);
    if (!user || user.role !== "admin") throw new OAuthFailure("invalid_grant", "Authorization is no longer active", 400);
    try { this.auth.requireCompanyAccess(user.id, grant.company_id); }
    catch { throw new OAuthFailure("invalid_grant", "Authorization is no longer active", 400); }
    try { this.externalAgent.assertOAuthAgentActive(grant.agent_id); }
    catch { throw new OAuthFailure("invalid_grant", "Authorization is no longer active", 400); }
  }

  private insertTokens(db: Database.Database, familyId: string, accessToken: string, refreshToken: string, generation: number, now: Date): void {
    db.prepare("INSERT INTO forge_oauth_access_tokens (id, family_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(identifier("oauth_access"), familyId, hashSecret(accessToken), new Date(now.getTime() + this.accessTokenTtlMs).toISOString(), now.toISOString());
    db.prepare("INSERT INTO forge_oauth_refresh_tokens (id, family_id, token_hash, generation, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(identifier("oauth_refresh"), familyId, hashSecret(refreshToken), generation, new Date(now.getTime() + this.refreshTokenTtlMs).toISOString(), now.toISOString());
  }
}

export function isOAuthBearer(value: string): boolean {
  return /^foa_[A-Za-z0-9_-]{43}$/.test(value);
}

export function oauthFailureFromExternal(error: unknown): OAuthFailure {
  if (error instanceof OAuthFailure) return error;
  if (error instanceof ExternalAgentFailure) return new OAuthFailure("access_denied", error.publicMessage, error.statusCode);
  return new OAuthFailure("server_error", "OAuth request failed", 500);
}
