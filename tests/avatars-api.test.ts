import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const health = {
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  opencode: async () => ({ id: "opencode" as const, label: "OpenCode", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

const webAuthn: WebAuthnAdapter = {
  async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "avatar-registration", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
  async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
  async generateAuthenticationOptions(input) { return { challenge: "avatar-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((c) => ({ type: "public-key" as const, ...c })), userVerification: "required" }; },
  async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
};

// Smallest valid PNG: 1x1 transparent pixel.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("avatars share one table, one directory, and one image route across users, companies, projects, and agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-avatars-api-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new ForgeDatabase(config.databasePath);
  const auth = new AuthService(database, config, { webAuthn });
  const app = createApp({ config, auth, database, health });
  try {
    const admin = auth.developmentSignIn();
    const cookie = `${SESSION_COOKIE_NAME}=${admin.sessionToken}`;
    const headers = { cookie, origin: config.reachableAddress };
    const company = auth.createCompany(admin.user.id, "Avatar Company");
    const now = new Date().toISOString();
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project_avatar', ?, 'Avatar Project', ?, ?, 'meiji/avatar', 'main', '', '', ?, ?)").run(company.id, join(root, "repo"), join(root, "worktrees"), now, now);
    });
    const member = auth.inviteUser(admin.user.id, { displayName: "Member" });
    const options = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: member.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: member.token, challengeId: options.json().challengeId, response: { id: "member-passkey", type: "public-key" } } });
    const memberCookie = (Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [String(enrolled.headers["set-cookie"])]).map((value) => value.split(";", 1)[0] ?? "").find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
    const memberHeaders = { cookie: memberCookie, origin: config.reachableAddress };
    const memberId = (await app.inject({ method: "GET", url: "/api/auth/me", headers: memberHeaders })).json().user.id as string;

    expect((await app.inject({ method: "GET", url: "/api/avatars", headers })).json()).toEqual({ avatars: {} });

    // Shape only, no image: the record lists a shape and no image version.
    const shape = await app.inject({ method: "PUT", url: `/api/avatars/${company.id}`, headers, payload: { shape: "circle" } });
    expect(shape.json()).toEqual({ shape: "circle", imageVersion: null });

    // Image upload on a project by an admin, on the user by the member.
    const upload = await app.inject({ method: "PUT", url: "/api/avatars/project_avatar", headers, payload: { image: { mimeType: "image/png", base64: png.toString("base64") } } });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({ shape: null, imageVersion: expect.any(String) });
    const own = await app.inject({ method: "PUT", url: `/api/avatars/${memberId}`, headers: memberHeaders, payload: { shape: "square", image: { mimeType: "image/png", base64: png.toString("base64") } } });
    expect(own.statusCode).toBe(200);

    // The image route serves the upload with its content type.
    const image = await app.inject({ method: "GET", url: "/api/avatars/project_avatar", headers });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.equals(png)).toBe(true);
    // Without an upload the route falls back to the DiceBear default for the owner kind.
    const fallback = await app.inject({ method: "GET", url: `/api/avatars/${admin.user.id}`, headers });
    expect(fallback.statusCode).toBe(302);
    expect(fallback.headers.location).toContain("pixel-art-neutral");

    const directory = (await app.inject({ method: "GET", url: "/api/avatars", headers })).json().avatars as Record<string, unknown>;
    expect(Object.keys(directory).sort()).toEqual([company.id, memberId, "project_avatar"].sort());

    // Authorization: members cannot edit companies or other users; unknown owners are 404; bad images are rejected.
    expect((await app.inject({ method: "PUT", url: `/api/avatars/${company.id}`, headers: memberHeaders, payload: { shape: "square" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/avatars/${admin.user.id}`, headers: memberHeaders, payload: { shape: "square" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/avatars/nobody", headers, payload: { shape: "square" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/avatars/project_avatar", headers, payload: { image: { mimeType: "image/png", base64: Buffer.from("not a png").toString("base64") } } })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/avatars/project_avatar" })).statusCode).toBe(401);

    // Deleting the image and clearing the shape removes the record.
    expect((await app.inject({ method: "PUT", url: "/api/avatars/project_avatar", headers, payload: { image: null } })).json()).toEqual({ shape: null, imageVersion: null });
    expect((await app.inject({ method: "GET", url: "/api/avatars", headers })).json().avatars).not.toHaveProperty("project_avatar");
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
