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
      const trigger = plan.getByRole("button", { name: "Open or close the workflow plan" });
      expect(await trigger.getAttribute("aria-expanded")).toBe("false");
      await plan.locator(`[data-workflow-illustration="${workflow}"]`).waitFor({ state: "hidden" });
      await trigger.click();
      await plan.locator(`[data-workflow-illustration="${workflow}"]`).waitFor({ state: "visible" });
      expect(await trigger.getAttribute("aria-expanded")).toBe("true");
      expect(await plan.locator(`[data-workflow-illustration="${workflow}"] svg`).count()).toBeGreaterThanOrEqual(2);
      expect(await plan.locator("[data-illustration-station]").count()).toBeGreaterThan(2);
      expect(await plan.locator("[data-illustration-route]").count()).toBeGreaterThan(2);
      expect(await plan.locator("button").count()).toBe(1);
      expect(await plan.innerText()).not.toMatch(/Completed|In progress|Delivered|Merged$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    for (const option of taskDeliveryTargetOptions) {
      const task = await value.createTask({ title: `${option.value} target map`, description: "Target fixture", idempotencyKey: `workflow-target-${option.value}-${width}`, startImmediately: false, workflow: "standard", deliveryTarget: option.value });
      await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
      const plan = page.locator('[data-workflow-plan="standard"]');
      await plan.getByRole("button", { name: "Open or close the workflow plan" }).click();
      await plan.getByText(option.label, { exact: true }).waitFor();
    }
    await page.route(`**/api/tasks/${standardTaskId}/execution`, route => route.fulfill({ json: { sessions: [{ id: "root", role: "root", generation: 1, available: true, limited: false, plan: [{ content: "Coordinator plan remains separate", status: "pending" }], tools: [] }] } }));
    await page.goto(`${value.base}/tasks/${standardTaskId}?company=${value.company.id}`);
    const trigger = page.getByRole("button", { name: "Open or close the workflow plan", exact: true });
    await trigger.waitFor();
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-workflow-plan="standard"] [data-workflow-illustration="standard"]').waitFor({ state: "visible" });
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("Enter");
    await page.locator('[data-workflow-plan="standard"] [data-workflow-illustration="standard"]').waitFor({ state: "hidden" });
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByText("Coordinator plan remains separate", { exact: true }).isVisible()).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
