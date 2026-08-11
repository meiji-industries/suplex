import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

function fakeWebAuthn(): WebAuthnAdapter {
  let sequence = 0;
  return {
    async generateRegistrationOptions(input) {
      sequence += 1;
      return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from(`registration-${sequence}`).toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([7, 8, 9]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      sequence += 1;
      return { challenge: Buffer.from(`authentication-${sequence}`).toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

async function installCredentialStub(page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class PublicKeyCredential {} });
    const bytes = () => new Uint8Array([1, 2, 3]).buffer;
    const credential = () => {
      const id = (window as Window & { __forgeCredentialId?: string }).__forgeCredentialId ?? "YWRtaW4tY3JlZGVudGlhbA";
      return {
        id,
        rawId: bytes(),
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({}),
        response: {
          attestationObject: bytes(),
          clientDataJSON: bytes(),
          authenticatorData: bytes(),
          signature: bytes(),
          getTransports: () => ["internal"],
          getPublicKeyAlgorithm: () => -7,
          getPublicKey: () => bytes(),
          getAuthenticatorData: () => bytes(),
        },
      };
    };
    Object.defineProperty(navigator, "credentials", { configurable: true, value: { create: async () => credential(), get: async () => credential() } });
  });
}

test("browser enrollment, sign-in/out, administration, membership, and recovery stay in the desktop app", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-auth-browser-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const app = createApp({
    config,
    auth,
    health: {
      temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Reachable", details: {} }),
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Reachable", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Reachable", details: {} }),
      worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Reachable", details: {} }),
      codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
      ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    },
    getHealth: async () => ({ generatedAt: new Date().toISOString(), reachableAddress: config.reachableAddress, ready: true, checks: [] }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  expect(address && typeof address === "object").toBeTruthy();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const replacedBootstrap = auth.ensureBootstrapInvitation()!;
  const bootstrap = auth.ensureBootstrapInvitation()!;
  const expiredRecovery = auth.createRecoveryInvitation();
  database.authQuery((db) => { db.prepare("UPDATE forge_invitations SET expires_at = ? WHERE kind = 'recovery' AND consumed_at IS NULL").run("2020-01-01T00:00:00.000Z"); });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const adminPage = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await installCredentialStub(adminPage);
    await adminPage.goto(`${baseUrl}/auth?invite=${bootstrap.token}`);
    const invalidInvitationStatuses = await adminPage.evaluate(async ({ replaced, expired }) => {
      const readStatus = async (token: string, endpoint: string): Promise<number> => (await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status;
      return { replaced: await readStatus(replaced, "/api/auth/bootstrap/options"), expired: await readStatus(expired, "/api/auth/recovery/options") };
    }, { replaced: replacedBootstrap.token, expired: expiredRecovery.token });
    expect(invalidInvitationStatuses).toEqual({ replaced: 400, expired: 400 });
    await adminPage.getByRole("button", { name: "Enroll passkey" }).click();
    await adminPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
    expect(await adminPage.locator("body").innerText()).not.toMatch(/password/i);

    await adminPage.goto(`${baseUrl}/admin`);
    await adminPage.getByRole("button", { name: "Switch company" }).click();
    await adminPage.getByRole("menuitem", { name: /Create company/ }).click();
    await adminPage.getByLabel("Company name", { exact: true }).fill("Browser Company");
    await adminPage.getByRole("button", { name: "Create", exact: true }).click();
    await adminPage.getByRole("heading", { name: "Company settings", exact: true }).waitFor();
    await adminPage.goto(`${baseUrl}/admin`);
    const secondCompany = await adminPage.evaluate(async () => (await (await fetch("/api/admin/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Second Browser Company" }) })).json()) as { id: string });
    await adminPage.reload();
    await adminPage.getByRole("button", { name: "Switch company" }).click();
    await adminPage.getByRole("menuitem", { name: /Second Browser Company/ }).click();
    expect(new URL(adminPage.url()).searchParams.get("company")).toBe(secondCompany.id);
    expect(await adminPage.evaluate(() => window.localStorage.getItem("forge.activeCompanyId"))).toBe(secondCompany.id);
    await adminPage.getByPlaceholder("Display name").fill("Browser Member");
    await adminPage.getByRole("button", { name: "Invite", exact: true }).click();
    await adminPage.locator("code").waitFor();
    const invitationToken = await adminPage.locator("code").innerText();
    expect(invitationToken).toMatch(/^forge_user_/);

    const memberPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await memberPage.addInitScript(() => {
      (window as Window & { __forgeCredentialId?: string }).__forgeCredentialId = "bWVtYmVyLWNyZWRlbnRpYWw";
    });
    await installCredentialStub(memberPage);
    await memberPage.goto(`${baseUrl}/auth?invite=${encodeURIComponent(invitationToken)}`);
    await memberPage.getByRole("button", { name: "Enroll passkey" }).click();
    await memberPage.locator("h1").filter({ hasText: "Host health" }).waitFor();

    await adminPage.reload();
    await adminPage.getByRole("button", { name: /\+ Browser Member/ }).first().click();
    await adminPage.getByRole("button", { name: /− Browser Member/ }).first().waitFor();
    await adminPage.getByRole("button", { name: /− Browser Member/ }).first().click();
    await adminPage.getByRole("button", { name: /\+ Browser Member/ }).first().waitFor();

    await adminPage.evaluate(async () => { await fetch("/api/auth/sign-out", { method: "POST" }); });
    await adminPage.goto(`${baseUrl}/auth`);
    await adminPage.getByRole("button", { name: "Sign in with passkey" }).click();
    await adminPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
    expect(await adminPage.evaluate(async (token) => (await fetch("/api/auth/bootstrap/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status, bootstrap.token)).toBe(400);

    const recovery = auth.createRecoveryInvitation();
    const recoveryPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await recoveryPage.addInitScript(() => { (window as Window & { __forgeCredentialId?: string }).__forgeCredentialId = "cmVjb3ZlcnktY3JlZGVudGlhbA"; });
    await installCredentialStub(recoveryPage);
    await recoveryPage.goto(`${baseUrl}/auth?mode=recovery&invite=${recovery.token}`);
    await recoveryPage.getByRole("button", { name: "Enroll passkey" }).click();
    await recoveryPage.locator("h1").filter({ hasText: "Host health" }).waitFor();
    expect((await recoveryPage.evaluate(async () => (await fetch("/api/auth/me")).status))).toBe(200);
    await memberPage.close();
    await recoveryPage.close();
    await adminPage.close();
  } finally {
    await browser?.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
