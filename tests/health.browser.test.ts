import assert from "node:assert/strict";
import { test } from "vitest";

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
  assert.ok(address && typeof address === "object");

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/health`);
    await assert.doesNotReject(() => page.locator("h1").waitFor());
    await assert.doesNotReject(() => page.getByRole("heading", { name: "Owned services", exact: true }).waitFor());
    assert.equal(await page.locator('[data-status="healthy"]').count(), 1);
    assert.equal(await page.locator('[data-status="unhealthy"]').count(), 1);
    assert.equal(await page.locator('[data-slot="health-row"]').count(), 2);
    assert.match(await page.locator("body").innerText(), /forge\.tailnet\.ts\.net/);
    assert.doesNotMatch(await page.locator("body").innerText(), /Truthful readiness/);

    const navigationTrigger = page.getByRole("button", { name: "Open navigation" });
    await navigationTrigger.click();
    assert.equal(await page.locator('[data-slot="mobile-nav"]').isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await navigationTrigger.evaluate((element) => element === document.activeElement), true);

    await page.locator('[data-slot="health-row"]').first().locator("button").click();
    await assert.doesNotReject(() => page.getByText("walMode").waitFor());
    const apiHealth = await page.evaluate(async () => {
      const response = await fetch("/api/health");
      return { status: response.status, body: await response.json() as { ready: boolean } };
    });
    assert.equal(apiHealth.status, 200);
    assert.equal(apiHealth.body.ready, true);

    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(`http://127.0.0.1:${address.port}/health`);
    assert.equal(await desktop.locator("aside").isVisible(), true);
    assert.equal(await desktop.locator('[data-slot="health-row"]').count(), 2);
  } finally {
    await browser?.close();
    await app.close();
  }
});
