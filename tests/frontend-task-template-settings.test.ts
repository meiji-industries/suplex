import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createDevelopmentApp } from "../src/frontend-development.js";
import type { ApiTaskTemplate } from "../src/frontend/lib/view-shared.js";
import type { HostHealthDependencies } from "../src/health.js";

const health: HostHealthDependencies = { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) };
const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "template-settings", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "template-settings", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

const projectId = "project-1";
const company = { id: "company-1", name: "Acme", status: "active" as const, issueCode: null, createdAt: "2026-08-27T00:00:00.000Z" };
const user = { id: "user-1", displayName: "Ada", username: "ada", avatarSeed: "a".repeat(32), role: "admin" as const, status: "active" as const, companyIds: [company.id] };
const template = (id: string, name: string, changes: Partial<ApiTaskTemplate> = {}): ApiTaskTemplate => ({ id, projectId, name, description: `${name} description`, roleAgents: {}, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "required", createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T01:00:00.000Z", ...changes });

type RecordedRequest = { method: string; path: string; body?: unknown };
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

async function pageFor(templates: ApiTaskTemplate[], requests: RecordedRequest[], save?: (request: RecordedRequest) => { status?: number; body?: unknown }): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: session, domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: csrf, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const record: RecordedRequest = { method: request.method(), path: url.pathname, ...(request.postData() ? { body: JSON.parse(request.postData()!) } : {}) };
    requests.push(record);
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { user } });
    if (url.pathname === "/api/companies") return route.fulfill({ json: { companies: [company] } });
    if (url.pathname === "/api/health") return route.fulfill({ json: { generatedAt: "2026-08-27T00:00:00.000Z", reachableAddress: baseUrl, ready: true, checks: [] } });
    if (url.pathname === `/api/projects/${projectId}/task-templates` && request.method() === "GET") return route.fulfill({ json: { templates } });
    if (url.pathname === "/api/agents") return route.fulfill({ json: { agents: [] } });
    const result = save?.(record) ?? { body: {} };
    return route.fulfill({ status: result.status ?? 200, json: result.body ?? {} });
  });
  await page.goto(`${baseUrl}/projects/${projectId}/templates?company=${company.id}`);
  await page.getByRole("table", { name: "Task templates" }).waitFor();
  return page;
}

async function closePage(page: Page): Promise<void> { await page.context().close(); }

async function visible(locator: Locator): Promise<void> { await locator.waitFor(); expect(await locator.isVisible()).toBe(true); }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-template-settings-unit-"));
  database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const app = await createDevelopmentApp({ config, auth, health });
  closeApp = async () => { await app.app.close(); };
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.app.server.address(); if (!address || typeof address !== "object") throw new Error("Template settings test server did not expose a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const invitation = auth.ensureBootstrapInvitation()!;
  const options = await app.app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
  const enrolled = await app.app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: user.id, type: "public-key" } } });
  session = cookie(enrolled.headers, SESSION_COOKIE_NAME); csrf = cookie(enrolled.headers, CSRF_COOKIE_NAME);
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => { await browser?.close(); await closeApp?.(); database?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test("lists task templates and requests the project collection", async () => {
  const requests: RecordedRequest[] = [];
  const page = await pageFor([template("release", "Release")], requests);
  try {
    await visible(page.getByRole("row", { name: /Release.*Ready for review/ }));
    await visible(page.getByRole("columnheader", { name: "Updated" }));
    expect(requests).toContainEqual({ method: "GET", path: `/api/projects/${projectId}/task-templates` });
  } finally { await closePage(page); }
});

test("selecting a template populates its editor", async () => {
  const requests: RecordedRequest[] = [];
  const selected = template("release", "Release", { description: "Ship the release", supplementalReview: true, autoApprovePlan: true, deliveryTarget: "merged", runProjectTests: false, visualEvidence: "capture" });
  const page = await pageFor([selected], requests);
  try {
    await page.getByRole("row", { name: /Release/ }).click();
    expect(await page.getByLabel("Name").inputValue()).toBe("Release");
    expect(await page.getByLabel("Description").inputValue()).toBe("Ship the release");
    expect(await page.getByRole("combobox", { name: "Delivery target" }).innerText()).toBe("Fully merged");
    expect(await page.getByRole("combobox", { name: "Visual evidence" }).innerText()).toBe("Capture");
    const controls = page.getByRole("checkbox");
    expect(await controls.nth(0).isChecked()).toBe(false);
    expect(await controls.nth(1).isChecked()).toBe(true);
    expect(await controls.nth(2).isChecked()).toBe(true);
  } finally { await closePage(page); }
});

test("saving edits PATCHes the template and updates its row", async () => {
  const requests: RecordedRequest[] = [];
  const original = template("release", "Release");
  const page = await pageFor([original], requests, (request) => request.method === "PATCH" ? { body: { ...original, name: "Release v2", description: "Ship it safely" } } : { body: {} });
  try {
    await page.getByRole("row", { name: /Release/ }).click();
    await page.getByLabel("Name").fill("Release v2");
    await page.getByLabel("Description").fill("Ship it safely");
    await page.getByRole("button", { name: "Save" }).click();
    await visible(page.getByRole("row", { name: /Release v2/ }));
    expect(requests).toContainEqual(expect.objectContaining({ method: "PATCH", path: "/api/task-templates/release", body: expect.objectContaining({ name: "Release v2", description: "Ship it safely" }) }));
  } finally { await closePage(page); }
});

test("creating a template POSTs the full draft and selects the new row", async () => {
  const requests: RecordedRequest[] = [];
  const created = template("new", "Incident response", { description: "Escalate quickly", deliveryTarget: "pull_request_draft", visualEvidence: "off" });
  const page = await pageFor([], requests, (request) => request.method === "POST" ? { status: 201, body: created } : { body: {} });
  try {
    await page.getByRole("button", { name: "New template" }).click();
    await page.getByLabel("Name").fill(created.name);
    await page.getByLabel("Description").fill(created.description);
    await page.getByRole("button", { name: "Save" }).click();
    await visible(page.getByRole("row", { name: /Incident response/ }));
    expect(await page.getByLabel("Name").inputValue()).toBe("Incident response");
    expect(requests).toContainEqual(expect.objectContaining({ method: "POST", path: `/api/projects/${projectId}/task-templates`, body: expect.objectContaining({ name: "Incident response", description: "Escalate quickly", roleAgents: {}, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" }) }));
  } finally { await closePage(page); }
});

test("deleting a template removes its row and closes the editor", async () => {
  const requests: RecordedRequest[] = [];
  const page = await pageFor([template("release", "Release")], requests);
  try {
    await page.getByRole("row", { name: /Release/ }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect.poll(async () => page.getByRole("row", { name: /Release/ }).count()).toBe(0);
    await visible(page.getByText("Select a template to edit it."));
    expect(requests).toContainEqual({ method: "DELETE", path: "/api/task-templates/release" });
  } finally { await closePage(page); }
});

test("a duplicate-name conflict is displayed beside Name and retains the draft", async () => {
  const requests: RecordedRequest[] = [];
  const page = await pageFor([template("release", "Release")], requests, (request) => request.method === "PATCH" ? { status: 409, body: { error: "A template named Release already exists", findings: [{ code: "duplicate-template-name", field: "name" }] } } : { body: {} });
  try {
    await page.getByRole("row", { name: /Release/ }).click();
    await page.getByLabel("Name").fill("Release duplicate");
    await page.getByRole("button", { name: "Save" }).click();
    await visible(page.locator("#template-name-error"));
    expect(await page.locator("#template-name-error").textContent()).toBe("A template named Release already exists");
    expect(await page.getByLabel("Name").inputValue()).toBe("Release duplicate");
  } finally { await closePage(page); }
});

test("search filters template names without regard to case", async () => {
  const requests: RecordedRequest[] = [];
  const page = await pageFor([template("release", "Release"), template("incident", "Incident response")], requests);
  try {
    await page.getByLabel("Search templates").fill("RELEASE");
    await visible(page.getByRole("row", { name: /Release/ }));
    await expect.poll(async () => page.getByRole("row", { name: /Incident response/ }).count()).toBe(0);
  } finally { await closePage(page); }
});
