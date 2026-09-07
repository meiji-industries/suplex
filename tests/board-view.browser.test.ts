import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const evidenceDirectory = join(process.cwd(), ".tmp", "forge-kanban-text-evidence");

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

test.each([1280, 390])("board cards clip long text within columns at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const title = `Long board title ${"unbroken-title-token-".repeat(12)}`;
    const questionText = `Long human question ${"with spaced text ".repeat(14)}`;
    const project = await value.projects.updateProject(value.userId, value.project.id, { ...value.project, repository: value.project.repository!, name: `Project ${"with a long label ".repeat(3)}end` });
    const { task } = await value.tasks.createTask(value.userId, value.company.id, {
      projectId: project.id,
      title,
      description: "Verify board text containment.",
      startImmediately: true,
      idempotencyKey: `board-text-${width}`,
    });
    const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    value.tasks.repository.controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: `ses_board_text_${width}` });
    value.tasks.repository.controls.askHuman(task.id, questionText);
    const { page } = value;
    const boardView = page.getByRole("combobox", { name: "Board view", exact: true });

    await page.goto(`${value.base}/board?company=${value.company.id}`);
    await page.getByRole("region", { name: "Answer necessary", exact: true }).waitFor();
    await mkdir(evidenceDirectory, { recursive: true });
    for (const view of ["Compact View", "Full View"] as const) {
      if (view === "Full View") {
        await boardView.click();
        await page.getByRole("option", { name: view, exact: true }).click();
      }
      const column = page.getByRole("region", { name: "Answer necessary", exact: true });
      const card = column.getByRole("link", { name: new RegExp(title) });
      expect((await column.boundingBox())?.width).toBe(288);
      const icons = card.locator("svg");
      expect(await icons.count()).toBe(2);
      expect(await icons.nth(0).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0);
      expect(await icons.nth(1).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0);
      const titleLine = card.locator(":scope > span").first().locator(":scope > span");
      const questionLine = card.getByText(questionText, { exact: true });
      const projectLine = card.getByText(project.name, { exact: true });

      for (const line of [titleLine, questionLine, projectLine]) {
        expect(await line.evaluate(element => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflow: getComputedStyle(element).overflow,
          textOverflow: getComputedStyle(element).textOverflow,
          whiteSpace: getComputedStyle(element).whiteSpace,
        }))).toMatchObject({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        expect(await line.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      }
      const bounds = await Promise.all([column, card].map(locator => locator.boundingBox()));
      expect(bounds[0]).not.toBeNull();
      expect(bounds[1]).not.toBeNull();
      expect(bounds[1]!.x).toBeGreaterThanOrEqual(bounds[0]!.x);
      expect(bounds[1]!.x + bounds[1]!.width).toBeLessThanOrEqual(bounds[0]!.x + bounds[0]!.width);
      if (view === "Full View") expect(await page.locator("[data-task-board]").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidenceDirectory, `board-long-text-${width}-${view === "Compact View" ? "compact" : "full"}.png`), fullPage: true });
    }
    await page.getByRole("region", { name: "Answer necessary", exact: true }).getByRole("link", { name: new RegExp(title) }).click();
    await page.getByRole("complementary", { name: "Task properties" }).waitFor();
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    await page.locator("[data-task-row]").filter({ hasText: title }).waitFor();
    expect(value.errors).toEqual([]);
  } finally {
    await value.close();
  }
});
