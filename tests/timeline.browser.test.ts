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
      { id: "root-turn", role: "root", agentId: "root:profile_native_root", agentName: "Sol", avatarSeed: "profile_native_root", status: "completed", attempt: 1, startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: new Date(now - 1_800_000).toISOString() },
      { id: "worker-turn", role: "worker", agentId: "worker:profile_native_worker", agentName: "Luna", avatarSeed: "profile_native_worker", status: "completed", attempt: 1, startedAt: new Date(now - 1_800_000).toISOString(), finishedAt: new Date(now - 600_000).toISOString() },
    ] }] };
    const { page } = value;
    await page.route(`**/api/companies/${value.company.id}/timeline`, route => route.fulfill({ json: data }));
    await page.goto(`${value.base}/timeline?company=${value.company.id}`);
    await page.locator("[data-work-timeline]").waitFor();
    await page.getByRole("link", { name: /Sol worked on/ }).waitFor();
    await page.getByRole("link", { name: /Luna worked on/ }).waitFor();
    await page.getByText("Root · 1× · 30m", { exact: true }).waitFor();
    await page.getByText("Worker · 1× · 20m", { exact: true }).waitFor();
    expect(await page.getByRole("img", { name: "Sol avatar" }).getAttribute("src")).toContain("/api/avatars/profile_native_root");
    expect(await page.getByRole("img", { name: "Luna avatar" }).getAttribute("src")).toContain("/api/avatars/profile_native_worker");
    const trim = page.getByRole("checkbox", { name: "Trim blank time" });
    expect(await trim.count()).toBe(0);
    const chart = page.locator("[data-work-timeline]");
    await expect.poll(() => chart.getAttribute("data-range-start")).toBe(String(now - 3_600_000));
    expect(await chart.getAttribute("data-range-end")).toBe(String(now - 600_000));
    const viewport = page.getByRole("button", { name: "Drag timeline viewport", exact: true });
    expect(await viewport.evaluate(element => Number.parseFloat(element.style.width))).toBeLessThan(1);
    await page.screenshot({ path: join(tmpdir(), `forge-timeline-default-${width}.png`), fullPage: true });
    const reset = page.getByRole("button", { name: "Reset zoom", exact: true });
    expect(await reset.isEnabled()).toBe(true);
    await reset.click();
    await expect.poll(async () => Number(await chart.getAttribute("data-range-start"))).toBeLessThan(now - 3_600_000);
    expect(Number(await chart.getAttribute("data-range-end"))).toBeGreaterThan(now);
    await page.getByText("Some session history is not available. Totals include available history only.").waitFor();
    await page.getByRole("region", { name: "Ticket totals" }).getByRole("link", { name: /Timeline task/ }).waitFor();
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
    data.tasks = [];
    await page.reload();
    await chart.waitFor();
    await page.getByText("No agent activity in this range.").waitFor();
    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() - 6);
    const endDate = new Date(now);
    endDate.setHours(24, 0, 0, 0);
    expect(await chart.getAttribute("data-range-start")).toBe(String(startDate.getTime()));
    expect(await chart.getAttribute("data-range-end")).toBe(String(endDate.getTime()));
    await page.screenshot({ path: join(tmpdir(), `forge-timeline-empty-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
