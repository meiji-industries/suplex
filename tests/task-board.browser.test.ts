import { chromium } from "playwright";
import { expect, test } from "vitest";
import { TaskSchema } from "../src/tasks/contracts.js";
import { nativeApp } from "./helpers/native-app.js";
import type { IssueAssociation } from "../src/tasks/issue-association.js";

test.each([1280, 390])("tasks can be created, started and viewed on the board at %ipx", { timeout: 90_000 }, async width => {
  const issue: IssueAssociation = { kind: "github", repository: "owner/repo", number: 42, id: "1042", key: "#42", title: "Associated issue", url: "https://github.com/owner/repo/issues/42" };
  const value = await nativeApp({ issueTracker: () => ({ read: async () => ({ issue, text: "Issue scope", capturedAt: new Date().toISOString() }) }) });
  value.projects.searchIssues = async () => [issue];
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
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      await page.keyboard.press("c");
      const dialog = page.getByRole("dialog", { name: "New task", exact: true });
      await dialog.getByLabel("Task title", { exact: true }).fill(`Task ${immediate}`);
      await dialog.getByLabel("Task description", { exact: true }).fill("Use the native Coordinator and Worker");
      await dialog.getByRole("checkbox", { name: "Start immediately", exact: true }).setChecked(immediate);
      if (immediate) {
        await dialog.getByRole("button", { name: "Select issue", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "Select issue", exact: true });
        await picker.getByRole("textbox", { name: "Search issues", exact: true }).fill("42");
        await picker.getByRole("button", { name: "#42: Associated issue", exact: true }).click();
      }
      const response = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/companies/${value.company.id}/tasks`));
      if (immediate) await dialog.getByLabel("Task description", { exact: true }).press("Control+Enter");
      else await dialog.getByRole("button", { name: "New task", exact: true }).click();
      const created = await response;
      expect(created.status(), await created.text()).toBe(201);
      const task = TaskSchema.parse(await created.json());
      expect(task.status).toBe(immediate ? "active" : "backlog");
      if (immediate) expect(task.issue).toEqual(issue);
      expect(value.wakes.includes(task.id)).toBe(immediate);
      await page.getByRole("heading", { name: `Task ${immediate}`, level: 2, exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Start task", exact: true }).count()).toBe(immediate ? 0 : 1);
      if (!immediate) {
        const started = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${task.id}/start`));
        await page.getByRole("button", { name: "Start task", exact: true }).click();
        expect((await started).status()).toBe(200);
        await expect.poll(() => value.wakes.includes(task.id)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.goto(`${base}/tasks?company=${value.company.id}`);
    }
    await page.goto(`${base}/board?company=${value.company.id}`);
    await page.getByRole("region", { name: "Active", exact: true }).waitFor();
    expect(await page.getByRole("region", { name: "Active", exact: true }).getByRole("link").count()).toBe(2);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await value.close(); }
});
