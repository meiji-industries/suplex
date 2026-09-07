import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { UPDATE_OPERATION_TIMEOUT_MS } from "../src/http/contracts/update.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("shows, closes, polls, and re-shows a new update revision at %ipx", { timeout: 120_000 }, async (width) => {
  const value = await nativeBrowser(width);
  let reads = 0;
  try {
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      await route.fulfill({ json: { available: true, revision: reads < 3 ? "revision-a" : "revision-b", canRestart: true } });
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    const notice = value.page.locator("[data-update-notice]");
    await notice.waitFor();
    expect(await notice.getAttribute("role")).toBe("status");
    expect(await notice.getAttribute("aria-live")).toBe("polite");
    expect(await notice.getAttribute("data-update-revision")).toBe("revision-a");
    await value.page.screenshot({ path: join(tmpdir(), `forge-update-notice-${width}.png`), fullPage: true });
    expect(await value.page.getByText("Update and restart Forge.", { exact: true }).isVisible()).toBe(true);
    expect(await value.page.getByRole("button", { name: "Restart Now", exact: true }).isVisible()).toBe(true);
    expect(await value.page.getByRole("button", { name: /Install/i }).count()).toBe(0);
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await value.page.getByRole("button", { name: "Close update notice", exact: true }).click();
    expect(await notice.count()).toBe(0);
    await value.page.clock.fastForward(60_000);
    await expect.poll(() => reads).toBe(2);
    expect(await notice.count()).toBe(0);
    await value.page.clock.fastForward(60_000);
    await notice.waitFor();
    expect(await notice.getAttribute("data-update-revision")).toBe("revision-b");
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});

test.each([1280, 390])("waits for a new server instance and running revision before one reload at %ipx", { timeout: 120_000 }, async (width) => {
  const value = await nativeBrowser(width);
  const targetRevision = "b".repeat(40);
  let reads = 0;
  let navigations = 0;
  let releaseReplacement!: () => void;
  const replacementReleased = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  try {
    value.page.on("framenavigated", (frame) => { if (frame === value.page.mainFrame()) navigations += 1; });
    await value.page.route("**/api/update/restart", async (route) => {
      await route.fulfill({ status: 202, json: { accepted: true, operation: { operationId: "browser-success-operation", status: "pending", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" } } });
    });
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true } });
        return;
      }
      await replacementReleased;
      await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: targetRevision, instanceId: "instance-new", canRestart: true, operation: { operationId: "browser-success-operation", status: "succeeded", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", message: "Forge restarted." } } });
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    navigations = 0;
    await value.page.getByRole("button", { name: "Restart Now", exact: true }).click();
    await expect.poll(() => value.page.getByRole("button", { name: "Restart Now", exact: true }).isDisabled()).toBe(true);
    releaseReplacement();
    await value.page.clock.fastForward(1_000);
    await expect.poll(() => navigations).toBe(1);
    expect(await value.page.url()).toBe(`${value.base}/tasks?company=${value.company.id}`);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    expect(value.errors).toEqual([]);
    await value.page.screenshot({ path: join(tmpdir(), `forge-update-restart-success-${width}.png`), fullPage: true });
  } finally {
    await value.close();
  }
});

test("keeps the notice and disables duplicate actions while the server is down", { timeout: 120_000 }, async () => {
  const value = await nativeBrowser(390);
  const targetRevision = "c".repeat(40);
  let reads = 0;
  try {
    await value.page.route("**/api/update/restart", async (route) => {
      await route.fulfill({ status: 202, json: { accepted: true, operation: { operationId: "browser-pending-operation", status: "pending", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" } } });
    });
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      if (reads > 1) return route.abort();
      await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true } });
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    const notice = value.page.locator("[data-update-notice]");
    await notice.waitFor();
    await value.page.getByRole("button", { name: "Restart Now", exact: true }).click();
    await expect.poll(() => value.page.getByRole("button", { name: "Restart Now", exact: true }).isDisabled()).toBe(true);
    await value.page.clock.fastForward(1_000);
    expect(await notice.isVisible()).toBe(true);
    expect(await value.page.locator("[data-update-status]").textContent()).toContain("starts");
    await value.page.screenshot({ path: join(tmpdir(), "forge-update-restart-pending-390.png"), fullPage: true });
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});

test("shows a restart failure and leaves an enabled retry action", { timeout: 120_000 }, async () => {
  const value = await nativeBrowser(1280);
  const targetRevision = "d".repeat(40);
  let reads = 0;
  try {
    await value.page.route("**/api/update/restart", async (route) => {
      await route.fulfill({ status: 202, json: { accepted: true, operation: { operationId: "browser-failure-operation", status: "pending", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" } } });
    });
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true } });
        return;
      }
      await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true, operation: { operationId: "browser-failure-operation", status: "failed", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", error: "The build failed. Retry the restart." } } });
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Restart Now", exact: true }).click();
    await value.page.clock.fastForward(1_000);
    await expect.poll(() => value.page.getByText("Restart failed. The build failed. Retry the restart.", { exact: true }).isVisible()).toBe(true);
    expect(await value.page.getByRole("button", { name: "Restart Now", exact: true }).isEnabled()).toBe(true);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    expect(value.errors).toEqual([]);
    await value.page.screenshot({ path: join(tmpdir(), "forge-update-restart-failure-1280.png"), fullPage: true });
  } finally {
    await value.close();
  }
});

test("keeps a restart timeout visible without auto-reattaching the operation", { timeout: 120_000 }, async () => {
  const value = await nativeBrowser(390);
  const targetRevision = "e".repeat(40);
  let reads = 0;
  try {
    await value.page.route("**/api/update/restart", async (route) => {
      await route.fulfill({ status: 202, json: { accepted: true, operation: { operationId: "browser-timeout-operation", status: "pending", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" } } });
    });
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true } });
        return;
      }
      await route.fulfill({ json: { available: true, revision: targetRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true, operation: { operationId: "browser-timeout-operation", status: "pending", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z" } } });
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Restart Now", exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await value.page.clock.fastForward(UPDATE_OPERATION_TIMEOUT_MS + 1_000);
    const timeoutMessage = "Restart failed. Forge did not prove the replacement server within the time limit. Retry the restart.";
    await expect.poll(() => value.page.getByText(timeoutMessage, { exact: true }).isVisible()).toBe(true);
    expect(await value.page.getByRole("button", { name: "Restart Now", exact: true }).isEnabled()).toBe(true);
    await value.page.clock.fastForward(60_000);
    await expect.poll(() => value.page.getByText(timeoutMessage, { exact: true }).isVisible()).toBe(true);
    expect(await value.page.getByRole("button", { name: "Restart Now", exact: true }).isEnabled()).toBe(true);
    await value.page.screenshot({ path: join(tmpdir(), "forge-update-restart-timeout-390.png"), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});

test.each([1280, 390])("posts the refreshed revision after a failed target observation at %ipx", { timeout: 120_000 }, async (width) => {
  const value = await nativeBrowser(width);
  const failedTargetRevision = "b".repeat(40);
  const refreshedRevision = "c".repeat(40);
  let reads = 0;
  let postedRevision: string | undefined;
  try {
    await value.page.route("**/api/update/restart", async (route) => {
      postedRevision = route.request().postDataJSON().revision;
      await route.fulfill({ status: 202, json: { accepted: true, operation: { operationId: "browser-refreshed-operation", status: "pending", targetRevision: refreshedRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" } } });
    });
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ json: { available: true, revision: refreshedRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true, operation: { operationId: "browser-failed-operation", status: "failed", targetRevision: failedTargetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", error: "The build failed. Retry the restart." } } });
        return;
      }
      await route.fulfill({ json: { available: true, revision: refreshedRevision, currentRevision: "a".repeat(40), instanceId: "instance-old", canRestart: true, operation: { operationId: "browser-refreshed-operation", status: "pending", targetRevision: refreshedRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" } } });
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Restart Now", exact: true }).click();
    await expect.poll(() => postedRevision).toBe(refreshedRevision);
    expect(await value.page.locator("[data-update-notice]").getAttribute("data-update-revision")).toBe(refreshedRevision);
    await value.page.screenshot({ path: join(tmpdir(), `forge-update-failed-target-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});

test("keeps the update notice hidden when the observation is not available or fails", { timeout: 120_000 }, async () => {
  const value = await nativeBrowser(390);
  let reads = 0;
  try {
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      if (reads === 1) await route.fulfill({ json: { available: false } });
      else await route.abort();
    });
    await value.page.clock.install();
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await value.page.locator("[data-app-header]").waitFor();
    await expect.poll(() => reads).toBe(1);
    expect(await value.page.locator("[data-update-notice]").count()).toBe(0);
    await value.page.clock.fastForward(60_000);
    await expect.poll(() => reads).toBe(2);
    expect(await value.page.locator("[data-update-notice]").count()).toBe(0);
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});
