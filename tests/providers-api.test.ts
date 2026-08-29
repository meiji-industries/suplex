import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { HostHealthDependencies } from "../src/health.js";

const health: HostHealthDependencies = { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) };
const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "provider-api", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "provider-api", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const all = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (all.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]!.split("=", 2)[1] ?? "";
}

test("provider API masks, saves, clears, and tests the OpenRouter key", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-providers-api-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const app = createApp({ config, auth, database, health });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "provider-admin", type: "public-key" } } });
    const session = cookie(enrolled.headers, SESSION_COOKIE_NAME); const csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: config.reachableAddress, "x-csrf-v1": csrf };
    expect((await app.inject({ method: "GET", url: "/api/admin/providers", headers })).json().providers).toHaveLength(3);
    const secret = "sk-openrouter-api-secret";
    expect((await app.inject({ method: "PUT", url: "/api/admin/providers/openrouter/credential", headers, payload: { apiKey: secret } })).statusCode).toBe(204);
    const listed = (await app.inject({ method: "GET", url: "/api/admin/providers", headers })).json();
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.providers.find((provider: { id: string }) => provider.id === "openrouter").credential.maskedKey).toBe("…cret");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/providers/openrouter/credential", headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/api/admin/providers/openrouter/test", headers })).json()).toMatchObject({ ok: false, check: { id: "openrouter-auth" } });
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
