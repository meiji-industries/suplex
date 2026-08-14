import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { CapacityManager } from "../src/capacity.js";

function webAuthn(): WebAuthnAdapter {
  let sequence = 0;
  return {
    async generateRegistrationOptions(input) { sequence += 1; return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from(`registration-${sequence}`).toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: Buffer.from("authentication").toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
  async listChecks() { return [{ name: "Tests / unit", status: "completed", conclusion: "success" }]; },
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

test("project API activates valid configuration, redacts typed failures, and preserves company scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-project-api-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111", repositoryRoot, worktreeRoot });
  const auth = new AuthService(database, config, { webAuthn: webAuthn() });
  const projects = new ProjectService(database, auth, config, {
    github,
    localRepository: { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } },
    repositoryProvisioner: { async ensure(input) { await mkdir(input.repositoryPath, { recursive: true }); await mkdir(input.worktreeRoot, { recursive: true }); } },
  });
  const app = createApp({ config, auth, projects, capacity: new CapacityManager(database, config), health: {
    temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }),
    database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
    worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
    codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
    ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "admin-project-api", type: "public-key" } } });
    const adminCookie = sessionCookie(enrolled);
    const origin = config.reachableAddress;
    const company = (await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: adminCookie, origin }, payload: { name: "Project Company" } })).json() as { id: string };
    const otherCompany = (await app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: adminCookie, origin }, payload: { name: "Other Project Company" } })).json() as { id: string };
    const profile = (await app.inject({ method: "POST", url: "/api/admin/profiles", headers: { cookie: adminCookie, origin }, payload: { name: "API profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 } })).json() as { id: string; capacity: number; effectiveCapacity: number };
    expect(profile).toMatchObject({ capacity: 2, effectiveCapacity: 2 });
    const createAgent = async (name: string, role: "analyst" | "implementer" | "reviewer") => (await app.inject({ method: "POST", url: "/api/admin/agents", headers: { cookie: adminCookie, origin }, payload: { name, role, profileId: profile.id } })).json() as { id: string };
    const analyst = await createAgent("Analyst", "analyst");
    const implementer = await createAgent("Implementer", "implementer");
    const reviewer = await createAgent("Reviewer", "reviewer");
    const inheritedCapacity = await app.inject({ method: "PATCH", url: `/api/admin/profiles/${profile.id}/capacity`, headers: { cookie: adminCookie, origin }, payload: { capacity: null } });
    expect(inheritedCapacity.json()).toMatchObject({ capacity: null, effectiveCapacity: config.externalTurnCapacity });
    const restoredCapacity = await app.inject({ method: "PATCH", url: `/api/admin/profiles/${profile.id}/capacity`, headers: { cookie: adminCookie, origin }, payload: { capacity: 3 } });
    expect(restoredCapacity.json()).toMatchObject({ capacity: 3, effectiveCapacity: 3 });
    const capacityLanes = await app.inject({ method: "GET", url: "/api/admin/capacity", headers: { cookie: adminCookie } });
    expect(capacityLanes.statusCode).toBe(200);
    expect(capacityLanes.json()).toMatchObject({ lanes: [expect.objectContaining({ profileId: profile.id, profileName: "API profile", capacity: 3, effectiveCapacity: 3, activeCount: 0, queuedCount: 0, rateLimitedCount: 0, oldestQueuedAt: null })] });
    expect(JSON.stringify(capacityLanes.json())).not.toMatch(/taskId|session|process|wrapper|worktree|command|artifact/i);
    const models = (await app.inject({ method: "GET", url: "/api/admin/models", headers: { cookie: adminCookie } })).json() as { models: Array<{ id: string; status: string }> };
    expect(models.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gpt-5.6-sol", status: "active" })]));
    const minimal = await app.inject({ method: "POST", url: `/api/companies/${otherCompany.id}/projects`, headers: { cookie: adminCookie, origin }, payload: { repositoryUrl: "git@github.com:meiji-industries/sampler.git" } });
    expect(minimal.statusCode).toBe(201);
    expect(minimal.json()).toMatchObject({ name: "sampler", repository: "meiji-industries/sampler", repositoryPath: await realpath(join(repositoryRoot, "meiji-industries", "sampler")), worktreeRoot: await realpath(join(worktreeRoot, "meiji-industries", "sampler")), baseBranch: "main", targetBranch: "main", status: "draft" });
    const invalidUrl = await app.inject({ method: "POST", url: `/api/companies/${otherCompany.id}/projects`, headers: { cookie: adminCookie, origin }, payload: { repositoryUrl: "https://token@github.com/meiji-industries/private.git" } });
    expect(invalidUrl.statusCode).toBe(422);
    expect(invalidUrl.json()).toMatchObject({ error: "GitHub repository URL is invalid", findings: [expect.objectContaining({ field: "repositoryUrl" })] });
    expect(JSON.stringify(invalidUrl.json())).not.toContain("token@");
    const configuration = { name: "Direct GitHub", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { analyst: analyst.id, implementer: implementer.id, reviewer: reviewer.id } };
    const draft = await app.inject({ method: "POST", url: `/api/companies/${company.id}/projects`, headers: { cookie: adminCookie, origin }, payload: configuration });
    expect(draft.statusCode).toBe(201);
    const project = draft.json() as { id: string; status: string };
    expect(project.status).toBe("draft");
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/checks`, headers: { cookie: adminCookie } })).json()).toEqual({ checks: [{ name: "Tests / unit", status: "completed", conclusion: "success" }] });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/repository-defaults`, headers: { cookie: adminCookie } })).json()).toEqual({ setupCommand: "pnpm install", verificationCommand: "pnpm test" });
    const activated = await app.inject({ method: "POST", url: `/api/projects/${project.id}/activate`, headers: { cookie: adminCookie, origin }, payload: {} });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ status: "active", configurationRevision: 1, repository: "acme/forge" });
    const invalid = await app.inject({ method: "POST", url: `/api/companies/${otherCompany.id}/projects`, headers: { cookie: adminCookie, origin }, payload: { ...configuration, name: "Unsafe", repositoryPath: join(repositoryRoot, "unsafe"), worktreeRoot: join(worktreeRoot, "unsafe"), repository: "https://token@github.com/acme/forge.git" } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ error: "Project configuration is invalid" });
    expect(JSON.stringify(invalid.json())).not.toContain("token@");
    expect((await app.inject({ method: "GET", url: `/api/companies/${otherCompany.id}/projects`, headers: { cookie: adminCookie, origin } })).json().projects).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: { cookie: adminCookie, origin } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/admin/companies/${company.id}/status/paused`, headers: { cookie: adminCookie, origin }, payload: {} })).json()).toMatchObject({ status: "paused" });
    expect((await app.inject({ method: "POST", url: `/api/companies/${company.id}/projects`, headers: { cookie: adminCookie, origin }, payload: configuration })).statusCode).toBe(409);
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
