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
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

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

test("projects desktop flow activates valid configuration and shows actionable validation findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-project-browser-test-"));
  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const unsafeRepository = join(repositoryRoot, "unsafe");
  const unsafeWorktree = join(worktreeRoot, "unsafe");
  const narrowRepository = join(repositoryRoot, "narrow");
  const narrowWorktree = join(worktreeRoot, "narrow");
  await mkdir(unsafeRepository, { recursive: true });
  await mkdir(unsafeWorktree, { recursive: true });
  await mkdir(narrowRepository, { recursive: true });
  await mkdir(narrowWorktree, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);

  await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Forge browser test"]);
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "forge-browser@example.invalid"]);
  await execFileAsync("git", ["-C", repositoryPath, "commit", "--allow-empty", "-m", "Initial fixture"]);
  await execFileAsync("git", ["-C", repositoryPath, "remote", "add", "origin", "https://github.com/acme/forge.git"]);
  await execFileAsync("git", ["init", "-b", "main", narrowRepository]);
  await execFileAsync("git", ["-C", narrowRepository, "config", "user.name", "Forge browser test"]);
  await execFileAsync("git", ["-C", narrowRepository, "config", "user.email", "forge-browser@example.invalid"]);
  await execFileAsync("git", ["-C", narrowRepository, "commit", "--allow-empty", "-m", "Narrow fixture"]);
  await execFileAsync("git", ["-C", narrowRepository, "remote", "add", "origin", "https://github.com/acme/narrow.git"]);

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
      const session = responseCookie(enrolled, SESSION_COOKIE_NAME);
      const csrf = responseCookie(enrolled, CSRF_COOKIE_NAME);
      await context.addCookies([{ ...session, domain: "127.0.0.1", path: "/" }, { ...csrf, domain: "127.0.0.1", path: "/" }]);
      const profile = projects.createProfile((await auth.getUserBySession(session.value))!.id, { name: "Browser profile", model: "gpt-5-codex", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
      auth.createCompany((await auth.getUserBySession(session.value))!.id, "Browser Projects");
      const page = await context.newPage();
      await page.goto(`${baseUrl}/projects`);
      await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
      const fill = async (field: string, value: string): Promise<void> => { await page.getByLabel(field, { exact: true }).fill(value); };
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await fill("Project name", "Browser project"); await fill("Repository path", repositoryPath); await fill("Worktree root", worktreeRoot); await fill("GitHub repository (owner/name)", "acme/forge"); await fill("Base branch", "main"); await fill("Target branch", "main"); await fill("Setup command", "pnpm install"); await fill("Verification command", "pnpm test"); await fill("Required checks (comma separated)", "Tests / unit"); await fill("Allowed profiles (comma separated)", profile.id); await fill("Lead default", profile.id); await fill("Developer default", profile.id);
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByText("Browser project", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Activate" }).click();
      await page.getByText(/active · revision 2/).waitFor();
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await fill("Project name", "Unsafe project"); await fill("Repository path", unsafeRepository); await fill("Worktree root", unsafeWorktree); await fill("Setup command", "pnpm test && curl https://example.com");
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByRole("alert").filter({ hasText: "Project configuration is invalid" }).waitFor();
      await page.getByText(/setupCommand: Setup must be one approved literal command/).waitFor();
      expect(await page.locator("body").innerText()).not.toMatch(/token@|ghp_/);
      await page.getByRole("button", { name: "Cancel" }).click();
      const projectsNav = page.getByRole("link", { name: "Projects" }).first();
      expect(await projectsNav.getAttribute("aria-current")).toBe("page");
      const healthNav = page.getByRole("link", { name: "Host health" }).first();
      expect(await healthNav.getAttribute("aria-current")).toBe(null);

      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`${baseUrl}/projects`);
      await narrow.getByRole("button", { name: "Open navigation" }).waitFor();
      await narrow.getByRole("button", { name: "Open navigation" }).click();
      const narrowNav = narrow.getByRole("dialog");
      const narrowProjects = narrowNav.getByRole("link", { name: "Projects" });
      expect(await narrowProjects.getAttribute("aria-current")).toBe("page");
      await narrowNav.getByRole("button", { name: "Close navigation" }).click();
      await narrow.getByRole("button", { name: "Create", exact: true }).click();
      await narrow.getByLabel("Project name").fill("Narrow project");
      await narrow.getByLabel("Repository path").fill(narrowRepository);
      await narrow.getByLabel("Worktree root").fill(narrowWorktree);
      await narrow.getByLabel("GitHub repository (owner/name)").fill("acme/narrow");
      await narrow.getByLabel("Lead default").fill(profile.id);
      await narrow.getByLabel("Developer default").fill(profile.id);
      await narrow.getByLabel("Setup command").fill("pnpm install");
      await narrow.getByLabel("Verification command").fill("pnpm test");
      await narrow.getByLabel("Required checks (comma separated)").fill("Tests / unit");
      await narrow.getByLabel("Allowed profiles (comma separated)").fill(profile.id);
      await narrow.getByLabel("Base branch").fill("main");
      await narrow.getByLabel("Target branch").fill("main");
      // The form submits via the dialog footer button; pressing Enter in the last input also submits.
      await narrow.getByLabel("Target branch").press("Enter");
      await narrow.getByText("Narrow project", { exact: true }).waitFor();
      await narrow.getByRole("button", { name: "Activate" }).click();
      await narrow.getByText(/active · revision 2/).waitFor();
      await expect.poll(async () => narrow.getByText("Browser project", { exact: true }).isVisible({ timeout: 1000 })).toBe(true);
      await expect.poll(async () => narrow.getByRole("button", { name: "Pause" }).first().isVisible({ timeout: 1000 })).toBe(true);
      await expect.poll(async () => narrow.getByRole("button", { name: "Archive" }).first().isVisible({ timeout: 1000 })).toBe(true);
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
