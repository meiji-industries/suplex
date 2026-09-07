import { join } from "node:path";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("Recent tasks show spinning status and pull request state at %ipx", { timeout: 45_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const create = (title: string) => value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title, description: "Check sidebar indicators.", startImmediately: true, idempotencyKey: title.replaceAll(" ", "-") });
    const { task: active } = await create("Working task");
    const { task: waiting } = await create("Waiting task");
    const { task: billed } = await create("Billed task");
    const store = value.tasks.repository.controls;
    store.askHuman(waiting.id, "Which branch?");
    store.setPullRequest(active.id, { repository: "owner/repo", number: 10, url: "https://github.com/owner/repo/pull/10", headSha: "a".repeat(40), state: "open", mergedAt: null });
    const { page } = value;
    const oldStatusChangedAt = new Date(Date.now() - 300_001).toISOString();
    await page.route(`**/api/companies/${value.company.id}/task-costs`, route => route.fulfill({ json: { tasks: [
      { id: active.id, cost: 0.12, unpriced: false, subsidized: true, partial: false },
      { id: waiting.id, cost: null, unpriced: true, subsidized: false, partial: true },
      { id: billed.id, cost: 0.34, unpriced: false, subsidized: false, partial: false },
    ] } }));
    await page.route(`**/api/tasks/${active.id}/checks`, route => route.fulfill({ json: { available: true, pullRequestState: "ready", runs: [{ name: "Failed", status: "failing", url: null }, { name: "Running", status: "pending", url: null }] } }));
    let workerStatus = "working";
    await page.route(`**/api/tasks/${active.id}/agents`, route => route.fulfill({ json: { agents: [
      { id: "root", role: "root", paneId: "wProof:p1", status: "idle", statusChangedAt: oldStatusChangedAt },
      { id: "worker", role: "worker", paneId: "wProof:p2", status: workerStatus, statusChangedAt: oldStatusChangedAt },
      { id: "queued", role: "worker", paneId: null, status: "queued", statusChangedAt: oldStatusChangedAt },
      { id: "waiting", role: "root", paneId: null, status: "waiting_human", statusChangedAt: oldStatusChangedAt },
      { id: "stopped", role: "worker", paneId: null, status: "stopped", statusChangedAt: oldStatusChangedAt },
    ] } }));
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const working = page.getByRole("link", { name: "Working task, Active, pull request open", exact: true });
    await working.waitFor();
    const estimated = working.getByText("$0.12", { exact: true });
    await estimated.waitFor();
    expect(await estimated.getAttribute("title")).toContain("OpenCode reported zero cost");
    expect(await estimated.getAttribute("aria-label")).toContain("models.dev list price");
    const billedRow = page.getByRole("link", { name: "Billed task, Active", exact: true });
    const billedCost = billedRow.getByText("$0.34", { exact: true });
    await billedCost.waitFor();
    expect(await page.locator('[data-slot="sidebar"]').getByText("Unpriced", { exact: true }).count()).toBe(0);
    const createButton = page.locator('[data-slot="sidebar"]').getByRole("button", { name: "New task", exact: true });
    expect(await createButton.evaluate(element => element.closest('[data-sidebar="menu"]') === null)).toBe(true);
    expect(await createButton.evaluate(element => getComputedStyle(element.parentElement!).padding)).toBe("8px");
    await page.locator('[data-sidebar="group-label"]').filter({ hasText: /^Activity$/ }).waitFor();
    expect(await page.getByRole("link", { name: "Get Help", exact: true }).count()).toBe(0);
    await page.getByText("Worker · Working", { exact: true }).waitFor();
    await page.getByText("Worker · Queued", { exact: true }).waitFor();
    await page.getByText("Coordinator · Answer necessary", { exact: true }).waitFor();
    expect(await page.getByText("Coordinator · Idle", { exact: true }).count()).toBe(0);
    expect(await page.getByText("Worker · Stopped", { exact: true }).count()).toBe(0);
    workerStatus = "retrying";
    await page.getByText("Worker · Retry", { exact: true }).waitFor();
    workerStatus = "unknown";
    await page.getByText("Worker · Not available", { exact: true }).waitFor();
    workerStatus = "working";
    await page.getByText("Worker · Working", { exact: true }).waitFor();
    await page.goto(`${value.base}/profile?company=${value.company.id}`);
    const expiry = page.getByRole("combobox", { name: "Inactive task agents", exact: true });
    await expiry.waitFor();
    expect(await expiry.innerText()).toContain("5 minutes");
    await expiry.click();
    await page.getByRole("option", { name: "Immediately", exact: true }).waitFor();
    expect(await page.getByRole("option").allTextContents()).toEqual(["Immediately", "1 minute", "5 minutes", "15 minutes", "1 hour", "6 hours", "24 hours"]);
    await page.getByRole("option", { name: "Immediately", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("forge.taskAgentExpiry"))).toBe("0");
    await page.reload();
    expect(await page.getByRole("combobox", { name: "Inactive task agents", exact: true }).innerText()).toContain("Immediately");
    await page.evaluate(() => localStorage.setItem("forge.taskAgentExpiry", "invalid"));
    await page.reload();
    expect(await page.getByRole("combobox", { name: "Inactive task agents", exact: true }).innerText()).toContain("5 minutes");
    await page.getByRole("combobox", { name: "Inactive task agents", exact: true }).click();
    await page.getByRole("option", { name: "Immediately", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    if (width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByText("Worker · Working", { exact: true }).waitFor();
    await page.getByText("Worker · Queued", { exact: true }).waitFor();
    await page.getByText("Coordinator · Answer necessary", { exact: true }).waitFor();
    expect(await page.getByText("Coordinator · Idle", { exact: true }).count()).toBe(0);
    expect(await page.getByText("Worker · Stopped", { exact: true }).count()).toBe(0);
    expect(await working.locator("[data-recent-task-status]").evaluate(element => getComputedStyle(element).animationName)).toBe("spin");
    const workingItem = page.locator('[data-sidebar="menu-item"]').filter({ has: working });
    await workingItem.locator('[data-recent-pull-request="open"] svg').waitFor();
    expect(await workingItem.locator("[data-pr-color]").getAttribute("data-pr-color")).toBe("red");
    expect(await workingItem.getByRole("button", { name: "Archive task", exact: true }).count()).toBe(0);
    const waitingRow = page.getByRole("link", { name: "Waiting task, Answer necessary", exact: true });
    expect(await waitingRow.locator("[data-recent-task-status]").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    expect(await waitingRow.locator("[data-recent-pull-request]").count()).toBe(0);
    store.setPullRequest(active.id, { repository: "owner/repo", number: 10, url: "https://github.com/owner/repo/pull/10", headSha: "a".repeat(40), state: "merged", mergedAt: new Date().toISOString() });
    store.markDelivered(active.id);
    const delivered = page.getByRole("link", { name: "Working task, Delivered, pull request merged", exact: true });
    await delivered.waitFor();
    const deliveredItem = page.locator('[data-sidebar="menu-item"]').filter({ has: delivered });
    expect(await delivered.locator("[data-recent-task-status]").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await deliveredItem.locator('[data-recent-pull-request="merged"]').waitFor();
    await expect.poll(() => deliveredItem.locator("[data-pr-color]").getAttribute("data-pr-color")).toBe("purple");
    const archive = deliveredItem.getByRole("button", { name: "Archive task", exact: true });
    await archive.waitFor();
    expect(await archive.evaluate(element => element.closest("a"))).toBe(null);
    const pullRequestIcon = archive.locator('[data-pr-icon="pull-request"]');
    const archiveIcon = archive.locator('[data-pr-icon="archive"]');
    expect(await pullRequestIcon.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
    expect(await archiveIcon.evaluate(element => getComputedStyle(element).opacity)).toBe("0");
    const before = await archive.boundingBox();
    await archive.hover();
    await expect.poll(() => pullRequestIcon.evaluate(element => getComputedStyle(element).opacity)).toBe("0");
    await expect.poll(() => archiveIcon.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
    const afterHover = await archive.boundingBox();
    expect(afterHover?.width).toBe(before?.width);
    await archive.focus();
    await expect.poll(() => pullRequestIcon.evaluate(element => getComputedStyle(element).opacity)).toBe("0");
    await expect.poll(() => archiveIcon.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
    await page.screenshot({ path: join(tmpdir(), `forge-recent-icons-${width}.png`), fullPage: true, animations: "disabled" });
    const beforeUrl = page.url();
    await archive.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("heading", { name: "Archive task?" }).waitFor();
    expect(page.url()).toBe(beforeUrl);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await archive.waitFor();
    const archiveUrl = `**/api/tasks/${active.id}/archive`;
    const archiveBodies: Array<{ confirmDiscardDirty?: boolean }> = [];
    await page.route(archiveUrl, async route => {
      archiveBodies.push(JSON.parse(route.request().postData() ?? "{}") as { confirmDiscardDirty?: boolean });
      if (archiveBodies.length === 1) {
        await route.fulfill({ json: { status: "confirmation_required", dirtyFileCount: 1, dirtyFilePaths: ["src/app.ts"] } });
        return;
      }
      await route.continue();
    });
    await archive.click();
    await dialog.getByRole("button", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("heading", { name: "Discard 1 uncommitted change and archive?" }).waitFor();
    expect(archiveBodies).toEqual([{ confirmDiscardDirty: false }]);
    await rm(value.project.repositoryPath, { recursive: true, force: true });
    await dialog.getByRole("button", { name: "Discard changes and archive", exact: true }).click();
    await expect.poll(() => delivered.count()).toBe(0);
    await expect.poll(() => value.tasks.getTask(value.userId, active.id).archivedAt).not.toBeNull();
    expect(archiveBodies).toEqual([{ confirmDiscardDirty: false }, { confirmDiscardDirty: true }]);
    await page.unroute(archiveUrl);
    await dialog.waitFor({ state: "hidden" });
    await page.screenshot({ path: join(tmpdir(), `forge-recent-icons-archived-${width}.png`), fullPage: true, animations: "disabled" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
