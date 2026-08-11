import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import type { IssueWorkflowInput, IssueWorkflowState, StartPlanningInput } from "../src/temporal/issue-contracts.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "browser-task", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "base", targetSha: "target" }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("task desktop flow attaches an image, shows Backlog, starts planning, and remains usable on narrow viewports", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-browser-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const imagePath = join(root, "evidence.png"); await writeFile(imagePath, "browser-image");
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Browser Tasks");
  const profile = projects.createProfile("admin-1", { name: "Browser task profile", model: "gpt-5-codex", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const project = await projects.createProject("admin-1", company.id, { name: "Browser task project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id } });
  await projects.activateProject("admin-1", project.id);
  const workflow: IssueWorkflowPort = { async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) { return { workflowId: input.workflowId!, runId: "run" }; }, async startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return { workflowId, companyId: company.id, projectId: project.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: project.activeRevisionId!, phase: "planning", revision: input.expectedRevision + 1, owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null }; } };
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Browser task server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invitation = auth.createRecoveryInvitation();
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "browser-task-admin", type: "public-key" } } });
    const rawCookie = enrolled.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";", 1)[0] ?? "";
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies([{ name: "forge_session", value: cookie.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/tasks`);
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      await page.locator("#task-company").selectOption(company.id);
      await page.locator("#task-project").selectOption(project.id);
      await page.getByLabel("Task title", { exact: true }).fill("Browser task");
      await page.getByLabel("Task description", { exact: true }).fill("## Browser brief\n\nImage attached.");
      await page.getByLabel("Task images", { exact: true }).setInputFiles(imagePath);
      await page.getByRole("button", { name: "Create task" }).click();
      await page.getByRole("button", { name: /Browser task/ }).waitFor();
      await page.getByRole("button", { name: "Start planning", exact: true }).waitFor();
      await page.getByRole("button", { name: "Start planning", exact: true }).click();
      await page.getByText(/planning · revision 1/).waitFor();
      await page.getByText("evidence.png", { exact: true }).waitFor();
      const narrow = await context.newPage(); await narrow.setViewportSize({ width: 390, height: 844 }); await narrow.goto(`${baseUrl}/tasks`); expect(await narrow.getByRole("button", { name: "Open navigation" }).isVisible()).toBe(true); await narrow.close(); await page.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
