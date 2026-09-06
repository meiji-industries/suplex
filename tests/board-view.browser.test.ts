import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("board view switches between compact and full columns at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, {
      projectId: value.project.id,
      title: "Board view task",
      description: "Verify the board view selector.",
      startImmediately: false,
      idempotencyKey: `board-view-${width}`,
    });
    const { page } = value;
    const boardView = page.getByRole("combobox", { name: "Board view", exact: true });

    await page.goto(`${value.base}/board?company=${value.company.id}`);
    await page.getByRole("region", { name: "Backlog", exact: true }).waitFor();
    expect(await boardView.innerText()).toContain("Compact View");
    expect(await page.getByRole("region").count()).toBe(1);
    expect(await page.getByText("Hide empty columns", { exact: true }).count()).toBe(0);

    await boardView.click();
    await page.getByRole("option", { name: "Full View", exact: true }).click();
    expect(await page.getByRole("region").count()).toBe(5);
    expect(await page.locator("[data-task-board]").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/forge-board-view-${width}.png`, fullPage: true });

    await boardView.click();
    await page.getByRole("option", { name: "Compact View", exact: true }).click();
    expect(await page.getByRole("region").count()).toBe(1);

    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.locator("[data-task-row]").filter({ hasText: "Board view task" }).waitFor();
    expect(await page.getByRole("combobox", { name: "Board view", exact: true }).count()).toBe(0);
    await page.goto(`${value.base}/board/${task.id}?company=${value.company.id}`);
    await page.getByRole("complementary", { name: "Task properties" }).waitFor();
    expect(await page.getByRole("combobox", { name: "Board view", exact: true }).count()).toBe(0);
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});
