import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { BACKUP_HEALTH_MAX_AGE_MS, BackupService, checkBackupHealth } from "../src/platform/backup.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { nativeApp } from "./helpers/native-app.js";
import { AuthService } from "../src/identity/auth.js";
import { ExternalAgentService } from "../src/identity/external-agents.js";
import { OAuthService } from "../src/identity/oauth.js";

test("backup snapshots exclude provider API keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-provider-backup-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new SuplexDatabase(config.databasePath);
  try {
    expect(database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name = 'suplex_provider_credentials'").all())).toEqual([]);
    const archive = join(root, "backup.tar.gz");
    await new BackupService(config).create({ destination: archive });
    const restored = join(root, "restored");
    await new BackupService(config).restore(archive, restored);
    const snapshot = new SuplexDatabase(join(restored, "suplex-backup", "app", "suplex.sqlite"));
    try { expect(snapshot.authQuery((db) => db.prepare("SELECT name FROM sqlite_master WHERE name = 'suplex_provider_credentials'").all().length)).toBe(0); } finally { snapshot.close(); }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("backup removes OAuth secrets but preserves connection identity for reapproval", async () => {
  const fixture = await nativeApp();
  await mkdir(fixture.config.artifactRoot, { recursive: true });
  const now = new Date().toISOString();
  const clientId = "oauth_client_backup";
  let agentId = "";
  fixture.database.authTransaction((db) => {
    db.prepare("INSERT INTO suplex_oauth_clients (id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, created_at, updated_at) VALUES (?, 'Backup client', ?, '[\"authorization_code\",\"refresh_token\"]', '[\"code\"]', 'none', ?, ?)").run(clientId, '["http://127.0.0.1:9319/callback"]', now, now);
    const principal = fixture.externalAgent.provisionOAuthAgentInTransaction(db, { actorUserId: fixture.userId, clientId, clientName: "Backup client", companyId: fixture.company.id, projectIds: [fixture.project.id], cursorKey: "old-cursor-key" });
    agentId = principal.agentId;
    db.prepare("INSERT INTO suplex_oauth_grants (id, client_id, user_id, company_id, agent_id, scope, resource, cursor_key, created_at, updated_at) VALUES ('oauth_grant_backup', ?, ?, ?, ?, 'suplex:mcp', ?, 'old-cursor-key', ?, ?)").run(clientId, fixture.userId, fixture.company.id, agentId, fixture.oauth.resource, now, now);
    db.prepare("INSERT INTO suplex_oauth_token_families (id, grant_id, client_id, resource, created_at) VALUES ('oauth_family_backup', 'oauth_grant_backup', ?, ?, ?)").run(clientId, fixture.oauth.resource, now);
    db.prepare("INSERT INTO suplex_oauth_access_tokens (id, family_id, token_hash, expires_at, created_at) VALUES ('oauth_access_backup', 'oauth_family_backup', 'old-access-hash', '2099-01-01T00:00:00.000Z', ?)").run(now);
  });
  const archive = join(fixture.directory, "oauth-backup.tar.gz");
  await new BackupService(fixture.config).create({ destination: archive });
  const restoredRoot = join(fixture.directory, "oauth-restored");
  await new BackupService(fixture.config).restore(archive, restoredRoot);
  const restored = new SuplexDatabase(join(restoredRoot, "suplex-backup", "app", "suplex.sqlite"));
  try {
    expect(restored.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM suplex_oauth_access_tokens").get() as { count: number }).count)).toBe(0);
    const grant = restored.authQuery((db) => db.prepare("SELECT agent_id, cursor_key FROM suplex_oauth_grants WHERE id = 'oauth_grant_backup'").get() as { agent_id: string; cursor_key: string });
    expect(grant.agent_id).toBe(agentId);
    expect(grant.cursor_key).not.toBe("old-cursor-key");
    const auth = new AuthService(restored, fixture.config);
    const externalAgent = new ExternalAgentService(restored, auth);
    const oauth = new OAuthService(restored, auth, externalAgent, fixture.config.reachableAddress);
    const verifier = "b".repeat(43);
    const request = oauth.beginAuthorization({ clientId, redirectUri: "http://127.0.0.1:9319/callback", responseType: "code", state: "backup", scope: "suplex:mcp", resource: oauth.resource, codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256" });
    oauth.approve({ userId: fixture.userId, requestId: request.requestId, companyId: fixture.company.id, projectIds: [fixture.project.id] });
    expect(restored.authQuery((db) => (db.prepare("SELECT agent_id FROM suplex_oauth_grants WHERE id = 'oauth_grant_backup'").get() as { agent_id: string }).agent_id)).toBe(agentId);
  } finally {
    restored.close();
    await fixture.close();
  }
});

const fixedNow = Date.parse("2026-08-29T12:00:00.000Z");

async function backupHealth(value?: object) {
  const root = await mkdtemp(join(tmpdir(), "suplex-backup-health-"));
  try {
    if (value) await writeFile(join(root, "backup-status.json"), JSON.stringify(value));
    return await checkBackupHealth(createTestConfig(root), () => fixedNow);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("backup health remains healthy at the exact maximum-age boundary", async () => {
  const verifiedAt = new Date(fixedNow - BACKUP_HEALTH_MAX_AGE_MS).toISOString();
  expect(await backupHealth({ valid: true, verifiedAt })).toMatchObject({
    status: "healthy",
    details: { verifiedAt, ageMs: BACKUP_HEALTH_MAX_AGE_MS },
  });
});

test("backup health warns for an optional backup one millisecond past the maximum age", async () => {
  const verifiedAt = new Date(fixedNow - BACKUP_HEALTH_MAX_AGE_MS - 1).toISOString();
  expect(await backupHealth({ valid: true, verifiedAt })).toMatchObject({
    status: "warning",
    details: { verifiedAt, ageMs: BACKUP_HEALTH_MAX_AGE_MS + 1 },
  });
});

test("backup health is a warning when no backup has been made yet", async () => {
  expect(await backupHealth()).toMatchObject({
    status: "warning",
    details: { verifiedAt: "never", ageMs: -1, errors: "missing-status" },
  });
});

test.each([
  ["failed verification", { valid: false, verifiedAt: new Date(fixedNow).toISOString(), errors: ["hash mismatch"] }],
  ["invalid verification timestamp", { valid: true, verifiedAt: "not-a-date" }],
])("backup health is unhealthy for %s", async (_label, value) => {
  expect(await backupHealth(value)).toMatchObject({ status: "unhealthy", details: { ageMs: -1 } });
});
