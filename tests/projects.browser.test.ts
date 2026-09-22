import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/identity/auth.js";
import { createApp } from "../src/app.js";
import { AgentProfileService } from "../src/profiles/agent-profiles.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { ProjectService } from "../src/projects/projects.js";
import type { GithubAdapter } from "../src/integrations/github/client.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/identity/auth-identifiers.js";

const execFileAsync = promisify(execFile);

function webAuthn(): WebAuthnAdapter {
  let sequence = 0;
  return {
    async generateRegistrationOptions(input) { sequence += 1; return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from(`registration-${sequence}`).toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([4, 5, 6]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: Buffer.from("authentication").toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; },
};

function responseCookie(response: { headers: OutgoingHttpHeaders }, name: string): { name: string; value: string } {
  const values = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"] ?? ""];
  const raw = values.find((value) => value.split("=", 1)[0] === name) ?? "";
  const [cookieName, cookieValue] = raw.split(";", 1)[0]?.split("=", 2) ?? [];
  return { name: cookieName ?? name, value: cookieValue ?? "" };
}

test("projects desktop flow creates a project and opens its configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-project-browser-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "acme", "forge");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);

  await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Forge browser test"]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "forge-browser@example.invalid"]);
  await execFileAsync("git", ["-c", "commit.gpgsign=false", "-C", repositoryPath, "commit", "--allow-empty", "-m", "Initial fixture"]);
  await execFileAsync("git", ["-C", repositoryPath, "remote", "add", "origin", "https://github.com/acme/forge.git"]);

  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111", repositoryRoot, worktreeRoot });
  const auth = new AuthService(database, config, { webAuthn: webAuthn() });
  const projects = new ProjectService(database, auth, config, {
    github,
    repositoryProvisioner: { async ensure(input) { await mkdir(input.repositoryPath, { recursive: true }); await mkdir(input.worktreeRoot, { recursive: true }); } },
  });
  const app = createApp({ config, auth, projects, profiles: new AgentProfileService(database, auth), health: {
    database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
    ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "project-browser-admin", type: "public-key" } } });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      const session = responseCookie(enrolled, SESSION_COOKIE_NAME);
      const csrf = responseCookie(enrolled, CSRF_COOKIE_NAME);
      await context.addCookies([{ ...session, domain: "127.0.0.1", path: "/" }, { ...csrf, domain: "127.0.0.1", path: "/" }]);
      const adminId = (await auth.getUserBySession(session.value))!.id;
      auth.createCompany(adminId, "Browser Projects");
      const page = await context.newPage();
      await page.goto(`${baseUrl}/projects`);
      await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
      const newProject = page.getByRole("button", { name: "New project", exact: true });
      await newProject.click();
      await page.getByLabel("Repository URL", { exact: true }).fill("https://github.com/acme/forge.git");
      await page.getByRole("dialog", { name: "New project", exact: true }).getByRole("button", { name: "New project", exact: true }).click();
      await page.getByText("forge", { exact: true }).waitFor();
      const forgeProject = page.locator("article").filter({ hasText: "forge" });
      await forgeProject.getByRole("link", { name: "Configure" }).click();
      await page.reload();
      expect(await page.getByLabel("Base branch").inputValue()).toBe("main");
      await page.getByLabel("Project name").fill("Forge renamed");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await page.getByText("Saved", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Back to projects", exact: true }).click();
      await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
      await page.getByText("Forge renamed", { exact: true }).waitFor();
      await page.close();
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
