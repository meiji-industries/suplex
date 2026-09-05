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
import type { ReadOpenCodeProviders } from "../src/opencode-providers.js";
import type { HostHealthDependencies } from "../src/health.js";

const health: HostHealthDependencies = { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), claudeAuth: async () => ({ id: "claude-auth", label: "Claude", status: "healthy", summary: "Ready", details: {} }), openrouterAuth: async () => ({ id: "openrouter-auth", label: "OpenRouter", status: "unhealthy", summary: "OpenRouter API key is not configured", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) };
const webAuthn: WebAuthnAdapter = { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "providers-browser", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" as const }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0 } }; }, async generateAuthenticationOptions() { return { challenge: "providers-browser", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
function cookie(headers: OutgoingHttpHeaders, name: string): string { const values = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""]; return (values.find((value) => value.split("=", 1)[0] === name) ?? "").split(";", 1)[0]!.split("=", 2)[1] ?? ""; }

test("Providers settings shows all providers at desktop and narrow widths", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-provider-settings-browser-")); const database = new ForgeDatabase(join(root, "forge.sqlite")); const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" }); const auth = new AuthService(database, config, { webAuthn }); const readProviders: ReadOpenCodeProviders = async () => ({ harness: "opencode", directory: root, observedAt: new Date().toISOString(), providers: [{ id: "openai", label: "OpenAI", modelCount: 2, models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }], status: "configured" }, { id: "opencode", label: "OpenCode Zen", modelCount: 1, models: [{ id: "gpt-5.6-luna", label: "Zen Luna" }], status: "configured" }] });
  const projects = new ProjectService(database, auth, config, { readProviders });
  const app = createApp({ config, auth, database, projects, health, readProviders });
  await app.listen({ host: "127.0.0.1", port: 0 }); const address = app.server.address(); if (!address || typeof address !== "object") throw new Error("Provider settings server did not expose a port");
  try {
    const invitation = auth.ensureBootstrapInvitation()!; const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } }); const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "provider-settings-admin", type: "public-key" } } }); const browser = await chromium.launch({ headless: true });
    try { const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookie(enrolled.headers, SESSION_COOKIE_NAME), domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: cookie(enrolled.headers, CSRF_COOKIE_NAME), domain: "127.0.0.1", path: "/" }]); const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}/admin/providers`); await page.getByRole("table", { name: "Providers" }).waitFor(); for (const name of ["OpenAI", "OpenCode Zen"]) { await page.getByRole("row", { name: new RegExp(name) }).waitFor(); expect(await page.getByLabel(new RegExp(`${name}:`)).count()).toBe(1); } expect(await page.getByText("Not tested", { exact: true }).count()).toBe(2); expect(await page.getByText("Configured", { exact: true }).count()).toBe(2); await page.getByRole("button", { name: "Check configuration" }).click(); await page.getByRole("row", { name: /OpenAI/ }).waitFor(); await page.screenshot({ path: join(tmpdir(), "forge-providers-desktop.png") }); await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole("table", { name: "Providers" }).waitFor(); for (const name of ["OpenAI", "OpenCode Zen"]) await page.getByRole("row", { name: new RegExp(name) }).waitFor(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: join(tmpdir(), "forge-providers-narrow.png") }); await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("http://127.0.0.1:" + address.port + "/admin/agents");
      await page.getByRole("button", { name: "Edit Worker", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Provider", { exact: true }).click();
      await page.getByRole("option", { name: "OpenCode Zen", exact: true }).waitFor();
      expect(await page.getByRole("option", { name: "Codex", exact: true }).count()).toBe(0);
      expect(await page.getByRole("option", { name: "Claude Code", exact: true }).count()).toBe(0);
      await page.getByRole("option", { name: "OpenCode Zen", exact: true }).click();
      await dialog.getByLabel("Model", { exact: true }).click();
      await page.getByRole("option", { name: /Zen Luna/ }).click();
      await page.screenshot({ path: join(tmpdir(), "forge-opencode-agent-desktop.png") });
      const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().includes("/api/admin/agents/"));
      await dialog.getByRole("button", { name: "Save changes" }).click();
      expect((await saved).status()).toBe(200);
      await expect.poll(() => dialog.count()).toBe(0);
      expect(database.authQuery(db => db.prepare("SELECT p.provider, p.model FROM forge_agents a JOIN forge_profiles p ON p.id = a.profile_id WHERE a.id = 'agent_native_worker'").get())).toEqual({ provider: "opencode", model: "gpt-5.6-luna" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Edit Worker", exact: true }).click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).scrollIntoViewIfNeeded();
      await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      await page.screenshot({ path: join(tmpdir(), "forge-opencode-agent-narrow.png") });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.goto("http://127.0.0.1:" + address.port + "/admin/models");
      await page.getByRole("table", { name: "Models", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Add model", exact: true }).count()).toBe(0);
      await page.getByRole("row").filter({ hasText: "OpenCode Zen" }).waitFor();
      await context.close(); } finally { await browser.close(); }
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
