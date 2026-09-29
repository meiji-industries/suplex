import { expect, test } from "vitest";
import { taskDeliveryTargetOptions } from "../src/frontend/features/tasks/task-delivery-target.js";
import { nativeBrowser } from "./helpers/native-browser.js";

const workflows = ["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"] as const;

test.each([1440, 900, 390])("workflow plans use the shared illustration at %ipx", { timeout: 120_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    let standardTaskId = "";
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    for (const workflow of workflows) {
      const task = await value.createTask({ title: `${workflow} workflow map`, description: "Map fixture", idempotencyKey: `workflow-map-${workflow}-${width}`, startImmediately: false, workflow: workflow === "refine_pull_request" ? "independent_review" : workflow });
      if (workflow === "refine_pull_request") value.database.prepare("UPDATE suplex_task_controls SET workflow = 'refine_pull_request', delivery_target = 'merged' WHERE task_id = ?").run(task.id);
      if (workflow === "standard") standardTaskId = task.id;
      await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
      await page.getByRole("heading", { name: `${workflow} workflow map`, level: 2, exact: true }).waitFor();
      const plan = page.locator(`[data-workflow-plan="${workflow}"]`);
      await plan.locator(`[data-workflow-illustration="${workflow}"]`).waitFor({ state: "visible" });
      expect(await plan.locator(`[data-workflow-illustration="${workflow}"] svg`).count()).toBeGreaterThanOrEqual(2);
      expect(await plan.locator("[data-illustration-station]").count()).toBeGreaterThan(2);
      expect(await plan.locator("[data-illustration-route]").count()).toBeGreaterThan(2);
      expect(await plan.locator("button").count()).toBe(0);
      expect(await plan.innerText()).not.toMatch(/Completed|In progress|Delivered|Merged$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    for (const option of taskDeliveryTargetOptions) {
      const task = await value.createTask({ title: `${option.value} target map`, description: "Target fixture", idempotencyKey: `workflow-target-${option.value}-${width}`, startImmediately: false, workflow: "standard", deliveryTarget: option.value });
      await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
      const plan = page.locator('[data-workflow-plan="standard"]');
      expect(await plan.locator("desc").first().textContent()).toContain(`Delivery: ${option.label}.`);
    }
    await page.route(`**/api/tasks/${standardTaskId}/execution`, route => route.fulfill({ json: { sessions: [{ id: "root", role: "root", generation: 1, available: true, limited: false, plan: [{ content: "Coordinator plan remains separate", status: "pending" }], tools: [], reasoning: [] }] } }));
    await page.goto(`${value.base}/tasks/${standardTaskId}?company=${value.company.id}`);
    await page.locator('[data-workflow-plan="standard"] [data-workflow-illustration="standard"]').waitFor({ state: "visible" });
    expect(await page.getByText("Coordinator plan remains separate", { exact: true }).isVisible()).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
