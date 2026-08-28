import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService } from "../src/projects.js";
import { TaskTemplateService } from "../src/task-templates.js";
import type { HostHealthDependencies } from "../src/health.js";

const health: HostHealthDependencies = { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) };
const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "template-browser", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "template-browser", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };

function cookie(headers: OutgoingHttpHeaders, name: string): string {
  const values = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  return (values.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]?.split("=", 2)[1] ?? "";
}

test("task template settings renders a responsive table and editor", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-template-settings-browser-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn });
  const projects = new ProjectService(database, auth, config, { github: { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } } });
  const templates = new TaskTemplateService(database, auth, {} as never);
  const app = createApp({ config, auth, projects, taskTemplates: templates, health });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address(); if (!address || typeof address !== "object") throw new Error("Template settings server did not expose a port");
  try {
    const invitation = auth.ensureBootstrapInvitation()!;
    const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "template-settings-admin", type: "public-key" } } });
    const actor = (enrolled.json() as { user: { id: string } }).user.id;
    const company = auth.createCompany(actor, "Template settings company");
    database.authTransaction((db) => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('template-project', ?, 'Template project', '/tmp/template', '/tmp/template-worktrees', 'acme/template', 'main', 'main', '', '', '[]', '{}', 'active', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')").run(company.id));
    templates.create(actor, "template-project", { name: "Release", description: "Release checklist", roleAgents: {}, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "off" });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookie(enrolled.headers, SESSION_COOKIE_NAME), domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: cookie(enrolled.headers, CSRF_COOKIE_NAME), domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      const url = `http://127.0.0.1:${address.port}/projects/template-project/templates?company=${encodeURIComponent(company.id)}`;
      await page.goto(url); await page.getByRole("table", { name: "Task templates" }).waitFor();
      await page.getByRole("row", { name: /Release/ }).click(); await page.getByLabel("Template editor").getByLabel("Name").waitFor();
      expect(await page.getByLabel("Name").inputValue()).toBe("Release");
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole("table", { name: "Task templates" }).waitFor();
      await page.getByRole("row", { name: /Release/ }).click(); await page.getByLabel("Template editor").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
