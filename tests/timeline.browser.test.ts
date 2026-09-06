import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";
import type { TaskTimeline } from "../src/task-timeline-contracts.js";

test.each([1280, 390])("restored timeline shows native lanes, zoom and grouped totals at %ipx", async width => {
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Timeline task", description: "Recorded work", startImmediately: false, idempotencyKey: "timeline-browser" });
    const now = Date.now();
    const data: TaskTimeline = { unavailableSessions: 1, tasks: [{ id: task.id, projectId: value.project.id, issueKey: task.issueKey ?? null, title: task.title, activity: [
      { id: "root-turn", role: "root", agentId: "root-profile", agentName: "Sol", avatarSeed: "root", status: "completed", attempt: 1, startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: new Date(now - 1_800_000).toISOString() },
      { id: "worker-turn", role: "worker", agentId: "worker-profile", agentName: "Luna", avatarSeed: "worker", status: "completed", attempt: 1, startedAt: new Date(now - 1_800_000).toISOString(), finishedAt: new Date(now - 600_000).toISOString() },
    ] }] };
    const { page } = value;
    await page.route(`**/api/companies/${value.company.id}/timeline`, route => route.fulfill({ json: data }));
    await page.goto(`${value.base}/timeline?company=${value.company.id}`);
    await page.locator("[data-work-timeline]").waitFor();
    await page.getByRole("link", { name: /Sol worked on/ }).waitFor();
    await page.getByRole("link", { name: /Luna worked on/ }).waitFor();
    const trim = page.getByRole("checkbox", { name: "Trim blank time" });
    expect(await trim.isChecked()).toBe(true);
    const chart = page.locator("[data-work-timeline]");
    await expect.poll(() => chart.getAttribute("data-range-start")).toBe(String(now - 3_600_000));
    expect(await chart.getAttribute("data-range-end")).toBe(String(now - 600_000));
    await trim.click();
    await expect.poll(async () => Number(await chart.getAttribute("data-range-start"))).toBeLessThan(now - 3_600_000);
    expect(Number(await chart.getAttribute("data-range-end"))).toBeGreaterThan(now);
    await trim.click();
    await expect.poll(() => chart.getAttribute("data-range-start")).toBe(String(now - 3_600_000));
    await page.getByText("Some session history is not available. Totals include available history only.").waitFor();
    await page.getByRole("region", { name: "Ticket totals" }).getByRole("link", { name: /Timeline task/ }).waitFor();
    const reset = page.getByRole("button", { name: "Reset zoom", exact: true });
    expect(await reset.isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(await reset.isEnabled()).toBe(true);
    await reset.click();
    await page.getByRole("checkbox", { name: "Group by project" }).click();
    const group = page.locator("[data-project-header]");
    expect(await group.getAttribute("aria-expanded")).toBe("false");
    await group.click();
    await page.getByRole("region", { name: "Ticket totals" }).getByRole("link", { name: /Timeline task/ }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `forge-timeline-restored-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
