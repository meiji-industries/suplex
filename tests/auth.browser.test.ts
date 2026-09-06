import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, productionWebAuthnAdapter } from "../src/auth.js";
import { AgentProfileService } from "../src/agent-profiles.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { addVirtualAuthenticator, freePort } from "./webauthn-helpers.js";

const health = {
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  opencode: async () => ({ id: "opencode" as const, label: "OpenCode", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

import type { Page } from "playwright";

function logConsole(page: Page): void {
  page.on("console", (message) => { console.log(`[page ${page.url()}]`, message.type(), message.text()); });
  page.on("pageerror", (error) => { console.log(`[pageerror ${page.url()}]`, error.message); });
}

async function postJson(page: Page, url: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ([target, payload]) => {
    const token = document.cookie
      .split(";")
      .map((pair) => pair.trim().split("=", 2))
      .find(([key]) => key === "csrf_v1")?.[1];
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-CSRF-V1": token } : {}) },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, [url, body] as const);
}

test("browser enrollment, sign-in/out, administration, membership, and recovery stay in the desktop app", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-auth-browser-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const port = await freePort();
  const reachableAddress = `http://localhost:${port}`;
  const config = createTestConfig(root, { reachableAddress });
  const auth = new AuthService(database, config, { webAuthn: productionWebAuthnAdapter });
  const app = createApp({
    config,
    auth,
    profiles: new AgentProfileService(database, auth),
    health,
    getHealth: async () => ({ generatedAt: new Date().toISOString(), reachableAddress: config.reachableAddress, ready: true, checks: [] }),
  });
  await app.listen({ host: "127.0.0.1", port });
  const baseUrl = `http://localhost:${port}`;

  try {
    const replacedBootstrap = auth.ensureBootstrapInvitation()!;
    const bootstrap = auth.ensureBootstrapInvitation()!;
    const expiredRecovery = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    database.authQuery((db) => { db.prepare("UPDATE forge_invitations SET expires_at = ? WHERE kind = 'recovery' AND consumed_at IS NULL").run("2020-01-01T00:00:00.000Z"); });

    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    try {
      const adminContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      const adminPage = await adminContext.newPage();
      adminPage.setDefaultTimeout(5_000);
      logConsole(adminPage);
      await addVirtualAuthenticator(adminPage);

      await adminPage.goto(`${baseUrl}/auth?invite=${bootstrap.token}`);

      const invalidInvitationStatuses = await adminPage.evaluate(async ({ replaced, expired }) => {
        const readStatus = async (token: string, endpoint: string): Promise<number> => (await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status;
        return { replaced: await readStatus(replaced, "/api/auth/bootstrap/options"), expired: await readStatus(expired, "/api/auth/recovery/options") };
      }, { replaced: replacedBootstrap.token, expired: expiredRecovery.token });
      expect(invalidInvitationStatuses).toEqual({ replaced: 400, expired: 400 });

      await adminPage.getByRole("button", { name: "Enroll passkey" }).click();
      await adminPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
      expect(await adminPage.locator("body").innerText()).not.toMatch(/password/i);

      let releaseInitialAdminUsers!: () => void;
      let initialAdminUsersStarted!: () => void;
      let initialAdminUsersFinished!: () => void;
      const initialAdminUsersReleased = new Promise<void>((resolve) => { releaseInitialAdminUsers = resolve; });
      const initialAdminUsersRequest = new Promise<void>((resolve) => { initialAdminUsersStarted = resolve; });
      const initialAdminUsersResponse = new Promise<void>((resolve) => { initialAdminUsersFinished = resolve; });
      await adminPage.route("**/api/admin/users", async (route) => {
        initialAdminUsersStarted();
        await initialAdminUsersReleased;
        await route.continue();
        initialAdminUsersFinished();
      });
      await adminPage.goto(`${baseUrl}/admin`);
      await initialAdminUsersRequest;
      await adminPage.getByLabel("Loading administration", { exact: true }).waitFor();
      expect(await adminPage.getByText("No users configured.", { exact: true }).count()).toBe(0);
      releaseInitialAdminUsers();
      await initialAdminUsersResponse;
      await adminPage.unroute("**/api/admin/users");
      await adminPage.getByRole("button", { name: "Switch company" }).click();
      await adminPage.getByRole("menuitem", { name: /Create company/ }).click();
      await adminPage.getByLabel("Company name", { exact: true }).fill("Browser Company");
      await adminPage.getByRole("button", { name: "Create", exact: true }).click();
      await adminPage.getByRole("heading", { name: "Workspace", exact: true }).waitFor();

      await adminPage.goto(`${baseUrl}/admin`);
      const secondCompany = await postJson(adminPage, "/api/admin/companies", { name: "Second Browser Company" }) as { status: number; body: { id: string } };
      expect(secondCompany.status).toBe(201);
      await adminPage.reload();
      await adminPage.getByRole("button", { name: "Switch company" }).click();
      await adminPage.getByRole("menuitem", { name: /Second Browser Company/ }).click();
      expect(new URL(adminPage.url()).searchParams.get("company")).toBe(secondCompany.body.id);
      expect(await adminPage.evaluate(() => window.localStorage.getItem("forge.activeCompanyId"))).toBe(secondCompany.body.id);

      expect(await adminPage.getByPlaceholder("Search by name or username").isDisabled()).toBe(true);
      expect(await adminPage.getByRole("button", { name: "Export CSV", exact: true }).isDisabled()).toBe(true);
      await adminPage.goto(`${baseUrl}/admin/invitations${new URL(adminPage.url()).search}`);
      await adminPage.getByRole("button", { name: "Invite", exact: true }).click();
      const inviteDialog = adminPage.getByRole("dialog", { name: "Invite user", exact: true });
      await inviteDialog.getByLabel("Display name", { exact: true }).fill("Browser Member");
      await inviteDialog.getByRole("button", { name: "Invite", exact: true }).click();
      await adminPage.locator("code").waitFor();
      const invitationToken = await adminPage.locator("code").innerText();
      expect(invitationToken).toMatch(/^invite_v1_user_/);
      await adminPage.getByText("Copy invitation", { exact: true }).waitFor();

      const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const memberPage = await memberContext.newPage();
      logConsole(memberPage);
      await addVirtualAuthenticator(memberPage);
      await memberPage.goto(`${baseUrl}/auth?invite=${encodeURIComponent(invitationToken)}`);
      await memberPage.getByRole("button", { name: "Enroll passkey" }).click();
      await memberPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
      expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await adminPage.reload();
      expect(await adminPage.locator("body").innerText()).not.toContain(invitationToken);
      await adminPage.goto(`${baseUrl}/admin/passkeys${new URL(adminPage.url()).search}`);
      await adminPage.getByRole("table", { name: "Passkeys", exact: true }).waitFor();
      await adminPage.goto(`${baseUrl}/admin/companies${new URL(adminPage.url()).search}`);
      const companyActions = adminPage.getByRole("button", { name: /actions$/ }).first();
      await companyActions.click();
      await adminPage.getByRole("menuitem", { name: "Add Browser Member", exact: true }).click();
      await companyActions.click();
      await adminPage.getByRole("menuitem", { name: "Remove Browser Member", exact: true }).click();
      await companyActions.click();
      await adminPage.getByRole("menuitem", { name: "Confirm remove Browser Member", exact: true }).click();
      await companyActions.click();
      await adminPage.getByRole("menuitem", { name: "Add Browser Member", exact: true }).waitFor();

      await adminPage.goto(`${baseUrl}/health`);
      expect(await adminPage.evaluate(async () => (await fetch("/api/auth/sign-out", { method: "POST" })).status)).toBe(200);
      await adminPage.goto(`${baseUrl}/auth`);
      await adminPage.locator("button", { hasText: "Sign in with passkey" }).waitFor();

      await adminPage.getByRole("button", { name: "Sign in with passkey" }).click();
      await adminPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
      expect(await adminPage.evaluate(async (token) => (await fetch("/api/auth/bootstrap/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status, bootstrap.token)).toBe(400);

      const recovery = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
      const recoveryContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const recoveryPage = await recoveryContext.newPage();
      logConsole(recoveryPage);
      await addVirtualAuthenticator(recoveryPage);
      await recoveryPage.goto(`${baseUrl}/auth?mode=recovery&invite=${recovery.token}`);
      await recoveryPage.getByRole("button", { name: "Enroll passkey" }).click();
      await recoveryPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
      expect(await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await recoveryPage.evaluate(async () => (await fetch("/api/auth/me")).status))).toBe(200);

      await memberPage.close();
      await recoveryPage.close();
      await adminPage.close();
    } finally {
      await browser.close();
    }
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
