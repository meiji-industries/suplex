import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/identity/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { healthyHost } from "./helpers/native-app.js";

const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Suplex", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "environment-api", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "environment-api", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const all = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (all.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]!.split("=", 2)[1] ?? "";
}

test("environment settings default and persist partial administrator updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-environment-api-"));
  const database = new SuplexDatabase(join(root, "suplex.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const app = createApp({ config, auth, database, health: healthyHost });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "environment-admin", type: "public-key" } } });
    const session = cookie(enrolled.headers, SESSION_COOKIE_NAME); const csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: config.reachableAddress, "x-csrf-v1": csrf };
    expect((await app.inject({ method: "GET", url: "/api/admin/environment", headers })).json()).toEqual({ minFreeDiskGb: 5, defaultBudgetUsd: 15, defaultMaxTurns: 40 });
    expect((await app.inject({ method: "PATCH", url: "/api/admin/environment", headers, payload: { minFreeDiskGb: 7.5 } })).json()).toEqual({ minFreeDiskGb: 7.5, defaultBudgetUsd: 15, defaultMaxTurns: 40 });
    expect((await app.inject({ method: "PATCH", url: "/api/admin/environment", headers, payload: { defaultBudgetUsd: 20, defaultMaxTurns: 30 } })).json()).toEqual({ minFreeDiskGb: 7.5, defaultBudgetUsd: 20, defaultMaxTurns: 30 });
    expect((await app.inject({ method: "GET", url: "/api/admin/environment", headers })).json()).toEqual({ minFreeDiskGb: 7.5, defaultBudgetUsd: 20, defaultMaxTurns: 30 });
    expect((await app.inject({ method: "PATCH", url: "/api/admin/environment", headers, payload: { defaultBudgetUsd: -1 } })).statusCode).toBe(400);
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
