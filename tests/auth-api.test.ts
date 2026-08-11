import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  let sequence = 0;
  return {
    async generateRegistrationOptions(input) {
      sequence += 1;
      return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from(`registration-${sequence}`).toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([4, 5, 6]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      sequence += 1;
      return { challenge: Buffer.from(`authentication-${sequence}`).toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

const health = {
  temporal: async () => ({ id: "temporal" as const, label: "Temporal", status: "healthy" as const, summary: "Reachable", details: {} }),
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  worker: async () => ({ id: "worker" as const, label: "Worker", status: "healthy" as const, summary: "Reachable", details: {} }),
  codexAuth: async () => ({ id: "codex-auth" as const, label: "Codex", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

function sessionCookie(response: { headers: OutgoingHttpHeaders }): string {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  for (const setCookie of values) {
    const pair = setCookie.split(";", 1)[0] ?? "";
    const [name, value] = pair.split("=", 2);
    if (name?.trim() === SESSION_COOKIE_NAME && value !== undefined) return `${name.trim()}=${value}`;
  }
  return "";
}

test("API enrollment and authorization fail closed before company details are returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-auth-api-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const app = createApp({ config, auth, health, getHealth: async () => ({ generatedAt: new Date().toISOString(), reachableAddress: config.reachableAddress, ready: true, checks: [] }) });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).json()).toMatchObject({ required: true, authenticated: false });
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    expect(options.statusCode).toBe(200);
    const ceremony = options.json() as { challengeId: string };
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: ceremony.challengeId, response: { id: "admin-api-credential", type: "public-key" } } });
    expect(enrolled.statusCode).toBe(200);
    const adminCookie = sessionCookie(enrolled);
    expect(adminCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } })).statusCode).toBe(200);

    const companyA = (await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "API A" } })).json() as { id: string };
    const companyB = (await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "API B" } })).json() as { id: string };
    const renamed = await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "  API A renamed  " } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: companyA.id, name: "API A renamed", status: "active" });
    expect((await app.inject({ method: "POST", url: `/api/admin/companies/${companyA.id}/status/paused`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "" } })).json()).toEqual({ error: "Company name is invalid" });
    expect((await app.inject({ method: "DELETE", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress } })).statusCode).toBe(404);
    const invite = (await app.inject({ method: "POST", url: "/api/admin/invitations", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { displayName: "API member" } })).json() as { token: string; user: { id: string } };
    const memberOptions = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: invite.token } });
    const memberCeremony = memberOptions.json() as { challengeId: string };
    const memberEnrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: invite.token, challengeId: memberCeremony.challengeId, response: { id: "member-api-credential", type: "public-key" } } });
    const memberCookie = sessionCookie(memberEnrolled);

    const memberRename = await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: memberCookie, origin: config.reachableAddress }, payload: { name: "Member rename" } });
    expect(memberRename.statusCode).toBe(404);

    const membership = await app.inject({ method: "POST", url: `/api/admin/companies/${companyA.id}/members`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { userId: invite.user.id } });
    expect(membership.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/companies/${companyA.id}/settings`, headers: { cookie: adminCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/companies/${companyA.id}/settings`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/companies/${companyA.id}`, headers: { cookie: memberCookie } })).statusCode).toBe(200);
    const crossScope = await app.inject({ method: "GET", url: `/api/companies/${companyB.id}`, headers: { cookie: memberCookie } });
    expect(crossScope.statusCode).toBe(404);
    expect(crossScope.json()).toEqual({ error: "Not found" });
    expect(JSON.stringify(crossScope.json())).not.toContain("API B");
    expect((await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: memberCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/companies/${companyA.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(302);

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/companies/${companyA.id}/members/${invite.user.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress } });
    expect(removed.statusCode).toBe(204);
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
