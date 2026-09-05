import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("Escape clears task search without changing the filter or route at %ipx", async width => {
  const value = await nativeBrowser(width);
  try {
    for (const title of ["Keyboard search task", "Another backlog task", "Active task"]) {
      await value.tasks.createTask(value.userId, value.company.id, {
        projectId: value.project.id, title, description: title,
        startImmediately: title === "Active task", idempotencyKey: title.replaceAll(" ", "-"),
      });
    }
    const { page } = value;
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    const list = page.locator("[data-task-list]");
    await list.getByText("Keyboard search task", { exact: true }).waitFor();
    const backlog = page.getByRole("tab", { name: "Backlog", exact: true });
    await backlog.click();
    const rows = list.locator("[data-task-row]");
    expect(await rows.count()).toBe(2);
    const search = page.getByLabel("Search tasks", { exact: true });
    const route = page.url();
    await search.fill("  KEYBOARD  ");
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().textContent()).toContain("Keyboard search task");
    await search.press("Escape");
    await expect.poll(() => rows.count()).toBe(2);
    expect(await search.inputValue()).toBe("");
    expect(await search.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await list.getByText("Active task", { exact: true }).count()).toBe(0);
    expect(await backlog.getAttribute("aria-selected")).toBe("true");
    expect(page.url()).toBe(route);
    await search.fill("no matching title");
    await list.getByText("No tasks match the search.", { exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `forge-merged-search-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
