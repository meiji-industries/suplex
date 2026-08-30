import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createDevelopmentApp } from "../src/frontend-development.js";
import type { ApiTaskTemplate } from "../src/frontend/lib/view-shared.js";
import type { HostHealthDependencies } from "../src/health.js";

const health: HostHealthDependencies = { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) };
const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "new-task-template-menu", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "new-task-template-menu", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

const projectId = "project-1";
const company = { id: "company-1", name: "Acme", status: "active" as const, issueCode: null, createdAt: "2026-08-27T00:00:00.000Z" };
const user = { id: "user-1", displayName: "Ada", username: "ada", avatarSeed: "a".repeat(32), role: "admin" as const, status: "active" as const, companyIds: [company.id] };
const project = { id: projectId, companyId: company.id, name: "Forge", repositoryPath: "/repos/forge", worktreeRoot: "", baseBranch: "main", targetBranch: "", setupCommand: "", verificationCommand: "", requiredChecks: [], roleDefaults: {}, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" };
const template = (id: string, name: string): ApiTaskTemplate => ({ id, projectId, name, description: `${name} description`, roleAgents: {}, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "required", createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T01:00:00.000Z" });

type RecordedRequest = { method: string; path: string };
let root = "";
let database: ForgeDatabase;
let browser: Browser;
let baseUrl = "";
let session = "";
let csrf = "";
let closeApp: (() => Promise<void>) | undefined;

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const values = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (values.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]?.split("=", 2)[1] ?? "";
}

async function pageFor(templates: ApiTaskTemplate[], requests: RecordedRequest[]): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: session, domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: csrf, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { user } });
    if (url.pathname === "/api/companies") return route.fulfill({ json: { companies: [company] } });
    if (url.pathname === "/api/health") return route.fulfill({ json: { generatedAt: "2026-08-27T00:00:00.000Z", reachableAddress: baseUrl, ready: true, checks: [] } });
    if (url.pathname === `/api/companies/${company.id}/projects`) return route.fulfill({ json: { projects: [project] } });
    if (url.pathname === `/api/companies/${company.id}/tasks`) return route.fulfill({ json: { tasks: [] } });
    if (url.pathname === `/api/companies/${company.id}/branch-sync`) return route.fulfill({ json: {} });
    if (url.pathname === `/api/projects/${projectId}/task-templates` && request.method() === "GET") return route.fulfill({ json: { templates } });
    if (url.pathname === "/api/agents") return route.fulfill({ json: { agents: [] } });
    return route.fulfill({ status: 200, json: {} });
  });
  await page.goto(`${baseUrl}/tasks?company=${company.id}&new=1`);
  await page.getByLabel("Task title").waitFor();
  return page;
}

async function closePage(page: Page): Promise<void> { await page.context().close(); }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-new-task-template-menu-unit-"));
  database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4112" });
  const auth = new AuthService(database, config, { webAuthn });
  const app = await createDevelopmentApp({ config, auth, health });
  closeApp = async () => { await app.app.close(); };
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.app.server.address(); if (!address || typeof address !== "object") throw new Error("New task template menu test server did not expose a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const invitation = auth.ensureBootstrapInvitation()!;
  const options = await app.app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
  const enrolled = await app.app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: user.id, type: "public-key" } } });
  session = cookie(enrolled.headers, SESSION_COOKIE_NAME); csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => { await browser?.close(); await closeApp?.(); database?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test("the template menu lists templates without delete items and makes no delete request", async () => {
  const requests: RecordedRequest[] = [];
  const templates = [template("release-notes", "Release notes"), template("bug-report", "Bug report")];
  const page = await pageFor(templates, requests);
  try {
    const menuTrigger = page.getByRole("button", { name: "Template" });
    await menuTrigger.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.getByRole("menuitem").all();
    expect(items).toHaveLength(templates.length);
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Release notes", "Bug report"]);
    expect(await menu.getByRole("menuitem", { name: /^Delete/ }).count()).toBe(0);
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);
  } finally { await closePage(page); }
});

test("clicking a template menu item applies it to the new task form", async () => {
  const requests: RecordedRequest[] = [];
  const templates = [template("release-notes", "Release notes"), template("bug-report", "Bug report")];
  const page = await pageFor(templates, requests);
  try {
    await page.getByRole("button", { name: "Template" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Release notes" }).click();
    await page.getByLabel("Task description").waitFor();
    const deadline = Date.now() + 5_000;
    while (await page.getByLabel("Task description").inputValue() !== "Release notes description") {
      if (Date.now() > deadline) throw new Error("Template description was not applied to the new task form");
      await page.waitForTimeout(100);
    }
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);
  } finally { await closePage(page); }
});
