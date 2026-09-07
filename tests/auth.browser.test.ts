import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { AgentProfileService } from "../src/agent-profiles.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestDatabase } from "./helpers/test-database.js";
import { freePort } from "./webauthn-helpers.js";

const health = {
  database: async () => ({ id: "database" as const, label: "Database", status: "healthy" as const, summary: "Reachable", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root" as const, label: "Artifacts", status: "healthy" as const, summary: "Reachable", details: {} }),
  opencode: async () => ({ id: "opencode" as const, label: "OpenCode", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth" as const, label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

test("loopback requests create and preserve an Operator session", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-auth-browser-test-"));
  const port = await freePort();
  const reachableAddress = `http://localhost:${port}`;
  const config = createTestConfig(root, { port, reachableAddress });
  const database = createTestDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const app = createApp({
    config,
    auth,
    profiles: new AgentProfileService(database, auth),
    health,
    getHealth: async () => ({ generatedAt: new Date().toISOString(), reachableAddress: config.reachableAddress, ready: true, checks: [] }),
  });
  await app.listen({ host: "127.0.0.1", port });

  try {
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      try {
        const page = await context.newPage();
        await page.goto(`${reachableAddress}/auth`);
        await page.locator("h1").filter({ hasText: "Tasks" }).waitFor();
        expect(new URL(page.url()).pathname).toBe("/tasks");
        const initialAuth = await page.evaluate(async () => (await fetch("/api/auth/me")).json() as Promise<{ user: { id: string; displayName: string; role: string } }>);
        expect(initialAuth).toMatchObject({
          user: { displayName: "Operator", role: "admin" },
        });
        const initialCookies = await context.cookies(reachableAddress);
        expect(initialCookies.map((cookie) => cookie.name)).toEqual(expect.arrayContaining([SESSION_COOKIE_NAME, CSRF_COOKIE_NAME]));
        const initialSessionCookie = initialCookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
        expect(initialSessionCookie).toBeDefined();

        await page.reload();
        const reloadedAuth = await page.evaluate(async () => (await fetch("/api/auth/me")).json() as Promise<{ user: { id: string; displayName: string; role: string } }>);
        expect(reloadedAuth).toMatchObject({
          user: { displayName: "Operator", role: "admin" },
        });
        expect(reloadedAuth.user.id).toBe(initialAuth.user.id);
        const reloadedSessionCookie = (await context.cookies(reachableAddress)).find((cookie) => cookie.name === SESSION_COOKIE_NAME);
        expect(reloadedSessionCookie).toBeDefined();
        expect(reloadedSessionCookie?.value).toBe(initialSessionCookie?.value);

        await page.goto(`${reachableAddress}/admin`);
        await page.getByRole("button", { name: "Switch company" }).click();
        await page.getByRole("menuitem", { name: /New company/ }).click();
        await page.getByLabel("Company name", { exact: true }).fill("Browser Company");
        await page.getByRole("dialog", { name: "New company", exact: true }).getByRole("button", { name: "New company", exact: true }).click();
        await page.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
