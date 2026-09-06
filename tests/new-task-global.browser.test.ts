import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("New Task opens in place from every view at %ipx", { timeout: 45_000 }, async width => {
  const f = await nativeBrowser(width);
  try {
    const { page } = f;
    for (const path of ["/projects", "/timeline", "/tasks", "/board"]) {
      await page.goto(`${f.base}${path}?company=${f.company.id}`);
      if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "New Task", exact: true }).click();
      await page.getByRole("dialog").getByLabel("Task title", { exact: true }).waitFor({ timeout: 3000 });
      expect(new URL(page.url()).pathname).toBe(path);
      expect(await page.getByRole("dialog").count()).toBe(1);
      await page.keyboard.press("Escape");
      expect(new URL(page.url()).pathname).toBe(path);
    }
    await page.goto(`${f.base}/projects?company=${f.company.id}`);
    await page.getByRole("heading", { name: "Projects", exact: true }).first().waitFor();
    if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /New task/ }).click();
    await page.getByRole("dialog").getByLabel("Task title", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/projects");
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Projects", exact: true }).first().click();
    await page.keyboard.press("c");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task title", { exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), `forge-global-new-task-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByLabel("Task title", { exact: true }).fill("Created from Projects");
    await dialog.getByLabel("Task description", { exact: true }).fill("One click opens the dialog.");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await page.waitForURL(url => url.pathname.startsWith("/tasks/"));
    expect(f.tasks.listTasks(f.userId, f.company.id)).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
