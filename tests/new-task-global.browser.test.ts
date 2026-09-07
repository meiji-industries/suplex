import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const narrowViewport = 390;

test("New task opens in place from Projects", { timeout: 45_000 }, async () => {
  const f = await nativeBrowser(narrowViewport);
  try {
    const { page } = f;
    await page.goto(`${f.base}/projects?company=${f.company.id}`);
    await page.getByRole("heading", { name: "Projects", exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Search Forge", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /New task/ }).click();
    await page.getByRole("dialog").getByLabel("Task title", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/projects");
    await page.keyboard.press("Escape");
    expect(new URL(page.url()).pathname).toBe("/projects");

    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.locator('[data-slot="sidebar"]').getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Task title", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/projects");
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Projects", exact: true }).first().click();
    await page.keyboard.press("c");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task title", { exact: true }).waitFor();
    await dialog.getByLabel("Task title", { exact: true }).fill("Created from Projects");
    await dialog.getByLabel("Task description", { exact: true }).fill("One click opens the dialog.");
    const submit = dialog.getByRole("button", { name: "New task", exact: true });
    await submit.click();
    await page.waitForURL(url => url.pathname.startsWith("/tasks/"));
    expect(f.tasks.listTasks(f.userId, f.company.id)).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
