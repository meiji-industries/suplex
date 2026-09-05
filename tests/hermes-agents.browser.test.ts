import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";
import { afterEach, beforeEach, expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { HermesAgentService } from "../src/hermes-agents.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { AgentProfileService } from "../src/agent-profiles.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import type { GithubAdapter } from "../src/github.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      return {
        rp: { name: "Forge", id: input.rpId },
        user: { id: input.userId, name: input.userName, displayName: input.displayName },
        challenge: "browser-auth-challenge",
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        attestation: "none",
      };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      return {
        challenge: "browser-login-challenge",
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

const localRepository: LocalRepositoryAdapter = {
  async inspect(input) {
    return { canonicalPath: input.repositoryPath, remoteRepository: "meiji/browser-hermes", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) };
  },
};

const github: GithubAdapter = {
  async checkAuthentication() {},
  async getRepository(input) {
    return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` };
  },
};

function responseCookie(response: { headers: OutgoingHttpHeaders }, name: string): { name: string; value: string } {
  const values = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"] ?? ""];
  const raw = values.find((value) => value.split("=", 1)[0] === name) ?? "";
  const [cookieName, cookieValue] = raw.split(";", 1)[0]?.split("=", 2) ?? [];
  return { name: cookieName ?? name, value: cookieValue ?? "" };
}

let root: string;
let receiptsDir: string;
let database: ForgeDatabase;
let auth: AuthService;
let projects: ProjectService;
let tasks: TaskService;
let hermes: HermesAgentService;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let companyId: string;
let projectId: string;
let sessionCookie: { name: string; value: string };
let csrfCookie: { name: string; value: string };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-hermes-browser-test-"));
  receiptsDir = join(process.cwd(), ".scratch", "hermes-external-agent", "receipts");
  await mkdir(receiptsDir, { recursive: true });

  const repositoryRoot = join(root, "repositories");
  const worktreeRoot = join(root, "worktrees");
  const repositoryPath = join(repositoryRoot, "project1");
  const project1Worktrees = join(worktreeRoot, "project1");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(project1Worktrees, { recursive: true });

  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "commit.gpgsign", "false"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "# Browser test repo\n");
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "Initial commit"], repositoryPath);

  database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111", developmentAutoLogin: true });
  auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  projects = new ProjectService(database, auth, config, { localRepository, github });

  const admin = auth.ensureDevelopmentUser();
  const adminId = admin.id;
  const company = auth.createCompany(adminId, "Hermes Proof Company");
  companyId = company.id;
  auth.setCompanyIssueCode(adminId, companyId, "HPC");

  const profiles = new AgentProfileService(database, auth);
  const archived = profiles.create(adminId, { name: "Archived Root", role: "root", avatarSeed: "a".repeat(32), provider: "openai", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" });
  profiles.update(adminId, archived.id, { archived: true });

  const project = await projects.createProject(adminId, companyId, {
    name: "Proof Project",
    repositoryPath,
    worktreeRoot: project1Worktrees,
    repository: "meiji/browser-hermes",
    baseBranch: "main",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
    rootProfileId: "profile_native_root",
    workerProfileId: "profile_native_worker",
  });
  projectId = project.id;
  tasks = new TaskService(database, auth, projects, config);
  hermes = new HermesAgentService(database, auth);

  app = createApp({
    config,
    auth,
    projects,
    profiles,
    tasks,
    hermes,
    health: {
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
      opencode: async () => ({ id: "opencode", label: "OpenCode", status: "healthy", summary: "Configured", details: {} }),
      ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    },
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
  const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({
    method: "POST",
    url: "/api/auth/recovery/verify",
    payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "admin-passkey", type: "public-key" } },
  });

  sessionCookie = responseCookie(enrolled, SESSION_COOKIE_NAME);
  csrfCookie = responseCookie(enrolled, CSRF_COOKIE_NAME);
});

afterEach(async () => {
  await app.close();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("Hermes external agent full browser lifecycle at desktop and narrow viewports", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // 1. Desktop Context (1280x800)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.addCookies([
      { ...sessionCookie, domain: "127.0.0.1", path: "/" },
      { ...csrfCookie, domain: "127.0.0.1", path: "/" },
    ]);
    const page = await context.newPage();

    // Navigate to /admin/agents
    await page.goto(`${baseUrl}/admin/agents?company=${encodeURIComponent(companyId)}`);
    await page.waitForLoadState("networkidle");

    const internalTable = page.getByRole("table", { name: "Internal Agents" });
    expect(await internalTable.getByText("Internal agents", { exact: true }).isVisible()).toBe(true);
    const internalRows = await internalTable.locator("tbody tr").allTextContents();
    expect(internalRows.findIndex((text) => text.includes("Root"))).toBeLessThan(internalRows.findIndex((text) => text.includes("Archived Root")));
    expect(await internalTable.getByRole("row", { name: /Edit Root/i }).getByText("active", { exact: true }).isVisible()).toBe(true);
    expect(await internalTable.getByRole("row", { name: /Edit Archived Root/i }).getByText("archived", { exact: true }).isVisible()).toBe(true);
    const hermesTable = page.getByRole("table", { name: "Hermes Agents" });
    expect(await hermesTable.getByText("Hermes agents", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i }).count()).toBe(0);
    await page.screenshot({ path: join(receiptsDir, "01-agents-admin-desktop.png") });

    // Open New Hermes agent modal
    await page.getByRole("button", { name: "New Hermes agent" }).click();
    await page.getByRole("dialog", { name: "New Hermes agent" }).waitFor();
    expect(await page.getByRole("dialog", { name: "New Hermes agent" }).isVisible()).toBe(true);

    await page.getByLabel("Agent name").fill("SRE Hermes Bot");
    await page.getByText("Proof Project").click();
    await page.getByRole("button", { name: "Create Hermes agent" }).click();

    const pairingDialog = page.getByRole("dialog", { name: "Pairing code" });
    await pairingDialog.waitFor();
    expect(await pairingDialog.isVisible()).toBe(true);
    const copyToContinueButton = pairingDialog.getByRole("button", { name: "Copy to Continue" });
    expect(await copyToContinueButton.isEnabled()).toBe(false);
    expect(await pairingDialog.getByLabel("Hermes profile name").inputValue()).toBe("default");
    const pairingCodeText = (await pairingDialog.locator("button.font-mono").last().innerText()).trim();
    expect(/^fhp_/.test(pairingCodeText)).toBe(true);
    expect(page.url().includes(pairingCodeText)).toBe(false);

    const copyInstructions = pairingDialog.getByRole("button", { name: "Copy setup instructions" });
    expect(await copyInstructions.isVisible()).toBe(true);
    expect(await copyInstructions.locator("svg.lucide-copy").count()).toBe(1);
    expect(await copyInstructions.locator("svg.lucide-check").count()).toBe(0);
    await copyInstructions.focus();
    expect(await copyInstructions.evaluate((element) => element === document.activeElement)).toBe(true);
    await copyInstructions.click();
    await copyInstructions.locator("svg.lucide-check").waitFor();
    expect(await copyInstructions.locator("svg.lucide-check").count()).toBe(1);
    expect(await copyInstructions.locator("svg.lucide-copy").count()).toBe(0);
    const copiedStatus = page.getByText("Copied to Clipboard", { exact: true });
    expect(await copiedStatus.count()).toBe(1);
    const copiedInstructions = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedInstructions.includes("# Connect this Hermes profile to Forge")).toBe(true);
    expect(copiedInstructions.includes(baseUrl)).toBe(true);
    expect(copiedInstructions.includes(pairingCodeText)).toBe(true);
    expect(copiedInstructions.includes("/api/hermes/pairing/exchange")).toBe(true);
    expect(copiedInstructions.includes("\"profileId\": \"default\"")).toBe(true);
    expect(copiedInstructions.includes("FORGE_BASE_URL")).toBe(true);
    expect(copiedInstructions.includes("FORGE_AGENT_CREDENTIAL")).toBe(true);
    expect(copiedInstructions.includes("$HERMES_HOME/skills/forge/")).toBe(true);
    expect(copiedInstructions.includes("POST /api/hermes/tasks")).toBe(true);
    expect(copiedInstructions.includes("GET /api/hermes/tasks/{taskId}")).toBe(true);
    expect(copiedInstructions.includes("Hermes connectivity confirmed")).toBe(true);
    expect(copiedInstructions.includes("forge-connectivity-")).toBe(true);
    expect(copiedInstructions.includes("do not start this task")).toBe(true);
    expect(copiedInstructions.includes("forge-pairing-check")).toBe(false);
    expect(copiedInstructions.includes("Never echo the pairing code or bearer credential")).toBe(true);

    const copyPairingCode = pairingDialog.getByRole("button", { name: "Copy pairing code" });
    expect(await copyPairingCode.isVisible()).toBe(true);
    await copyPairingCode.click();
    const copiedPairingCode = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedPairingCode === pairingCodeText).toBe(true);
    expect(await copyInstructions.locator("svg.lucide-check").count()).toBe(1);
    const continueButton = pairingDialog.getByRole("button", { name: "Continue" });
    expect(await continueButton.isEnabled()).toBe(true);

    const pairingReceipt = join(receiptsDir, "02-pairing-modal-desktop-masked.png");
    await page.screenshot({ path: pairingReceipt, mask: [pairingDialog.locator("button.font-mono").last().locator("span").first()] });
    expect((await readFile(pairingReceipt)).includes(Buffer.from(pairingCodeText))).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await copyInstructions.isVisible()).toBe(true);
    expect(await continueButton.isEnabled()).toBe(true);
    expect(await pairingDialog.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const narrowPairingReceipt = join(receiptsDir, "02b-pairing-modal-narrow-masked.png");
    await page.screenshot({ path: narrowPairingReceipt, mask: [pairingDialog.locator("button.font-mono").last().locator("span").first()] });
    expect((await readFile(narrowPairingReceipt)).includes(Buffer.from(pairingCodeText))).toBe(false);
    await page.setViewportSize({ width: 1280, height: 800 });

    await continueButton.click();
    await pairingDialog.waitFor({ state: "hidden" });

    const agentRow = page.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i });
    await agentRow.waitFor();
    const pendingStatus = agentRow.getByText(/^Pending until /);
    expect(await pendingStatus.isVisible()).toBe(true);
    expect(await pendingStatus.evaluate((element) => getComputedStyle(element.parentElement!).whiteSpace)).toBe("nowrap");
    expect(await agentRow.getByText("· exp", { exact: false }).count()).toBe(0);
    expect(await agentRow.getByText("pending", { exact: true }).count()).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await hermesTable.evaluate((element) => element.parentElement!.scrollWidth > element.parentElement!.clientWidth)).toBe(true);
    expect(await pendingStatus.evaluate((element) => getComputedStyle(element.parentElement!).whiteSpace)).toBe("nowrap");
    await pendingStatus.scrollIntoViewIfNeeded();
    expect(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: join(receiptsDir, "02c-pending-agent-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    const pairResponse = await app.inject({
      method: "POST",
      url: "/api/hermes/pairing/exchange",
      payload: { pairingCode: pairingCodeText, profileId: "profile-sre-hermes" },
    });
    expect(pairResponse.statusCode).toBe(200);
    const { credential } = pairResponse.json() as { credential: string };
    expect(/^fha_/.test(credential)).toBe(true);

    await page.reload();
    await page.waitForLoadState("networkidle");
    const pairedRow = page.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i });
    await pairedRow.waitFor();
    expect(await pairedRow.getByText(/paired/i).isVisible()).toBe(true);
    expect(await pairedRow.getByText("Proof Project").isVisible()).toBe(true);
    expect(await pairedRow.getByText(/Never/i).isVisible()).toBe(true);
    await page.screenshot({ path: join(receiptsDir, "03-paired-agent-desktop.png") });

    await page.getByRole("button", { name: "SRE Hermes Bot actions" }).click();
    await page.getByRole("menuitem", { name: "Edit project scope" }).click();
    const scopeDialog = page.getByRole("dialog", { name: "Edit allowed projects" });
    await scopeDialog.waitFor();
    await scopeDialog.getByText("Proof Project").click();
    await scopeDialog.getByRole("button", { name: "Save the project access" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    const unscopedRow = page.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i });
    expect(await unscopedRow.getByText("None", { exact: true }).isVisible()).toBe(true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(receiptsDir, "04-scope-edited-desktop.png") });

    const denied = await app.inject({
      method: "POST",
      url: "/api/hermes/tasks",
      headers: { Authorization: `Bearer ${credential}` },
      payload: { projectId, title: "Denied task", description: "No scope", idempotencyKey: "sre-hermes-denied-browser-001" },
    });
    expect(denied.statusCode).toBe(404);

    await page.getByRole("button", { name: "SRE Hermes Bot actions" }).click();
    await page.getByRole("menuitem", { name: "Edit project scope" }).click();
    await scopeDialog.getByText("Proof Project").click();
    await scopeDialog.getByRole("button", { name: "Save the project access" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i }).getByText("Proof Project").isVisible()).toBe(true);

    await page.getByRole("button", { name: "SRE Hermes Bot actions" }).click();
    await page.getByRole("menuitem", { name: "Rotate credential" }).click();
    const rotationDialog = page.getByRole("dialog", { name: "Pairing code" });
    await rotationDialog.waitFor();
    const rotationCode = (await rotationDialog.locator("button.font-mono").last().innerText()).trim();
    expect(/^fhp_/.test(rotationCode)).toBe(true);
    expect(page.url().includes(rotationCode)).toBe(false);
    const rotationReceipt = join(receiptsDir, "05-rotation-modal-desktop-masked.png");
    await page.screenshot({ path: rotationReceipt, mask: [rotationDialog.locator("button.font-mono").last().locator("span").first()] });
    expect((await readFile(rotationReceipt)).includes(Buffer.from(rotationCode))).toBe(false);

    const oldCredentialBeforeRotation = await app.inject({ method: "GET", url: "/api/hermes/tasks/missing-task", headers: { Authorization: `Bearer ${credential}` } });
    expect(oldCredentialBeforeRotation.statusCode).toBe(404);
    const rotated = await app.inject({ method: "POST", url: "/api/hermes/pairing/exchange", payload: { pairingCode: rotationCode, profileId: "profile-sre-hermes" } });
    expect(rotated.statusCode).toBe(200);
    const { credential: replacementCredential } = rotated.json() as { credential: string };
    const oldCredentialAfterRotation = await app.inject({ method: "GET", url: "/api/hermes/tasks/missing-task", headers: { Authorization: `Bearer ${credential}` } });
    expect(oldCredentialAfterRotation.statusCode).toBe(401);
    expect(oldCredentialAfterRotation.json()).toEqual({ error: "Authentication failed", code: "credential_invalid" });

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/hermes/tasks",
      headers: { Authorization: `Bearer ${replacementCredential}` },
      payload: {
        projectId,
        title: "Autonomous SRE Task from Hermes",
        description: "# Alert remediation\nInvestigated high memory usage and proposing fix.",
        idempotencyKey: "sre-hermes-task-browser-001",
      },
    });
    expect(taskResponse.statusCode).toBe(201);
    const { id: taskId } = taskResponse.json() as { id: string };

    await page.goto(`${baseUrl}/tasks/${taskId}?company=${encodeURIComponent(companyId)}`);
    await page.waitForLoadState("networkidle");

    const heading = page.getByRole("button", { name: "Edit task title", exact: true });
    await heading.waitFor();
    expect(await heading.innerText()).toBe("Autonomous SRE Task from Hermes");
    await page.getByText("Investigated high memory usage and proposing fix.", { exact: true }).waitFor();

    await page.screenshot({ path: join(receiptsDir, "06-task-history-attribution-desktop.png") });

    await page.goto(`${baseUrl}/admin/agents?company=${encodeURIComponent(companyId)}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "SRE Hermes Bot actions" }).click();
    await page.getByRole("menuitem", { name: "Revoke agent" }).click();
    await page.getByRole("button", { name: "SRE Hermes Bot actions" }).click();
    await page.getByRole("menuitem", { name: "Confirm revoke" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i }).getByText(/revoked/i).isVisible()).toBe(true);
    const revokedCredential = await app.inject({ method: "GET", url: `/api/hermes/tasks/${taskId}`, headers: { Authorization: `Bearer ${replacementCredential}` } });
    expect(revokedCredential.statusCode).toBe(401);
    expect(revokedCredential.json()).toEqual({ error: "Authentication failed", code: "credential_invalid" });

    const narrowPage = await context.newPage();
    await narrowPage.setViewportSize({ width: 390, height: 844 });
    await narrowPage.goto(`${baseUrl}/tasks/${taskId}?company=${encodeURIComponent(companyId)}`);
    await narrowPage.waitForLoadState("networkidle");
    expect(await narrowPage.getByRole("button", { name: "Edit task title", exact: true }).innerText()).toBe("Autonomous SRE Task from Hermes");
    await narrowPage.getByRole("button", { name: "Edit task description", exact: true }).waitFor();
    expect(await narrowPage.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await narrowPage.screenshot({ path: join(receiptsDir, "07-task-history-attribution-narrow.png") });

    await narrowPage.goto(`${baseUrl}/admin/agents?company=${encodeURIComponent(companyId)}`);
    await narrowPage.waitForLoadState("networkidle");
    const narrowRow = narrowPage.getByRole("row", { name: /Hermes agent SRE Hermes Bot/i });
    await narrowRow.waitFor();
    expect(await narrowRow.getByText(/revoked/i).isVisible()).toBe(true);
    expect(await narrowPage.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await narrowPage.screenshot({ path: join(receiptsDir, "08-agent-revoked-narrow.png") });

    await context.close();
  } finally {
    await browser.close();
  }
}, 60_000);
