import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAdapter } from "../src/github.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { IssueProjectionEventSchema } from "../src/temporal/issue-contracts.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createWorkflowPortFake } from "./fakes/workflow-port.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "browser-board", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "browser-board-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("the task board shows its workflow lanes on desktop and narrow viewports", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-board-browser-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Browser Board Company");
  const profile = projects.createProfile("admin-1", { name: "Browser board profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const project = await projects.createProject("admin-1", company.id, { name: "Browser board project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id } });
  const active = await projects.activateProject("admin-1", project.id);
  const workflow = createWorkflowPortFake({ companyId: company.id, projectId: active.id, projectRevisionId: active.activeRevisionId!, projectState: (state) => { database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state })); return state; } });
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address(); if (!address || typeof address !== "object") throw new Error("Browser board server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "browser-board-admin", type: "public-key" } } });
    const values = Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""];
    const cookie = values.find((value) => value.split("=", 1)[0] === SESSION_COOKIE_NAME)?.split(";", 1)[0] ?? "";
    const csrf = values.find((value) => value.split("=", 1)[0] === CSRF_COOKIE_NAME)?.split(";", 1)[0] ?? "";
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookie.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: csrf.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/tasks?company=${encodeURIComponent(company.id)}&new=1`);
      await page.getByRole("dialog", { name: "New task" }).waitFor();
      await page.getByRole("combobox", { name: "Project" }).click(); await page.getByRole("option", { name: "Browser board project" }).click();
      await page.getByLabel("Task title", { exact: true }).fill("Browser board task"); await page.getByLabel("Task description", { exact: true }).fill("A board fixture."); await page.getByRole("button", { name: "Create task" }).click(); await page.waitForURL(/\/tasks\/[^/?]+/);
      await page.getByRole("link", { name: "Tasks", exact: true }).click(); await page.waitForURL(/\/tasks\?company=/); await page.locator("[data-task-list]").getByText("Browser board task", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Board", exact: true }).click(); await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
      expect(await page.getByText("Backlog", { exact: true }).isVisible()).toBe(true); for (const phase of ["Planning", "Development", "Reviewing", "Waiting for CI", "Final review", "Done"]) expect(await page.getByText(phase, { exact: true }).isVisible()).toBe(true);
      const boardTask = page.getByRole("button", { name: /Browser board task/ }); await boardTask.waitFor(); expect(await boardTask.isVisible()).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
      expect(await page.getByText("Backlog", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /Browser board task/ }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
