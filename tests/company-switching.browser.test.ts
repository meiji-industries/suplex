import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAdapter } from "../src/github.js";
import { ProjectService } from "../src/projects.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from("registration").toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([4, 5, 6]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      return { challenge: Buffer.from("authentication").toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
};

const health = {
  temporal: async () => ({ id: "temporal" as const, label: "Temporal", status: "healthy" as const, summary: "Ready", details: {} }),
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Ready", details: {} }),
  worker: async () => ({ id: "worker" as const, label: "Worker", status: "healthy" as const, summary: "Ready", details: {} }),
  codexAuth: async () => ({ id: "codex-auth" as const, label: "Codex", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

function sessionCookie(response: { headers: OutgoingHttpHeaders }): { name: string; value: string } {
  const raw = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"];
  const [name, value] = (raw ?? "").split(";", 1)[0]?.split("=", 2) ?? [];
  return { name: name ?? "forge_session", value: value ?? "" };
}

test("switching company never renders the previous company's projects under the new company context", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-company-switch-browser-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const alphaRepository = join(repositoryRoot, "alpha");
  const betaRepository = join(repositoryRoot, "beta");
  const alphaWorktrees = join(worktreeRoot, "alpha");
  const betaWorktrees = join(worktreeRoot, "beta");
  await Promise.all([alphaRepository, betaRepository, alphaWorktrees, betaWorktrees].map((path) => mkdir(path, { recursive: true })));

  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111", repositoryRoot, worktreeRoot });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { github });
  const app = createApp({ config, auth, projects, health });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const invitation = auth.ensureBootstrapInvitation()!;
  const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "company-switch-admin", type: "public-key" } } });
  const cookie = sessionCookie(enrolled);
  const admin = (await auth.getUserBySession(cookie.value))!;
  const alpha = auth.createCompany(admin.id, "Alpha Company");
  const beta = auth.createCompany(admin.id, "Beta Company");
  const profile = projects.createProfile(admin.id, { name: "Switch profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const analyst = projects.createAgent(admin.id, { name: "Analyst", role: "analyst", profileId: profile.id });
  const implementer = projects.createAgent(admin.id, { name: "Implementer", role: "implementer", profileId: profile.id });
  const reviewer = projects.createAgent(admin.id, { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const projectInput = (name: string, repositoryPath: string, projectWorktreeRoot: string, repository: string) => ({ name, repositoryPath, worktreeRoot: projectWorktreeRoot, repository, baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { analyst: analyst.id, implementer: implementer.id, reviewer: reviewer.id } });
  await projects.createProject(admin.id, alpha.id, projectInput("Alpha-only project", alphaRepository, alphaWorktrees, "acme/alpha"));
  await projects.createProject(admin.id, beta.id, projectInput("Beta-only project", betaRepository, betaWorktrees, "acme/beta"));

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.addCookies([{ ...cookie, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/projects?company=${encodeURIComponent(alpha.id)}`);
    await page.getByText("Alpha-only project", { exact: true }).waitFor();
    await page.evaluate(({ betaId, alphaProject }) => {
      const state = window as Window & { __forgeCrossCompanyFlash?: boolean };
      state.__forgeCrossCompanyFlash = false;
      const observer = new MutationObserver(() => {
        if (new URL(window.location.href).searchParams.get("company") === betaId && document.body.innerText.includes(alphaProject)) state.__forgeCrossCompanyFlash = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, { betaId: beta.id, alphaProject: "Alpha-only project" });

    await page.getByRole("button", { name: "Switch company" }).click();
    const immediateState = await page.getByRole("menuitem", { name: /Beta Company/ }).evaluate((element) => {
      (element as HTMLElement).click();
      return { url: window.location.href, text: document.body.innerText };
    });
    expect(new URL(immediateState.url).searchParams.get("company")).toBe(beta.id);
    expect(immediateState.text).not.toContain("Alpha-only project");
    await page.getByText("Beta-only project", { exact: true }).waitFor();

    expect(await page.evaluate(() => (window as Window & { __forgeCrossCompanyFlash?: boolean }).__forgeCrossCompanyFlash)).toBe(false);
    expect(await page.getByText("Alpha-only project", { exact: true }).count()).toBe(0);
    await context.close();
  } finally {
    await browser.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a scoped not-found after membership removal selects another authorized company", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-company-reconcile-browser-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const alphaRepository = join(repositoryRoot, "alpha");
  const betaRepository = join(repositoryRoot, "beta");
  const alphaWorktrees = join(worktreeRoot, "alpha");
  const betaWorktrees = join(worktreeRoot, "beta");
  await Promise.all([alphaRepository, betaRepository, alphaWorktrees, betaWorktrees].map((path) => mkdir(path, { recursive: true })));

  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111", repositoryRoot, worktreeRoot });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { github });
  const app = createApp({ config, auth, projects, health });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const bootstrap = auth.ensureBootstrapInvitation()!;
  const bootstrapOptions = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: bootstrap.token } });
  const adminEnrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: bootstrap.token, challengeId: bootstrapOptions.json().challengeId, response: { id: "company-reconcile-admin", type: "public-key" } } });
  const adminCookie = sessionCookie(adminEnrolled);
  const admin = (await auth.getUserBySession(adminCookie.value))!;
  const alpha = auth.createCompany(admin.id, "Alpha Company");
  const beta = auth.createCompany(admin.id, "Beta Company");
  const profile = projects.createProfile(admin.id, { name: "Reconcile profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const analyst = projects.createAgent(admin.id, { name: "Analyst", role: "analyst", profileId: profile.id });
  const implementer = projects.createAgent(admin.id, { name: "Implementer", role: "implementer", profileId: profile.id });
  const reviewer = projects.createAgent(admin.id, { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const projectInput = (name: string, repositoryPath: string, projectWorktreeRoot: string, repository: string) => ({ name, repositoryPath, worktreeRoot: projectWorktreeRoot, repository, baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { analyst: analyst.id, implementer: implementer.id, reviewer: reviewer.id } });
  await projects.createProject(admin.id, alpha.id, projectInput("Alpha member project", alphaRepository, alphaWorktrees, "acme/member-alpha"));
  await projects.createProject(admin.id, beta.id, projectInput("Beta member project", betaRepository, betaWorktrees, "acme/member-beta"));

  const invitation = auth.inviteUser(admin.id, { displayName: "Company member" });
  const memberOptions = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: invitation.token } });
  const memberEnrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: invitation.token, challengeId: memberOptions.json().challengeId, response: { id: "company-reconcile-member", type: "public-key" } } });
  const memberCookie = sessionCookie(memberEnrolled);
  const member = (await auth.getUserBySession(memberCookie.value))!;
  auth.addMembership(admin.id, member.id, alpha.id);
  auth.addMembership(admin.id, member.id, beta.id);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.addCookies([{ ...memberCookie, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    let revoked = false;
    await page.route(`**/api/companies/${alpha.id}/projects`, async (route) => {
      if (!revoked) {
        revoked = true;
        const response = await app.inject({ method: "DELETE", url: `/api/admin/companies/${alpha.id}/members/${member.id}`, headers: { cookie: `${adminCookie.name}=${adminCookie.value}`, origin: config.reachableAddress } });
        expect(response.statusCode).toBe(204);
      }
      await route.continue();
    });

    await page.goto(`${baseUrl}/projects?company=${encodeURIComponent(alpha.id)}`);
    await page.getByText("Beta member project", { exact: true }).waitFor();

    expect(new URL(page.url()).searchParams.get("company")).toBe(beta.id);
    expect(await page.evaluate(() => window.localStorage.getItem("forge.activeCompanyId"))).toBe(beta.id);
    expect(await page.getByText("Alpha member project", { exact: true }).count()).toBe(0);

    const finalRemoval = await app.inject({ method: "DELETE", url: `/api/admin/companies/${beta.id}/members/${member.id}`, headers: { cookie: `${adminCookie.name}=${adminCookie.value}`, origin: config.reachableAddress } });
    expect(finalRemoval.statusCode).toBe(204);
    await page.reload();
    await page.getByText("No company access. Ask an administrator to assign a company.", { exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.has("company")).toBe(false);
    expect(await page.evaluate(() => window.localStorage.getItem("forge.activeCompanyId"))).toBeNull();
    await context.close();
  } finally {
    await browser.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
