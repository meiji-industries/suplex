import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TaskAnalyticsStore } from "../src/task-analytics-store.js";
import { TaskUsageSchema } from "../src/task-usage.js";
import { TaskTimelineResponseSchema } from "../src/task-timeline-contracts.js";
import { nativeBrowser } from "./helpers/native-browser.js";

const artifactDirectory = join(process.cwd(), "logs", "task-activity-timeline");

test.each([1280, 390])("Task detail shows recorded Coordinator and Worker Gantt lanes above tabs at %ipx", { timeout: 45_000 }, async width => {
  await mkdir(artifactDirectory, { recursive: true });
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
    const secondary = value.profiles.create(value.userId, { name: "Secondary Root", role: "root", avatarSeed: "2".repeat(32), provider: "openai", model: "gpt-5.5", reasoningLevel: "medium", serviceTier: "default" });
    const data = TaskTimelineResponseSchema.parse(await value.tasks.timeline(value.userId, [task.id]));
    data.tasks[0]?.activity.push({
      id: "secondary-root-turn", role: "root", agentId: `root:${secondary.id}`, agentName: "gpt-5.5", avatarSeed: secondary.id,
      status: "completed", attempt: 1, startedAt: new Date(start + 5_000).toISOString(), finishedAt: new Date(start + 10_000).toISOString(),
    });
    const { page } = value;
    let offline = false;
    await page.route(`**/api/tasks/${task.id}/timeline`, route => offline ? route.fulfill({ status: 503, json: { error: "offline" } }) : route.fulfill({ json: data }));
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    const timeline = page.getByRole("region", { name: "Task timeline", exact: true });
    await timeline.getByText("Worked for 35s during 50s", { exact: true }).waitFor();
    expect(await page.getByRole("tab", { name: "Chat", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect(await timeline.count()).toBe(1);
    expect(await timeline.evaluate(element => element.closest('[role="tabpanel"]'))).toBeNull();
    const timelineBox = await timeline.boundingBox();
    const tabListBox = await page.getByRole("tablist").boundingBox();
    if (!timelineBox || !tabListBox) throw new Error("Missing timeline or tab list bounds");
    expect(timelineBox.y + timelineBox.height).toBeLessThanOrEqual(tabListBox.y);
    await timeline.getByText("Coordinator · 2× · 20s", { exact: true }).waitFor();
    await timeline.getByText("Worker · 1× · 10s", { exact: true }).waitFor();
    await timeline.getByText("Coordinator · 1× · 5s", { exact: true }).waitFor();
    expect(await timeline.getByRole("list", { name: "gpt-5.6-sol executions" }).getByRole("listitem").count()).toBe(2);
    expect(await timeline.getByRole("list", { name: "gpt-5.6-luna executions" }).getByRole("listitem").count()).toBe(1);
    expect(await timeline.getByRole("list", { name: "gpt-5.5 executions" }).getByRole("listitem").count()).toBe(1);
    expect(await timeline.locator('[data-task-agent-id="root:profile_native_root"]').count()).toBe(2);
    expect(await timeline.locator(`[data-task-agent-id="root:${secondary.id}"]`).count()).toBe(1);
    expect(await timeline.getByRole("img", { name: "gpt-5.6-sol avatar" }).getAttribute("src")).toContain("/api/avatars/profile_native_root");
    expect(await timeline.getByRole("img", { name: "gpt-5.5 avatar" }).getAttribute("src")).toContain(`/api/avatars/${secondary.id}`);
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
    await page.getByRole("tab", { name: /^Activity/ }).click();
    expect(await timeline.isVisible()).toBe(true);
    expect(await timeline.count()).toBe(1);
    expect(await timeline.evaluate(element => element.closest('[role="tabpanel"]'))).toBeNull();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    expect(await timeline.isVisible()).toBe(true);
    expect(await timeline.count()).toBe(1);
    expect(await timeline.evaluate(element => element.closest('[role="tabpanel"]'))).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(artifactDirectory, `recorded-${width}.png`), fullPage: true });
    const live = data.tasks[0]?.activity.at(-1);
    if (!live) throw new Error("Missing recorded execution");
    live.finishedAt = null;
    live.status = "running";
    await page.clock.install();
    await page.clock.fastForward(5_000);
    await timeline.locator("[data-task-timing-active]").waitFor();
    expect(await timeline.locator("[data-task-timing-active]").evaluate(element => getComputedStyle(element).animationName)).toBe("phase-timing-candy-stripes");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await timeline.locator("[data-task-timing-active]").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.screenshot({ path: join(artifactDirectory, `live-${width}.png`), fullPage: true });
    offline = true;
    await page.clock.fastForward(5_000);
    await timeline.getByText("Timeline is not available.", { exact: true }).waitFor();
    expect(await timeline.locator("[data-task-timing-active]").count()).toBe(0);
    expect(await timeline.getByRole("listitem").count()).toBe(4);
    const offlineSummary = await timeline.getByText(/Worked for/).textContent();
    await page.clock.fastForward(2_000);
    expect(await timeline.getByText(/Worked for/).textContent()).toBe(offlineSummary);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test.each([1280, 390])("Activity counts overlapping Coordinator and Worker time separately at %ipx", { timeout: 45_000 }, async width => {
  await mkdir(artifactDirectory, { recursive: true });
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Overlapping agent timeline", description: "Show concurrent agent time.", startImmediately: true, idempotencyKey: "activity-gantt-overlap" });
    const controls = value.tasks.repository.controls;
    const root = controls.claimRoot({ taskId: task.id });
    controls.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_gantt_overlap_root" });
    const worker = controls.launchWorker({ taskId: task.id, rootSessionId: root.id, rootGeneration: root.generation, instruction: "Implement the plan" });
    controls.bindHarnessSession({ sessionId: worker.id, generation: worker.generation, nativeSessionId: "ses_gantt_overlap_worker" });
    const store = new TaskAnalyticsStore(value.database);
    const start = Date.now() - 7_300_000;
    for (const [session, offset, duration] of [[root, 0, 5_400_000], [worker, 1_800_000, 3_600_000]] as const) {
      store.record(task.id, session.id, [TaskUsageSchema.parse({ sessionId: session.kind === "root" ? "ses_gantt_overlap_root" : "ses_gantt_overlap_worker", messageId: `message-${session.id}`, turnId: `turn-${session.id}`, role: session.kind, provider: "openai", model: "test", startedAt: start + offset, completedAt: start + offset + duration, failed: false, summary: false, steps: 1, cost: 0, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message" })]);
    }
    controls.markDelivered(task.id);
    value.tasks.repository.setArchived(task.id, true);
    const { page } = value;
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("tab", { name: /^Activity/ }).click();
    const timeline = page.getByRole("region", { name: "Task timeline", exact: true });
    await timeline.getByText("Worked for 2h 30m during 1h 30m", { exact: true }).waitFor();
    expect(await timeline.getByText(/Worked for/).getAttribute("title")).toContain("Concurrent executions count separately.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(artifactDirectory, `overlap-${width}.png`), fullPage: true });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
