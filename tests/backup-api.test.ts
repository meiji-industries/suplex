import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/identity/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";
import { createApp } from "../src/app.js";
import { BackupService, checkBackupHealth } from "../src/platform/backup.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { healthyHost } from "./helpers/native-app.js";

const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Suplex", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "backup-api", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "backup-api", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const all = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (all.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]!.split("=", 2)[1] ?? "";
}

test("administrators create, list and download backups on a fresh host", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-backup-api-"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const database = new SuplexDatabase(config.databasePath);
  const auth = new AuthService(database, config, { webAuthn });
  const app = createApp({ config, auth, database, health: healthyHost });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "backup-admin", type: "public-key" } } });
    const session = cookie(enrolled.headers, SESSION_COOKIE_NAME); const csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: config.reachableAddress, "x-csrf-v1": csrf };

    expect((await app.inject({ method: "GET", url: "/api/admin/backups", headers })).json()).toEqual({ backups: [] });
    const created = await app.inject({ method: "POST", url: "/api/admin/backups", headers });
    expect(created.statusCode).toBe(200);
    const { name } = created.json() as { name: string };
    expect(name).toMatch(/^suplex-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.tar\.gz$/);
    expect((await app.inject({ method: "GET", url: "/api/admin/backups", headers })).json().backups.map((backup: { name: string }) => backup.name)).toEqual([name]);
    expect((await checkBackupHealth(config)).status).toBe("healthy");

    const download = await app.inject({ method: "GET", url: `/api/admin/backups/${name}`, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="${name}"`);
    const copy = join(root, "downloaded.tar.gz");
    await writeFile(copy, download.rawPayload);
    expect((await new BackupService(config).verify(copy)).valid).toBe(true);

    expect((await app.inject({ method: "GET", url: "/api/admin/backups/..%2Fsuplex.sqlite", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/admin/backups/suplex-backup-2000-01-01T00-00-00Z.tar.gz", headers })).statusCode).toBe(404);
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
