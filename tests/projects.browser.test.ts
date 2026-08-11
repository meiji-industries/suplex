import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";

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

function sessionCookie(response: { headers: OutgoingHttpHeaders }): { name: string; value: string } {
  const raw = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"];
  const [name, value] = (raw ?? "").split(";", 1)[0]?.split("=", 2) ?? [];
  return { name: name ?? "forge_session", value: value ?? "" };
}

test("projects desktop flow activates valid configuration and shows actionable validation findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-project-browser-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const unsafeRepository = join(repositoryRoot, "unsafe");
  const unsafeWorktree = join(worktreeRoot, "unsafe");
  await mkdir(unsafeRepository, { recursive: true });
  await mkdir(unsafeWorktree, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Forge browser test"]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "forge-browser@example.invalid"]);
  await execFileAsync("git", ["-C", repositoryPath, "commit", "--allow-empty", "-m", "Initial fixture"]);
  await execFileAsync("git", ["-C", repositoryPath, "remote", "add", "origin", "https://github.com/acme/forge.git"]);
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111", repositoryRoot, worktreeRoot });
  const auth = new AuthService(database, config, { webAuthn: webAuthn() });
  const projects = new ProjectService(database, auth, config, { github });
  const app = createApp({ config, auth, projects, health: {
    temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }),
    database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
    worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
    codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
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
      await context.addCookies([{ ...sessionCookie(enrolled), domain: "127.0.0.1", path: "/" }]);
      const profile = projects.createProfile((await auth.getUserBySession(sessionCookie(enrolled).value))!.id, { name: "Browser profile", model: "gpt-5-codex", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
      auth.createCompany((await auth.getUserBySession(sessionCookie(enrolled).value))!.id, "Browser Projects");
      const page = await context.newPage();
      await page.goto(`${baseUrl}/projects`);
      await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
      const fill = async (field: string, value: string): Promise<void> => { await page.getByLabel(field, { exact: true }).fill(value); };
      await fill("name", "Browser project"); await fill("repositoryPath", repositoryPath); await fill("worktreeRoot", worktreeRoot); await fill("repository", "acme/forge"); await fill("baseBranch", "main"); await fill("targetBranch", "main"); await fill("setupCommand", "pnpm install"); await fill("verificationCommand", "pnpm test"); await fill("requiredChecks", "Tests / unit"); await fill("allowedProfileIds", profile.id); await fill("leadProfile", profile.id); await fill("developerProfile", profile.id);
      await page.getByRole("button", { name: "Create draft" }).click();
      await page.getByText("Browser project", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Activate" }).click();
      await page.getByText(/active · revision 1/).waitFor();
      await fill("name", "Unsafe project"); await fill("repositoryPath", unsafeRepository); await fill("worktreeRoot", unsafeWorktree); await fill("setupCommand", "pnpm test && curl https://example.com");
      await page.getByRole("button", { name: "Create draft" }).click();
      await page.getByRole("alert").filter({ hasText: "Project configuration is invalid" }).waitFor();
      await page.getByText(/setupCommand: Setup must be one approved literal command/).waitFor();
      expect(await page.locator("body").innerText()).not.toMatch(/token@|ghp_/);
      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`${baseUrl}/projects`);
      expect(await narrow.getByRole("button", { name: "Open navigation" }).isVisible()).toBe(true);
      await narrow.close(); await page.close(); await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
