import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const evidenceDirectory = join(process.cwd(), ".forge", "task-evidence", "task_a44a898885d94f5c812770c1f0debffd");

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
    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: join(evidenceDirectory, `tasks-search-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test.each([390, 768, 900, 1280])("Tasks list keeps long task metadata aligned at %ipx", { timeout: 45_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const project = await value.projects.updateProject(value.userId, value.project.id, { ...value.project, repository: value.project.repository!, name: `Project ${"with a long label ".repeat(3)}end` });
    const taskTitles = ["Priced", "Zero", "Partial", "Missing"].map(label => `${label} task ${"with-a-long-unbroken-title-".repeat(3)}end`);
    const tasks = await Promise.all(taskTitles.map((title, index) => value.tasks.createTask(value.userId, value.company.id, {
      projectId: project.id, title, description: title, startImmediately: false, idempotencyKey: `task-columns-${width}-${index}`,
    })));
    const taskCosts = [
      { id: tasks[0]!.task.id, cost: 12.34, unpriced: false, subsidized: false, partial: false },
      { id: tasks[1]!.task.id, cost: 0, unpriced: false, subsidized: false, partial: false },
      { id: tasks[2]!.task.id, cost: 0.12, unpriced: false, subsidized: false, partial: true },
      { id: tasks[3]!.task.id, cost: null, unpriced: true, subsidized: false, partial: false },
    ];
    let costRequests = 0;
    await value.page.route(`**/api/companies/${value.company.id}/task-costs`, async route => {
      costRequests += 1;
      await route.fulfill({ json: { tasks: taskCosts } });
    });
    await value.page.goto(`${value.base}/tasks?company=${value.company.id}`);
    const rows = value.page.locator("[data-task-row]");
    await expect.poll(() => rows.count()).toBe(4);
    const costs = ["$12.34", "$0.00", "$0.12+", "Not available"];
    for (const [index, expectedCost] of costs.entries()) {
      const row = rows.filter({ hasText: taskTitles[index]! });
      await expect.poll(() => row.locator("[data-task-cost]").textContent()).toBe(expectedCost);
      await expect.poll(() => row.locator("[data-task-compact-cost]").textContent()).toBe(expectedCost);
    }
    expect(costRequests).toBeLessThanOrEqual(2);
    if (width >= 1024) {
      expect(await value.page.locator("[data-task-columns]").textContent()).toBe("TaskProjectStatusUpdatedCost");
      for (const row of await rows.all()) {
        expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(36);
        expect(await row.locator("[data-task-project]").textContent()).toContain(project.name);
        expect(await row.locator("[data-task-project] img").getAttribute("alt")).toBe(`${project.name} avatar`);
        for (const column of ["title", "project", "status", "time", "cost"]) {
          const header = await value.page.locator(`[data-task-columns] [data-task-column="${column}"]`).boundingBox();
          const cell = await row.locator(`[data-task-${column}]`).boundingBox();
          expect(cell?.x).toBe(header?.x);
          expect(cell?.width).toBe(header?.width);
        }
      }
    } else {
      expect(await value.page.locator("[data-task-columns]").isVisible()).toBe(false);
      for (const row of await rows.all()) {
        expect(await row.locator("[data-task-compact-project]").textContent()).toContain(project.name);
        expect(await row.locator("[data-task-compact-details]").isVisible()).toBe(true);
        expect(await row.locator("[data-task-time]").evaluate(element => getComputedStyle(element).textAlign)).toBe("right");
      }
    }
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir(evidenceDirectory, { recursive: true });
    await value.page.screenshot({ path: join(evidenceDirectory, `tasks-columns-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
