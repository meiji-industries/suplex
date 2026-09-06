import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { TaskAnalyticsStore } from "../src/task-analytics-store.js";
import { TaskUsageSchema } from "../src/task-usage.js";
import { TaskTimelineResponseSchema } from "../src/task-timeline-contracts.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("Activity restores recorded Coordinator and Worker Gantt lanes at %ipx", { timeout: 45_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Agent timeline", description: "Show repeated execution and idle gaps.", startImmediately: true, idempotencyKey: "activity-gantt" });
    const controls = value.tasks.repository.controls;
    const root = controls.claimRoot({ taskId: task.id });
    controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_gantt_root" });
    const worker = controls.launchWorker({ taskId: task.id, rootSessionId: root.id, rootGeneration: root.generation, instruction: "Implement the plan" });
    controls.bindHarnessSession({ sessionId: worker.id, generation: worker.generation, nativeSessionId: "ses_gantt_worker" });
    const store = new TaskAnalyticsStore(value.database);
    const start = Date.now() - 60_000;
    for (const [index, session] of [root, worker, root].entries()) {
      store.record(task.id, session.id, [TaskUsageSchema.parse({ sessionId: session.kind === "root" ? "ses_gantt_root" : "ses_gantt_worker", messageId: `message-${index}`, turnId: `turn-${index}`, role: session.kind, provider: "openai", model: "test", startedAt: start + index * 20_000, completedAt: start + index * 20_000 + 10_000, failed: false, summary: false, steps: 1, cost: 0, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message" })]);
    }
    controls.markDelivered(task.id);
    value.tasks.repository.setArchived(task.id, true);
    const { page } = value;
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("tab", { name: /^Activity/ }).click();
    const timeline = page.getByRole("region", { name: "Task timeline", exact: true });
    await timeline.getByText("Elapsed 50s", { exact: true }).waitFor();
    expect(await timeline.getByRole("list", { name: "Coordinator executions" }).getByRole("listitem").count()).toBe(2);
    expect(await timeline.getByRole("list", { name: "Worker executions" }).getByRole("listitem").count()).toBe(1);
    expect(await timeline.locator("[data-task-timing-active]").count()).toBe(0);
    const first = timeline.locator('[data-task-timing="root"]').first();
    await first.focus();
    expect(await first.getAttribute("title")).toContain("10s. Completed.");
    expect(await first.evaluate(element => element.style.width)).toBe("20%");
    const scroller = timeline.getByLabel("Task timeline Gantt chart", { exact: true });
    if (width < 768) {
      await scroller.evaluate(element => { element.scrollLeft = 120; });
      expect(await scroller.evaluate(element => element.scrollLeft)).toBe(120);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `forge-task-activity-timeline-${width}.png`), fullPage: true });
    const data = TaskTimelineResponseSchema.parse(await (await page.request.get(`${value.base}/api/tasks/${task.id}/timeline`)).json());
    const live = data.tasks[0]?.activity.at(-1);
    if (!live) throw new Error("Missing recorded execution");
    live.finishedAt = null;
    live.status = "running";
    let offline = false;
    await page.route(`**/api/tasks/${task.id}/timeline`, route => offline ? route.fulfill({ status: 503, json: { error: "offline" } }) : route.fulfill({ json: data }));
    await timeline.locator("[data-task-timing-active]").waitFor();
    expect(await timeline.locator("[data-task-timing-active]").evaluate(element => getComputedStyle(element).animationName)).toBe("phase-timing-candy-stripes");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await timeline.locator("[data-task-timing-active]").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.screenshot({ path: join(tmpdir(), `forge-task-activity-live-${width}.png`), fullPage: true });
    offline = true;
    await timeline.getByText("Timeline is not available.", { exact: true }).waitFor();
    expect(await timeline.locator("[data-task-timing-active]").count()).toBe(0);
    expect(await timeline.getByRole("listitem").count()).toBe(3);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
