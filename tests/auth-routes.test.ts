import { mkdtemp, rm } from "node:fs/promises";
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
      return {
        rp: { name: "Forge", id: input.rpId },
        user: { id: input.userId, name: input.userName, displayName: input.displayName },
        challenge: Buffer.from(`registration-${sequence}`).toString("base64url"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        attestation: "none",
      };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([4, 5, 6]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      sequence += 1;
      return {
        challenge: Buffer.from(`authentication-${sequence}`).toString("base64url"),
        rpId: input.rpId,
        allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })),
        userVerification: "required",
      };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

const health = {
  engine: async () => ({ id: "engine" as const, label: "Engine", status: "healthy" as const, summary: "Reachable", details: {} }),
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  worker: async () => ({ id: "worker" as const, label: "Worker", status: "healthy" as const, summary: "Reachable", details: {} }),
  codexAuth: async () => ({ id: "codex-auth" as const, label: "Codex", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

type RouteKind = "read" | "mutation" | "unauthenticated-mutation";
type Role = "anonymous" | "admin" | "member";
type Scope = "none" | "company" | "admin";

interface RoutePolicy {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  kind: RouteKind;
  allowed: Role[];
  scope: Scope;
  body?: Record<string, unknown>;
  successStatus?: number;
  authenticatedSuccessStatus?: number;
}

const reachableAddress = "https://forge.tailnet.ts.net:4111";

const policies: RoutePolicy[] = [
  { method: "GET", path: "/", kind: "read", allowed: ["anonymous", "admin", "member"], scope: "none", successStatus: 302, authenticatedSuccessStatus: 302 },
  { method: "GET", path: "/auth", kind: "read", allowed: ["anonymous", "admin", "member"], scope: "none", successStatus: 200, authenticatedSuccessStatus: 200 },
  { method: "GET", path: "/api/auth/status", kind: "read", allowed: ["anonymous", "admin", "member"], scope: "none" },

  { method: "POST", path: "/api/auth/bootstrap/options", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/invitation/options", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/recovery/options", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/bootstrap/verify", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/invitation/verify", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/recovery/verify", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/options", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },
  { method: "POST", path: "/api/auth/verify", kind: "unauthenticated-mutation", allowed: ["anonymous"], scope: "none", successStatus: 200 },

  { method: "GET", path: "/api/auth/me", kind: "read", allowed: ["admin", "member"], scope: "none" },
  { method: "GET", path: "/api/companies", kind: "read", allowed: ["admin", "member"], scope: "none" },
  { method: "GET", path: "/api/companies/:companyId", kind: "read", allowed: ["admin", "member"], scope: "company" },
  { method: "GET", path: "/api/admin/users", kind: "read", allowed: ["admin"], scope: "none" },
  { method: "GET", path: "/api/admin/invitations", kind: "read", allowed: ["admin"], scope: "none" },
  { method: "GET", path: "/api/admin/credentials", kind: "read", allowed: ["admin"], scope: "none" },
  { method: "GET", path: "/api/admin/audit", kind: "read", allowed: ["admin"], scope: "none" },
  { method: "GET", path: "/api/health", kind: "read", allowed: ["admin", "member"], scope: "none" },

  { method: "POST", path: "/api/admin/companies", kind: "mutation", allowed: ["admin"], scope: "none", body: { name: "Policy Company" }, successStatus: 201 },
  { method: "PATCH", path: "/api/admin/companies/:companyId", kind: "mutation", allowed: ["admin"], scope: "admin", body: { name: "Renamed" }, successStatus: 200 },
  { method: "POST", path: "/api/admin/companies/:companyId/status/paused", kind: "mutation", allowed: ["admin"], scope: "admin", body: {}, successStatus: 200 },
  { method: "POST", path: "/api/admin/invitations", kind: "mutation", allowed: ["admin"], scope: "none", body: { displayName: "Invitee" }, successStatus: 201 },
  { method: "POST", path: "/api/admin/companies/:companyId/members", kind: "mutation", allowed: ["admin"], scope: "admin", body: { userId: ":userId" }, successStatus: 204 },
  { method: "DELETE", path: "/api/admin/companies/:companyId/members/:userId", kind: "mutation", allowed: ["admin"], scope: "admin", body: {}, successStatus: 204 },
  { method: "POST", path: "/api/admin/credentials/:credentialId/revoke", kind: "mutation", allowed: ["admin"], scope: "admin", body: {}, successStatus: 204 },
  { method: "POST", path: "/api/admin/users/:userId/revoke", kind: "mutation", allowed: ["admin"], scope: "admin", body: {}, successStatus: 204 },
];

function expandPath(path: string, companyId: string, userId: string, credentialId: string): string {
  return path.replace(":companyId", encodeURIComponent(companyId)).replace(":userId", encodeURIComponent(userId)).replace(":credentialId", encodeURIComponent(credentialId));
}

function expandBody(body: Record<string, unknown> | undefined, companyId: string, userId: string): Record<string, unknown> | undefined {
  if (!body) return undefined;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value.replace(":companyId", companyId).replace(":userId", userId) : value]));
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-auth-routes-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const app = createApp({ config, auth, health, getHealth: async () => ({ generatedAt: new Date().toISOString(), reachableAddress: config.reachableAddress, ready: true, checks: [] }) });
  return { root, database, config, auth, app };
}

async function closeFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  await fixture.app.close();
  fixture.database.close();
  await rm(fixture.root, { recursive: true, force: true });
}

async function enrollAdmin(auth: AuthService) {
  const invitation = auth.ensureBootstrapInvitation()!;
  const options = await auth.beginBootstrapRegistration(invitation.token);
  return auth.completeBootstrapRegistration({ token: invitation.token, challengeId: options.challengeId, response: { id: "admin-policy-credential", type: "public-key" } });
}

async function enrollMember(auth: AuthService, admin: { user: { id: string } }) {
  const invite = auth.inviteUser(admin.user.id, { displayName: "Policy member" });
  const options = await auth.beginInvitationRegistration(invite.token);
  return auth.completeInvitationRegistration({ token: invite.token, challengeId: options.challengeId, response: { id: "member-policy-credential", type: "public-key" } });
}

function parseCookie(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  for (const setCookie of values) {
    const pair = setCookie.split(";", 1)[0] ?? "";
    const [cookieName, cookieValue] = pair.split("=", 2);
    if (cookieName?.trim() === name && cookieValue !== undefined) return `${cookieName.trim()}=${cookieValue}`;
  }
  return "";
}

async function signInCookie(app: Awaited<ReturnType<typeof createApp>>, auth: AuthService, credentialId: string): Promise<string> {
  const options = await auth.beginAuthentication();
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    payload: { challengeId: options.challengeId, response: { id: credentialId, type: "public-key" } },
  });
  return parseCookie(response.headers["set-cookie"], SESSION_COOKIE_NAME);
}

function injectOptions(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie?: string, origin?: string, body?: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const options: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; headers?: Record<string, string>; payload?: Record<string, unknown> } = { method, url, headers };
  if (body) options.payload = body;
  return options;
}

test("route matrix is enforced: anonymous, role, company scope, and missing or wrong origin fail closed", async () => {
  const fixture = await makeFixture();
  try {
    const admin = await enrollAdmin(fixture.auth);
    const member = await enrollMember(fixture.auth, admin);

    const adminCookie = await signInCookie(fixture.app, fixture.auth, "admin-policy-credential");
    const memberCookie = await signInCookie(fixture.app, fixture.auth, "member-policy-credential");
    const memberCredential = fixture.auth.listCredentials(admin.user.id).find((credential) => credential.userId === member.user.id);
    expect(memberCredential).toBeDefined();

    const company = fixture.auth.createCompany(admin.user.id, "Policy") as { id: string };

    for (const policy of policies) {
      const target = expandPath(policy.path, company.id, member.user.id, memberCredential!.id);
      const body = expandBody(policy.body, company.id, member.user.id);
      const authSuccess = policy.authenticatedSuccessStatus ?? (policy.successStatus ?? 200);

      if (policy.allowed.includes("anonymous")) {
        const anonymous = await fixture.app.inject(injectOptions(policy.method, target, undefined, undefined, body));
        expect([200, 201, 204, 302, 400]).toContain(anonymous.statusCode);
      } else {
        const anonymous = await fixture.app.inject(injectOptions(policy.method, target, undefined, undefined, body));
        expect(anonymous.statusCode).toBe(401);
      }

      const cookie = policy.allowed.includes("admin") ? adminCookie : memberCookie;

      if (policy.kind === "read") {
        const result = await fixture.app.inject(injectOptions(policy.method, target, cookie));
        if (policy.scope === "admin") {
          expect(result.statusCode).toBe(404);
        } else if (policy.scope === "company" && target.includes(company.id)) {
          expect([200, 302, 404]).toContain(result.statusCode);
        } else {
          expect(result.statusCode).toBe(authSuccess);
        }
      }

      if (policy.kind === "mutation") {
        const memberResult = await fixture.app.inject(injectOptions(policy.method, target, memberCookie, reachableAddress, body));
        if (!policy.allowed.includes("member")) {
          expect(memberResult.statusCode).toBe(404);
        } else {
          expect([200, 201, 204]).toContain(memberResult.statusCode);
        }

        if (policy.allowed.includes("admin")) {
          const withoutOrigin = await fixture.app.inject(injectOptions(policy.method, target, adminCookie, undefined, body));
          expect(withoutOrigin.json()).toEqual({ error: "request_origin_invalid" });

          const wrongOrigin = await fixture.app.inject(injectOptions(policy.method, target, adminCookie, "https://attacker.example", body));
          expect(wrongOrigin.json()).toEqual({ error: "request_origin_invalid" });

          const withOrigin = await fixture.app.inject(injectOptions(policy.method, target, adminCookie, reachableAddress, body));
          expect([200, 201, 204]).toContain(withOrigin.statusCode);
        }
      }
    }
  } finally {
    await closeFixture(fixture);
  }
});

test("sign-out requires a valid origin and revokes the session", async () => {
  const fixture = await makeFixture();
  try {
    await enrollAdmin(fixture.auth);
    const adminCookie = await signInCookie(fixture.app, fixture.auth, "admin-policy-credential");

    const withoutOrigin = await fixture.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { cookie: adminCookie } });
    expect(withoutOrigin.json()).toEqual({ error: "request_origin_invalid" });

    const wrongOrigin = await fixture.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { cookie: adminCookie, origin: "https://attacker.example" } });
    expect(wrongOrigin.json()).toEqual({ error: "request_origin_invalid" });

    const signedOut = await fixture.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { cookie: adminCookie, origin: reachableAddress } });
    expect(signedOut.json()).toEqual({ signedOut: true });

    const afterSignOut = await fixture.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } });
    expect(afterSignOut.statusCode).toBe(401);
  } finally {
    await closeFixture(fixture);
  }
});
