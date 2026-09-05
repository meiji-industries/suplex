import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createDevelopmentApp } from "../src/frontend-development.js";
import type { ApiTaskSummary } from "../src/frontend/lib/view-shared.js";
import type { HostHealthDependencies } from "../src/health.js";

const company = { id: "company-1", name: "Browser Tasks", status: "active" as const, issueCode: "TSK", createdAt: "2026-09-05T00:00:00.000Z" };
const user = { id: "user-1", displayName: "Ada", username: "ada", avatarSeed: "a".repeat(32), role: "admin" as const, status: "active" as const, companyIds: [company.id] };
const project = { id: "project-1", companyId: company.id, name: "Task project", repository: "acme/project", repositoryPath: "/repos/project", worktreeRoot: "/worktrees", baseBranch: "main", targetBranch: "main", setupCommand: "", verificationCommand: "", requiredChecks: [], roleDefaults: {}, status: "active" as const, createdAt: company.createdAt, updatedAt: company.createdAt };

const tasks: ApiTaskSummary[] = [
  { id: "task-1", companyId: company.id, projectId: project.id, issueKey: "TSK-1", title: "Keyboard search task", archivedAt: null, deliveryTarget: "pull_request_draft", phase: "backlog", step: "backlog", blocked: false, revision: 1, owner: "human", allowedCommands: [], pendingAction: null, worktreeState: null, createdAt: company.createdAt, updatedAt: "2026-09-05T00:02:00.000Z", agentInvocations: [], liveStatus: [], liveStatusObservedAt: null, capacity: null },
  { id: "task-2", companyId: company.id, projectId: project.id, issueKey: "TSK-2", title: "Another backlog task", archivedAt: null, deliveryTarget: "pull_request_draft", phase: "backlog", step: "backlog", blocked: false, revision: 1, owner: "human", allowedCommands: [], pendingAction: null, worktreeState: null, createdAt: company.createdAt, updatedAt: "2026-09-05T00:01:00.000Z", agentInvocations: [], liveStatus: [], liveStatusObservedAt: null, capacity: null },
  { id: "task-3", companyId: company.id, projectId: project.id, issueKey: "TSK-3", title: "Active task", archivedAt: null, deliveryTarget: "pull_request_draft", phase: "planning", step: "planning", blocked: false, revision: 1, owner: "lead", allowedCommands: [], pendingAction: null, worktreeState: null, createdAt: company.createdAt, updatedAt: "2026-09-05T00:03:00.000Z", agentInvocations: [], liveStatus: [], liveStatusObservedAt: null, capacity: null },
];

const health: HostHealthDependencies = {
  engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }),
  database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
  worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
  codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
};

const webAuthn: WebAuthnAdapter = {
  async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "tasks-search", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
  async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; },
  async generateAuthenticationOptions(input) { return { challenge: "tasks-search-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
  async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
};

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const values = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (values.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]?.split("=", 2)[1] ?? "";
}

test("Escape clears task search without changing the selected filter or route", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-tasks-search-browser-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const app = await createDevelopmentApp({ config, auth, health });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.app.server.address();
  if (!address || typeof address !== "object") throw new Error("Tasks search test server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: user.id, type: "public-key" } } });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookie(enrolled.headers, SESSION_COOKIE_NAME), domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: cookie(enrolled.headers, CSRF_COOKIE_NAME), domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/auth/me") return route.fulfill({ json: { user } });
        if (url.pathname === "/api/companies") return route.fulfill({ json: { companies: [company] } });
        if (url.pathname === `/api/companies/${company.id}/projects`) return route.fulfill({ json: { projects: [project] } });
        if (url.pathname === `/api/companies/${company.id}/tasks`) return route.fulfill({ json: { tasks } });
        if (url.pathname === `/api/companies/${company.id}/branch-sync`) return route.fulfill({ json: {} });
        if (url.pathname === "/api/agents") return route.fulfill({ json: { agents: [] } });
        if (url.pathname === "/api/agent-runtime") return route.fulfill({ json: { runtime: [] } });
        if (url.pathname === "/api/tasks/events") return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" });
        if (url.pathname === "/api/health") return route.fulfill({ json: { generatedAt: company.createdAt, reachableAddress: baseUrl, ready: true, checks: [] } });
        return route.fulfill({ status: 200, json: {} });
      });
      await page.goto(`${baseUrl}/tasks?company=${company.id}`);
      const list = page.locator("[data-task-list]");
      await list.getByText("Keyboard search task", { exact: true }).waitFor();
      const backlogTab = page.getByRole("tab", { name: /Backlog/ });
      await backlogTab.click();
      const rows = list.locator("[data-task-row]");
      expect(await rows.count()).toBe(2);
      const search = page.getByLabel("Search tasks", { exact: true });
      const routeBeforeSearch = page.url();
      await search.fill("keyboard");
      expect(await rows.count()).toBe(1);
      expect(page.url()).toBe(routeBeforeSearch);
      const routeBeforeEscape = page.url();
      await page.keyboard.press("Escape");
      await rows.filter({ hasText: "Another backlog task" }).waitFor();
      expect(await search.inputValue()).toBe("");
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await rows.count()).toBe(2);
      expect(await list.getByText("Active task", { exact: true }).count()).toBe(0);
      expect(await backlogTab.getAttribute("aria-selected")).toBe("true");
      expect(page.url()).toBe(routeBeforeEscape);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await search.fill("keyboard");
      expect(await rows.count()).toBe(1);
      expect(page.url()).toBe(routeBeforeSearch);
      await page.keyboard.press("Escape");
      await rows.filter({ hasText: "Another backlog task" }).waitFor();
      expect(await search.inputValue()).toBe("");
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await rows.count()).toBe(2);
      expect(await backlogTab.getAttribute("aria-selected")).toBe("true");
      expect(page.url()).toBe(routeBeforeEscape);
      await page.close();
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await app.app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
