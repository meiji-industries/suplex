import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { freePort } from "./webauthn-helpers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: Buffer.from("registration").toString("base64url"), pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, attestation: "none" };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([7, 8, 9]), counter: 0 }, transports: ["internal"] };
    },
    async generateAuthenticationOptions(input) {
      return { challenge: Buffer.from("authentication").toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

const health = {
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Ready", details: {} }),
  opencode: async () => ({ id: "opencode" as const, label: "OpenCode", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

function sessionCookies(response: { headers: OutgoingHttpHeaders }): Array<{ name: string; value: string }> {
  const raw = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"] ?? ""];
  return raw.flatMap((entry) => {
    const [name, value] = entry.split(";", 1)[0]?.split("=", 2) ?? [];
    return name && value ? [{ name, value }] : [];
  });
}

test("Clear account in Lifecycle confirms, wipes, and resets the workspace to factory state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-company-settings-browser-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const port = await freePort();
  const config = createTestConfig(root, { reachableAddress: `http://127.0.0.1:${port}` });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const app = createApp({ config, auth, health });
  await app.listen({ host: "127.0.0.1", port });
  const baseUrl = `http://127.0.0.1:${port}`;

  const invitation = auth.ensureBootstrapInvitation()!;
  const options = await app.inject({ method: "POST", url: "/api/auth/bootstrap/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/bootstrap/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "settings-admin", type: "public-key" } } });
  const cookies = sessionCookies(enrolled);
  const session = cookies.find((entry) => entry.name.startsWith("sid_v1") || entry.name === "forge_session") ?? cookies[0] ?? { name: "sid_v1", value: "" };
  const admin = (await auth.getUserBySession(session.value))!;
  const company = auth.createCompany(admin.id, "Clear Me Workspace");
  // Seed lifecycle state that the wipe must undo: archived and issue code set.
  auth.setCompanyStatus(admin.id, company.id, "archived");
  database.authQuery((db) => db.prepare("UPDATE forge_companies SET issue_code = ?, next_issue_number = ? WHERE id = ?").run("CM", 12, company.id));

  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addCookies(cookies.map((entry) => ({ ...entry, domain: "127.0.0.1", path: "/" })));
      const page = await context.newPage();
      const settingsUrl = `${baseUrl}/companies/${encodeURIComponent(company.id)}/settings?company=${encodeURIComponent(company.id)}`;

      await page.goto(settingsUrl);
      await page.getByText("Clear account", { exact: false }).first().waitFor();

      // Cancel first: nothing clears.
      const priorStatus = (database.authQuery((db) => db.prepare("SELECT status FROM forge_companies WHERE id = ?").get(company.id)) as { status: string }).status;
      await page.getByRole("button", { name: "Clear account" }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached" });
      expect((database.authQuery((db) => db.prepare("SELECT status FROM forge_companies WHERE id = ?").get(company.id)) as { status: string }).status).toBe(priorStatus);

      // Confirm: dialog dismisses and the workspace resets to factory.
      await page.getByRole("button", { name: "Clear account" }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("alertdialog").getByRole("button", { name: "Clear account" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached" });

      // Settings page still renders the workspace after the clear.
      await page.getByText("Clear account", { exact: false }).first().waitFor();
      await context.close();
    }

    const reset = database.authQuery((db) => db.prepare("SELECT status, issue_code AS issueCode, next_issue_number AS nextIssueNumber FROM forge_companies WHERE id = ?").get(company.id)) as { status: string; issueCode: string | null; nextIssueNumber: number };
    expect(reset).toEqual({ status: "active", issueCode: null, nextIssueNumber: 1 });
  } finally {
    await browser.close();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
