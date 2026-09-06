import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";
import { TaskAnalyticsStore } from "../src/task-analytics-store.js";
import { TaskUsageSchema } from "../src/task-usage.js";

test.each([1280, 390])("analytics reads durable costs, filters tasks and links to details at %ipx", async width => {
  const value = await nativeBrowser(width);
  try {
    const store = new TaskAnalyticsStore(value.database);
    for (let index = 0; index < 6; index++) {
      const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: `Analytics task ${index + 1}`, description: "Recorded usage", startImmediately: false, idempotencyKey: `analytics-browser-${index}` });
      for (let step = 0; step < 4; step++) store.record(task.id, `forge-${index}`, [TaskUsageSchema.parse({
        sessionId: `ses-${index}`, messageId: `msg-${step}`, turnId: `user-${step}`, role: step % 2 ? "worker" : "root",
        provider: "openai", model: step % 2 ? "gpt-5.6-luna" : "gpt-5.6-sol", startedAt: Date.now() - (step + 1) * 86_400_000,
        completedAt: Date.now() - (step + 1) * 86_400_000 + 300_000, failed: index === 4 && step === 0,
        summary: false, steps: 3, cost: (index + 1) * 0.1, tokens: { input: 2000, output: 500, reasoning: 1000, cache: { read: 8000, write: 500 } }, source: "steps",
      })]);
      if (index < 3) { value.tasks.repository.controls.start(task.id); value.tasks.repository.controls.markDelivered(task.id); }
    }
    const { page } = value;
    await page.goto(`${value.base}/analytics?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Task ledger 6" }).waitFor();
    expect(await page.getByText("$8.40", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByText("50%", { exact: true }).count()).toBeGreaterThan(0);
    await page.screenshot({ path: join(tmpdir(), `forge-analytics-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("combobox", { name: "Creation period" }).click();
    await page.getByRole("option", { name: "Created at any time" }).click();
    await page.getByRole("textbox", { name: "Search analytics tasks" }).fill("no-match");
    await page.getByText("No tasks match these filters.").waitFor();
    await page.getByRole("textbox", { name: "Search analytics tasks" }).fill("task 1");
    const ledger = page.getByRole("region", { name: "Task analytics" });
    expect(await ledger.getByRole("link").count()).toBe(1);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    expect((await download).suggestedFilename()).toBe("forge-task-analytics.csv");
    await ledger.getByRole("link", { name: /Analytics task 1/ }).click();
    await page.getByRole("complementary", { name: "Task properties" }).getByText("$0.40", { exact: true }).waitFor();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
