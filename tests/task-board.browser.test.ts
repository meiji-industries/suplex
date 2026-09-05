import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { TaskSchema } from "../src/task-contracts.js";
import { nativeApp } from "./helpers/native-app.js";

test.each([1280, 390])("native task creation preserves start intent and role choices at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeApp();
  const browser = await chromium.launch({ headless: true });
  try {
    await value.app.listen({ host: "127.0.0.1", port: 0 });
    const address = value.app.server.address();
    if (!address || typeof address === "string") throw new Error("No browser test address");
    const base = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addCookies(value.headers.cookie.split("; ").map(pair => {
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: "127.0.0.1", path: "/" };
    }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/tasks?company=${value.company.id}`);
    for (const immediate of [true, false]) {
      await page.getByRole("button", { name: "Create task", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const rootSelector = dialog.getByRole("button", { name: /^Root assignee:/ });
      await rootSelector.click();
      await page.getByRole("menu").getByText("Root", { exact: true }).waitFor();
      const rootOption = page.getByRole("menuitemradio", { name: /Root · gpt-5.6-sol/ });
      await rootOption.waitFor();
      expect(await rootOption.locator('[data-slot="avatar"]').count()).toBe(1);
      expect(await page.getByRole("menuitemradio", { name: /Worker ·/ }).count()).toBe(0);
      await page.getByRole("menu").evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
      await page.screenshot({ path: join(tmpdir(), `forge-new-task-root-menu-${width}.png`) });
      await rootOption.click();
      expect(await rootSelector.locator('[data-slot="avatar"]').count()).toBe(1);
      await page.getByRole("menuitemradio", { name: "Project default", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await dialog.getByRole("button", { name: /^Worker assignee:/ }).click();
      await page.getByRole("menu").getByText("Worker", { exact: true }).waitFor();
      await page.getByRole("menuitemradio", { name: /Worker · gpt-5.6-luna/ }).waitFor();
      expect(await page.getByRole("menuitemradio", { name: /Root ·/ }).count()).toBe(0);
      await page.getByRole("menuitemradio", { name: "Project default", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await dialog.getByLabel("Task title", { exact: true }).fill(`Task ${immediate}`);
      await dialog.getByLabel("Task description", { exact: true }).fill("Use the native Root and Worker");
      await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).setChecked(immediate);
      await page.screenshot({ path: join(tmpdir(), `forge-native-create-${width}-${immediate}.png`) });
      const response = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/companies/${value.company.id}/tasks`));
      if (immediate) await dialog.getByLabel("Task description", { exact: true }).press("Control+Enter");
      else await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      const created = await response;
      expect(created.status(), await created.text()).toBe(201);
      const task = TaskSchema.parse(await created.json());
      expect(task.status).toBe(immediate ? "active" : "backlog");
      expect(value.wakes.includes(task.id)).toBe(immediate);
      await page.getByRole("heading", { name: `Task ${immediate}`, level: 2, exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Start task", exact: true }).count()).toBe(immediate ? 0 : 1);
      if (!immediate) {
        const started = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${task.id}/start`));
        await page.getByRole("button", { name: "Start task", exact: true }).click();
        expect((await started).status()).toBe(200);
        await expect.poll(() => value.wakes.includes(task.id)).toBe(true);
      }
      await page.screenshot({ path: join(tmpdir(), `forge-native-task-${width}-${immediate}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.goto(`${base}/tasks?company=${value.company.id}`);
    }
    await page.goto(`${base}/board?company=${value.company.id}`);
    await page.getByRole("region", { name: "Active", exact: true }).waitFor();
    expect(await page.getByRole("region", { name: "Active", exact: true }).getByRole("link").count()).toBe(2);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await value.close(); }
});
