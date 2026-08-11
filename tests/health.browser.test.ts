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
