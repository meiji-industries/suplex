import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/identity/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  let sequence = 0;
  return {
    async generateRegistrationOptions(input) {
      sequence += 1;
      return { rp: { name: "Suplex", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from(`registration-${sequence}`).toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" };
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
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  opencode: async () => ({ id: "opencode" as const, label: "OpenCode", status: "healthy" as const, summary: "Ready", details: {} }),
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

function normalizeCompanyBody(body: string): string {
  return body
    .replace(/company_[a-f0-9]{32}/g, "company_ID")
    .replace(/"createdAt":"[^"]+"/, '"createdAt":"TIMESTAMP"');
}

test("API enrollment and authorization fail closed before company details are returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-auth-api-test-"));
  const database = new SuplexDatabase(join(root, "suplex.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "https://suplex.tailnet.ts.net:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const app = createApp({ config, auth, health, getHealth: async () => ({ generatedAt: new Date().toISOString(), reachableAddress: config.reachableAddress, ready: true, checks: [] }) });
  try {
    const malformedProfile = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" }, payload: {} });
    expect(malformedProfile.statusCode).toBe(400);
    expect(malformedProfile.json()).toEqual({ error: "Invalid request", findings: [{ code: "invalid-custom", field: ".", message: "Request value is invalid" }] });
    const wrongTypeProfile = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" }, payload: { username: 42 } });
    expect(wrongTypeProfile.statusCode).toBe(400);
    expect(wrongTypeProfile.json()).toEqual({ error: "Invalid request", findings: [{ code: "invalid-invalid_type", field: ".username", message: "Request value is invalid" }] });
    const noBodyProfile = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" } });
    expect(noBodyProfile.statusCode).toBe(400);
    expect(noBodyProfile.json()).toEqual({ error: "Invalid request", findings: [{ code: "invalid-invalid_type", field: ".", message: "Request value is invalid" }] });
    const textProfile = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example", "content-type": "text/plain" }, payload: "hello" });
    expect(textProfile.statusCode).toBe(400);
    expect(textProfile.json()).toEqual({ error: "Invalid request", findings: [{ code: "invalid-invalid_type", field: ".", message: "Request value is invalid" }] });
    const malformedCompany = await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" }, payload: { name: 42 } });
    expect(malformedCompany.statusCode).toBe(400);
    const validCompanyWrongOrigin = await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" }, payload: { name: "Company" } });
    expect(validCompanyWrongOrigin.statusCode).toBe(403);
    const malformedInvitation = await app.inject({ method: "POST", url: "/api/admin/invitations", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" }, payload: { displayName: 42 } });
    expect(malformedInvitation.statusCode).toBe(400);
    const validInvitationWrongOrigin = await app.inject({ method: "POST", url: "/api/admin/invitations", headers: { cookie: "sid_v1=stale", origin: "https://wrong.example" }, payload: { displayName: "Member" } });
    expect(validInvitationWrongOrigin.statusCode).toBe(403);
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
    const usernameUpdate = await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { displayName: "API Admin Renamed", username: "api-admin", avatarSeed: "api-admin-avatar" } });
    expect(usernameUpdate.json()).toMatchObject({ user: { displayName: "API Admin Renamed", username: "api-admin", avatarSeed: "api-admin-avatar" } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } })).json()).toMatchObject({ user: { avatarSeed: "api-admin-avatar" } });
    expect((await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { username: "!" } })).json()).toEqual({ error: "Username must be 2–64 characters and use letters, numbers, dots, hyphens, underscores, or @" });

    const companyAResponse = await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "API A" } });
    const createdAt = (companyAResponse.json() as { createdAt: string }).createdAt;
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(normalizeCompanyBody(companyAResponse.body)).toBe('{"id":"company_ID","name":"API A","status":"active","issueCode":null,"createdAt":"TIMESTAMP"}');
    const companyA = companyAResponse.json() as { id: string; issueCode: string | null };
    expect(companyA).toMatchObject({ issueCode: null });
    const companyB = (await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "API B" } })).json() as { id: string };
    const renamed = await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "  API A renamed  " } });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { createdAt: string }).createdAt).toBe(createdAt);
    expect(normalizeCompanyBody(renamed.body)).toBe('{"id":"company_ID","name":"API A renamed","status":"active","issueCode":null,"createdAt":"TIMESTAMP"}');
    expect(renamed.json()).toMatchObject({ id: companyA.id, name: "API A renamed", status: "active" });
    const issueCode = await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}/issue-code`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { issueCode: "  ad4m " } });
    expect(issueCode.statusCode).toBe(200);
    expect((issueCode.json() as { createdAt: string }).createdAt).toBe(createdAt);
    expect(normalizeCompanyBody(issueCode.body)).toBe('{"id":"company_ID","name":"API A renamed","status":"active","issueCode":"AD4M","createdAt":"TIMESTAMP"}');
    expect(issueCode.json()).toMatchObject({ id: companyA.id, issueCode: "AD4M" });
    expect((await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}/issue-code`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { issueCode: "A" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/companies/${companyA.id}/status/paused`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { name: "" } })).json()).toEqual({ error: "Company name is invalid" });
    expect((await app.inject({ method: "DELETE", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: adminCookie, origin: config.reachableAddress } })).statusCode).toBe(404);
    const inviteResponse = await app.inject({ method: "POST", url: "/api/admin/invitations", headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { displayName: "API member" } });
    const invite = inviteResponse.json() as { token: string; expiresAt: string; user: { id: string } };
    expect(inviteResponse.statusCode).toBe(201);
    expect(invite.token).toMatch(/^invite_v1_user_[A-Za-z0-9_-]{43}$/);
    expect(invite.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(inviteResponse.body.replaceAll(invite.token, "TOKEN").replaceAll(invite.user.id, "user_ID").replaceAll(invite.expiresAt, "TIMESTAMP")).toBe('{"token":"TOKEN","kind":"user","expiresAt":"TIMESTAMP","user":{"id":"user_ID","displayName":"API member","username":"user_v1_user_ID","avatarSeed":"user_v1_user_ID","role":"member","status":"pending","companyIds":[]}}');
    const memberOptions = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: invite.token } });
    const memberCeremony = memberOptions.json() as { challengeId: string };
    const memberEnrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: invite.token, challengeId: memberCeremony.challengeId, response: { id: "member-api-credential", type: "public-key" } } });
    const memberCookie = sessionCookie(memberEnrolled);
    expect((await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: memberCookie, origin: config.reachableAddress }, payload: { username: "api-admin" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: "/api/auth/me", headers: { cookie: memberCookie, origin: config.reachableAddress }, payload: { username: "api-member" } })).json()).toMatchObject({ user: { username: "api-member" } });

    const memberRename = await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}`, headers: { cookie: memberCookie, origin: config.reachableAddress }, payload: { name: "Member rename" } });
    expect(memberRename.statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/companies/${companyA.id}/issue-code`, headers: { cookie: memberCookie, origin: config.reachableAddress }, payload: { issueCode: "MEM" } })).statusCode).toBe(404);

    const membership = await app.inject({ method: "POST", url: `/api/admin/companies/${companyA.id}/members`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: { userId: invite.user.id } });
    expect(membership.statusCode).toBe(204);
    const invitations = await app.inject({ method: "GET", url: "/api/admin/invitations", headers: { cookie: adminCookie } });
    expect(invitations.statusCode).toBe(200);
    expect(JSON.stringify(invitations.json())).not.toContain(invite.token);
    expect(invitations.json().invitations).toEqual(expect.arrayContaining([expect.objectContaining({ displayName: "API member", status: "consumed" })]));
    const credentials = await app.inject({ method: "GET", url: "/api/admin/credentials", headers: { cookie: adminCookie } });
    expect(credentials.statusCode).toBe(200);
    const memberCredential = (credentials.json() as { credentials: Array<{ id: string; userId: string; revokedAt?: string }> }).credentials.find((credential) => credential.userId === invite.user.id);
    expect(memberCredential).toBeDefined();
    const revokedCredential = await app.inject({ method: "POST", url: `/api/admin/credentials/${memberCredential!.id}/revoke`, headers: { cookie: adminCookie, origin: config.reachableAddress }, payload: {} });
    expect(revokedCredential.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/admin/credentials", headers: { cookie: adminCookie } })).json().credentials).toEqual(expect.arrayContaining([expect.objectContaining({ id: memberCredential!.id, revokedAt: expect.any(String) })]));
    expect((await app.inject({ method: "GET", url: "/api/admin/invitations", headers: { cookie: memberCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/companies/${companyA.id}/settings`, headers: { cookie: adminCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/companies/${companyA.id}/settings`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/profile", headers: { cookie: memberCookie } })).statusCode).toBe(200);
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
