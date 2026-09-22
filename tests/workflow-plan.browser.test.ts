import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { taskDeliveryTargetOptions } from "../src/frontend/features/tasks/task-delivery-target.js";
import { nativeBrowser } from "./helpers/native-browser.js";

const proof = resolve(".context/workflow-plan-proof");
const workflows = ["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"] as const;

test.each([1440, 900, 390])("workflow plans are prospective, connected, and independent at %ipx", { timeout: 120_000 }, async width => {
  const value = await nativeBrowser(width);
  const { page } = value;
  try {
    await mkdir(proof, { recursive: true });
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    for (const workflow of workflows) {
      const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: `${workflow} workflow map`, description: "Map fixture", idempotencyKey: `workflow-map-${workflow}-${width}`, startImmediately: false, workflow: workflow === "refine_pull_request" ? "independent_review" : workflow });
      if (workflow === "refine_pull_request") value.database.authTransaction(db => db.prepare("UPDATE suplex_task_controls SET workflow = 'refine_pull_request', delivery_target = 'merged' WHERE task_id = ?").run(task.id));
      await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
      await page.getByRole("heading", { name: `${workflow} workflow map`, level: 2, exact: true }).waitFor();
      const plan = page.locator(`[data-workflow-plan="${workflow}"]`);
      await plan.getByText("Workflow plan", { exact: true }).waitFor();
      const planTrigger = plan.getByRole("button", { name: "Open or close the workflow plan" });
      expect(await planTrigger.getAttribute("aria-expanded")).toBe("false");
      await plan.getByRole("list", { name: /workflow stations/ }).waitFor({ state: "hidden" });
      await planTrigger.click();
      await plan.getByRole("list", { name: /workflow stations/ }).waitFor({ state: "visible" });
      expect(await planTrigger.getAttribute("aria-expanded")).toBe("true");
       expect(await plan.getByRole("list", { name: /workflow stations/ }).getByRole("listitem").count()).toBeGreaterThan(2);
       expect(await plan.getByRole("list", { name: /workflow relationships/ }).getByRole("listitem").count()).toBeGreaterThan(2);
      expect(await plan.locator("svg path[data-workflow-edge]").count()).toBeGreaterThan(2);
      expect(await plan.locator("svg marker path").count()).toBe(1);
       expect(await plan.locator("[data-workflow-station]").evaluateAll(stations => stations.every(station => { const bounds = station.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0; }))).toBe(true);
       expect(await plan.locator("[data-workflow-station]").evaluateAll(stations => stations.every((station, index) => {
         const a = station.getBoundingClientRect();
         return stations.slice(index + 1).every(other => {
           const b = other.getBoundingClientRect();
           return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
         });
       }))).toBe(true);
       expect(await plan.locator("[data-workflow-edge]").evaluateAll(edges => edges.every(edge => { const bounds = edge.getBoundingClientRect(); return bounds.width > 0 || bounds.height > 0; }))).toBe(true);
        expect(await plan.locator("[data-workflow-edge-label]").evaluateAll(labels => labels.every(label => { const bounds = label.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && Number.parseFloat(getComputedStyle(label).fontSize) >= 12; }))).toBe(true);
        expect(await plan.locator("[data-workflow-edge-label]").evaluateAll(labels => labels.every((label, index) => {
          const a = label.getBoundingClientRect();
          return labels.slice(index + 1).every(other => {
            const b = other.getBoundingClientRect();
            return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          });
        }))).toBe(true);
        expect(await plan.locator("[data-workflow-edge-label]").evaluateAll(labels => labels.flatMap(label => {
         const a = label.getBoundingClientRect();
         return Array.from(document.querySelectorAll("[data-workflow-station]")).flatMap(station => {
           const b = station.getBoundingClientRect();
           return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top ? [] : [`${label.getAttribute("data-workflow-edge-label")}:${station.getAttribute("data-workflow-station")}`];
         });
        }))).toEqual([]);
        expect(await plan.locator("[data-workflow-station]").evaluateAll(stations => stations.every(station => station.scrollHeight <= station.clientHeight))).toBe(true);
      expect(await plan.innerText()).not.toMatch(/Completed|In progress|Delivered|Merged$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(proof, `${workflow}-${width}.png`), fullPage: true, animations: "disabled" });
      if (workflow === "competing_plans") {
        expect(await plan.locator('[data-workflow-edge="objective-plan-a"]').count()).toBe(1);
        expect(await plan.locator('[data-workflow-edge="objective-plan-b"]').count()).toBe(1);
        expect(await plan.locator('[data-workflow-edge="plan-a-combine"]').count()).toBe(1);
        expect(await plan.locator('[data-workflow-edge="plan-b-combine"]').count()).toBe(1);
      }
      if (workflow === "independent_review") {
        expect(await plan.locator('[data-workflow-edge="reviewer-target"]').count()).toBe(1);
        expect(await plan.locator('[data-workflow-edge="inspection-reviewer"]').count()).toBe(1);
        expect(await plan.getByText("Fresh review", { exact: true }).count()).toBe(1);
      }
      if (workflow === "refine_pull_request") {
        expect(await plan.locator('[data-workflow-edge="rater-push"]').count()).toBe(1);
        expect(await plan.locator('[data-workflow-edge="repair-rater"]').count()).toBe(1);
        expect(await plan.locator('[data-workflow-edge="repair-push"]').count()).toBe(0);
        expect(await plan.getByText("9/10+, no blockers, verified checks", { exact: true }).count()).toBe(1);
      }
      await plan.screenshot({ path: join(proof, `${workflow}-diagram-${width}.png`), animations: "disabled" });
    }
    for (const option of taskDeliveryTargetOptions) {
      const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: `${option.value} target map`, description: "Target fixture", idempotencyKey: `workflow-target-${option.value}-${width}`, startImmediately: false, workflow: "standard", deliveryTarget: option.value });
      await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
      const targetPlan = page.locator('[data-workflow-plan="standard"]');
      await targetPlan.getByRole("button", { name: "Open or close the workflow plan" }).click();
      await targetPlan.getByText(option.label, { exact: true }).waitFor();
    }
    const standard = value.tasks.listTasks(value.userId).find(task => task.title === "standard workflow map")!;
    await page.route(`**/api/tasks/${standard.id}/execution`, route => route.fulfill({ json: { sessions: [{ id: "root", role: "root", generation: 1, available: true, limited: false, plan: [{ content: "Coordinator plan remains separate", status: "pending" }], tools: [] }] } }));
    await page.goto(`${value.base}/tasks/${standard.id}?company=${value.company.id}`);
     const trigger = page.getByRole("button", { name: "Open or close the workflow plan", exact: true });
     await trigger.waitFor();
     expect(await trigger.getAttribute("aria-expanded")).toBe("false");
     await page.getByRole("list", { name: "Standard workflow stations" }).waitFor({ state: "hidden" });
     await trigger.focus();
     await page.keyboard.press("Enter");
     await page.getByRole("list", { name: "Standard workflow stations" }).waitFor({ state: "visible" });
     expect(await trigger.getAttribute("aria-expanded")).toBe("true");
     await page.keyboard.press("Enter");
     await page.getByRole("list", { name: "Standard workflow stations" }).waitFor({ state: "hidden" });
     expect(await trigger.getAttribute("aria-expanded")).toBe("false");
     await page.screenshot({ path: join(proof, `standard-collapsed-${width}.png`), fullPage: true, animations: "disabled" });
     await page.keyboard.press("Enter");
     await page.getByRole("list", { name: "Standard workflow stations" }).waitFor({ state: "visible" });
     expect(await trigger.getAttribute("aria-expanded")).toBe("true");
     await page.keyboard.press("Enter");
     await page.getByRole("list", { name: "Standard workflow stations" }).waitFor({ state: "hidden" });
     expect(await trigger.getAttribute("aria-expanded")).toBe("false");
     expect(await page.getByText("Coordinator plan remains separate", { exact: true }).isVisible()).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
