import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("Recent tasks show spinning status and pull request state at %ipx", { timeout: 45_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const create = (title: string) => value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title, description: "Check sidebar indicators.", startImmediately: true, idempotencyKey: title.replaceAll(" ", "-") });
    const { task: active } = await create("Working task");
    const { task: waiting } = await create("Waiting task");
    const store = value.tasks.repository.controls;
    store.askHuman(waiting.id, "Which branch?");
    store.setPullRequest(active.id, { repository: "owner/repo", number: 10, url: "https://github.com/owner/repo/pull/10", headSha: "a".repeat(40), state: "open", mergedAt: null });
    const { page } = value;
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const working = page.getByRole("link", { name: "Working task, Active, pull request open", exact: true });
    await working.waitFor();
    expect(await working.locator("[data-recent-task-status]").evaluate(element => getComputedStyle(element).animationName)).toBe("spin");
    await working.locator('[data-recent-pull-request="open"] svg').waitFor();
    const waitingRow = page.getByRole("link", { name: "Waiting task, Answer necessary", exact: true });
    expect(await waitingRow.locator("[data-recent-task-status]").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    expect(await waitingRow.locator("[data-recent-pull-request]").count()).toBe(0);
    store.setPullRequest(active.id, { repository: "owner/repo", number: 10, url: "https://github.com/owner/repo/pull/10", headSha: "a".repeat(40), state: "merged", mergedAt: new Date().toISOString() });
    store.markDelivered(active.id);
    const delivered = page.getByRole("link", { name: "Working task, Delivered, pull request merged", exact: true });
    await delivered.waitFor();
    expect(await delivered.locator("[data-recent-task-status]").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await delivered.locator('[data-recent-pull-request="merged"] svg').waitFor();
    await page.screenshot({ path: join(tmpdir(), `forge-recent-icons-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
