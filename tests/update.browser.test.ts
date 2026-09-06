import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("shows, closes, polls, and re-shows a new update revision at %ipx", { timeout: 120_000 }, async (width) => {
  const value = await nativeBrowser(width);
  let reads = 0;
  try {
    await value.page.route("**/api/update", async (route) => {
      reads += 1;
      await route.fulfill({ json: { available: true, revision: reads < 3 ? "revision-a" : "revision-b" } });
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
