import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { HermesAgentService } from "../src/hermes-agents.js";

const health = {
  engine: async () => ({ id: "engine" as const, label: "Engine", status: "healthy" as const, summary: "Reachable", details: {} }),
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  worker: async () => ({ id: "worker" as const, label: "Worker", status: "healthy" as const, summary: "Reachable", details: {} }),
  codexAuth: async () => ({ id: "codex-auth" as const, label: "Codex", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      return {
        rp: { name: "Forge", id: input.rpId },
        user: { id: input.userId, name: input.userName, displayName: input.displayName },
        challenge: "hermes-api-auth",
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        attestation: "none",
      };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      return {
        challenge: "hermes-auth",
        rpId: input.rpId,
        allowCredentials: input.allowCredentials.map((c) => ({ type: "public-key" as const, ...c })),
        userVerification: "required",
      };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

let root: string;
let database: ForgeDatabase;
let auth: AuthService;
let hermes: HermesAgentService;
let app: ReturnType<typeof createApp>;
let adminId: string;
let companyId: string;
let cookie: string;
let memberCookie: string;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-hermes-api-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  database = new ForgeDatabase(config.databasePath);
  auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const admin = auth.developmentSignIn();
  adminId = admin.user.id;
  cookie = `${SESSION_COOKIE_NAME}=${admin.sessionToken}`;
  origin = config.reachableAddress;

  hermes = new HermesAgentService(database, auth);
  app = createApp({ config, auth, hermes, health });

  companyId = auth.createCompany(adminId, "Hermes API Company").id;
  const now = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_api', ?, 'API Project', ?, ?, 'meiji/api', 'main', 'main', '', '', '[]', '{}', 'draft', ?, ?)").run(companyId, join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_api_2', ?, 'API Project 2', ?, ?, 'meiji/api-2', 'main', 'main', '', '', '[]', '{}', 'draft', ?, ?)").run(companyId, join(root, "repo2"), join(root, "worktrees2"), now, now);
  });

  const memberInvitation = auth.inviteUser(adminId, { displayName: "Member User" });
  const memberOptions = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: memberInvitation.token } });
  const memberEnrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: memberInvitation.token, challengeId: memberOptions.json().challengeId, response: { id: "member-passkey", type: "public-key" } } });
  const memberSetCookie = memberEnrolled.headers["set-cookie"];
  const memberCookieValues = Array.isArray(memberSetCookie) ? memberSetCookie : typeof memberSetCookie === "string" ? [memberSetCookie] : [];
  memberCookie = memberCookieValues.map((setCookie) => setCookie.split(";", 1)[0] ?? "").find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
});

afterEach(async () => {
  await app.close();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("admin CRUD lifecycle: create, list, scope replacement, pairing reissue, rotation, revocation", async () => {
  // 1. Create
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/admin/hermes-agents",
    headers: { cookie, origin },
    payload: { name: "Hermes Agent 1", companyId, projectIds: ["project_api"] },
  });
  expect(createResponse.statusCode).toBe(201);
  const created = createResponse.json() as { agent: { id: string; name: string; status: string; projectIds: string[] }; pairingCode: string; expiresAt: string };
  expect(created.agent.name).toBe("Hermes Agent 1");
  expect(created.agent.status).toBe("pending");
  expect(created.agent.projectIds).toEqual(["project_api"]);
  expect(created.pairingCode).toMatch(/^fhp_/);

  // 2. List
  const listResponse = await app.inject({
    method: "GET",
    url: "/api/admin/hermes-agents",
    headers: { cookie, origin },
  });
  expect(listResponse.statusCode).toBe(200);
  const listBody = listResponse.json() as { agents: Array<{ id: string; name: string; status: string }> };
  expect(listBody.agents).toHaveLength(1);
  expect(listBody.agents[0]!.id).toBe(created.agent.id);

  // 3. Replace projects scope
  const scopeResponse = await app.inject({
    method: "PUT",
    url: `/api/admin/hermes-agents/${created.agent.id}/projects`,
    headers: { cookie, origin },
    payload: { projectIds: ["project_api", "project_api_2"] },
  });
  expect(scopeResponse.statusCode).toBe(200);
  expect(scopeResponse.json().agent.projectIds).toEqual(["project_api", "project_api_2"]);

  // 4. Reissue initial pairing code
  const reissueResponse = await app.inject({
    method: "POST",
    url: `/api/admin/hermes-agents/${created.agent.id}/pairing-code`,
    headers: { cookie, origin },
    payload: {},
  });
  expect(reissueResponse.statusCode).toBe(200);
  const reissued = reissueResponse.json() as { pairingCode: string; expiresAt: string };
  expect(reissued.pairingCode).toMatch(/^fhp_/);
  expect(reissued.pairingCode).not.toBe(created.pairingCode);

  // 5. Exchange pairing code
  const pairResponse = await app.inject({
    method: "POST",
    url: "/api/hermes/pairing/exchange",
    payload: { pairingCode: reissued.pairingCode, profileId: "profile-test-1" },
  });
  expect(pairResponse.statusCode).toBe(200);
  const paired = pairResponse.json() as { credential: string; agent: { id: string; status: string; profileId: string } };
  expect(paired.agent.status).toBe("paired");
  expect(paired.agent.profileId).toBe("profile-test-1");
  expect(paired.credential).toMatch(/^fha_/);

  // 6. Rotate
  const rotateResponse = await app.inject({
    method: "POST",
    url: `/api/admin/hermes-agents/${created.agent.id}/rotate`,
    headers: { cookie, origin },
    payload: {},
  });
  expect(rotateResponse.statusCode).toBe(200);
  const rotated = rotateResponse.json() as { pairingCode: string; expiresAt: string };
  expect(rotated.pairingCode).toMatch(/^fhp_/);

  // Exchange rotation code via alternative /api/hermes/pair alias
  const pairRotate = await app.inject({
    method: "POST",
    url: "/api/hermes/pair",
    payload: { pairingCode: rotated.pairingCode, profileId: "profile-test-1" },
  });
  expect(pairRotate.statusCode).toBe(200);

  // 7. Revoke
  const revokeResponse = await app.inject({
    method: "POST",
    url: `/api/admin/hermes-agents/${created.agent.id}/revoke`,
    headers: { cookie, origin },
    payload: {},
  });
  expect(revokeResponse.statusCode).toBe(204);

  // List reflects revoked status
  const finalList = await app.inject({
    method: "GET",
    url: "/api/admin/hermes-agents",
    headers: { cookie, origin },
  });
  expect(finalList.json().agents[0]!.status).toBe("revoked");
});

test("authorization guard: non-admin and unauthenticated callers are rejected", async () => {
  // Unauthenticated requests return 401
  const unauthList = await app.inject({ method: "GET", url: "/api/admin/hermes-agents" });
  expect(unauthList.statusCode).toBe(401);

  const unauthCreate = await app.inject({
    method: "POST",
    url: "/api/admin/hermes-agents",
    payload: { name: "Anon", companyId, projectIds: ["project_api"] },
  });
  expect(unauthCreate.statusCode).toBe(401);

  // Non-admin member requests return 404 (AuthService.requireAdmin throws 404)
  const memberList = await app.inject({
    method: "GET",
    url: "/api/admin/hermes-agents",
    headers: { cookie: memberCookie, origin },
  });
  expect(memberList.statusCode).toBe(404);

  const memberCreate = await app.inject({
    method: "POST",
    url: "/api/admin/hermes-agents",
    headers: { cookie: memberCookie, origin },
    payload: { name: "Member Attempt", companyId, projectIds: ["project_api"] },
  });
  expect(memberCreate.statusCode).toBe(404);
});
