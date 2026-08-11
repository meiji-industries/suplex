import { expect, test } from "vitest";

import { chromium } from "playwright";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import type { HealthSnapshot } from "../src/health.js";

test("mobile health page shows separate healthy and unhealthy states", async () => {
  const snapshot: HealthSnapshot = {
    generatedAt: "2026-08-11T00:00:00.000Z",
    reachableAddress: "http://forge.tailnet.ts.net:4111",
    ready: true,
    checks: [
      { id: "database", label: "SQLite database", status: "healthy", summary: "WAL is enabled", details: { walMode: true } },
      { id: "gh-auth", label: "GitHub CLI authentication", status: "unhealthy", summary: "Local authentication is unavailable", details: {} },
    ],
  };
  const app = createApp({
    config: createTestConfig("/tmp/forge-browser-test"),
    health: {
      temporal: async () => snapshot.checks[0]!,
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
      worker: async () => snapshot.checks[0]!,
      codexAuth: async () => snapshot.checks[0]!,
      ghAuth: async () => snapshot.checks[1]!,
    },
    getHealth: async () => snapshot,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  expect(address && typeof address === "object").toBeTruthy();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/health`);
    await page.locator("h1").waitFor();
    await page.getByRole("heading", { name: "Owned services", exact: true }).waitFor();
    expect(await page.locator('[data-status="healthy"]').count()).toBe(1);
    expect(await page.locator('[data-status="unhealthy"]').count()).toBe(1);
    expect(await page.locator('[data-slot="health-row"]').count()).toBe(2);
    expect(await page.locator("body").innerText()).toMatch(/forge\.tailnet\.ts\.net/);
    expect(await page.locator("body").innerText()).not.toMatch(/Truthful readiness/);

    const navigationTrigger = page.getByRole("button", { name: "Open navigation" });
    await navigationTrigger.focus();
    await page.keyboard.press("Enter");
    expect(await page.locator('[data-slot="mobile-nav"]').isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await navigationTrigger.evaluate((element) => element === document.activeElement)).toBe(true);

    await page.locator('[data-slot="health-row"]').first().locator("button").click();
    await page.getByText("walMode").waitFor();
    const apiHealth = await page.evaluate(async () => {
      const response = await fetch("/api/health");
      return { status: response.status, body: await response.json() as { ready: boolean } };
    });
    expect(apiHealth.status).toBe(200);
    expect(apiHealth.body.ready).toBe(true);

    const refreshResponse = page.waitForResponse((response) => response.url().endsWith("/api/health"));
    await page.getByRole("button", { name: "Refresh health" }).click();
    expect((await refreshResponse).status()).toBe(200);

    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(`http://127.0.0.1:${address.port}/health`);
    expect(await desktop.locator("aside").isVisible()).toBe(true);
    expect(await desktop.locator('[data-slot="health-row"]').count()).toBe(2);
  } finally {
    await browser?.close();
    await app.close();
  }
});

test("health makes a failed refresh visibly stale while retaining the last successful check", async () => {
  const snapshot: HealthSnapshot = {
    generatedAt: new Date().toISOString(),
    reachableAddress: "http://forge.tailnet.ts.net:4111",
    ready: true,
    checks: [
      { id: "database", label: "SQLite database", status: "healthy", summary: "WAL is enabled", details: {} },
    ],
  };
  const app = createApp({
    config: createTestConfig("/tmp/forge-health-stale-browser-test"),
    health: {
      temporal: async () => snapshot.checks[0]!,
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
      worker: async () => snapshot.checks[0]!,
      codexAuth: async () => snapshot.checks[0]!,
      ghAuth: async () => snapshot.checks[0]!,
    },
    getHealth: async () => snapshot,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/health`);
    await page.locator('[data-health-freshness="current"]').first().waitFor();
    await page.route("**/api/health", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
    });

    await page.getByRole("button", { name: "Refresh health" }).click();
    await page.locator('[data-health-freshness="stale"]').first().waitFor();
    expect(await page.locator('[data-health-freshness="stale"]').first().innerText()).toMatch(/^Stale · /);
    expect(await page.getByText("SQLite database", { exact: true }).isVisible()).toBe(true);
  } finally {
    await browser?.close();
    await app.close();
  }
});

test("legacy cached user and company records never render before the current session is authenticated", async () => {
  const snapshot: HealthSnapshot = {
    generatedAt: new Date().toISOString(),
    reachableAddress: "http://forge.tailnet.ts.net:4111",
    ready: true,
    checks: [],
  };
  const app = createApp({
    config: createTestConfig("/tmp/forge-health-cache-browser-test"),
    health: {
      temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }),
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
      worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
      codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
      ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    },
    getHealth: async () => snapshot,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Test server did not expose a TCP address");

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.localStorage.setItem("forge.user", JSON.stringify({ id: "prior-user", displayName: "Prior-session user", role: "admin", status: "active", companyIds: ["prior-company"] }));
      window.localStorage.setItem("forge.companies", JSON.stringify([{ id: "prior-company", name: "Prior-session company", status: "active", createdAt: "2026-08-11T00:00:00.000Z" }]));
      (window as Window & { __forgeSawPriorSessionTenant?: boolean }).__forgeSawPriorSessionTenant = false;
      new MutationObserver(() => {
        if (document.body.innerText.includes("Prior-session company") || document.body.innerText.includes("Prior-session user")) {
          (window as Window & { __forgeSawPriorSessionTenant?: boolean }).__forgeSawPriorSessionTenant = true;
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });

    await page.goto(`http://127.0.0.1:${address.port}/health`);
    await page.locator("h1").waitFor();
    await expect.poll(() => page.evaluate(() => ({
      user: window.localStorage.getItem("forge.user"),
      companies: window.localStorage.getItem("forge.companies"),
    }))).toEqual({ user: null, companies: null });
    expect(await page.evaluate(() => (window as Window & { __forgeSawPriorSessionTenant?: boolean }).__forgeSawPriorSessionTenant)).toBe(false);
  } finally {
    await browser?.close();
    await app.close();
  }
});
