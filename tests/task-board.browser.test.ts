import { expect, test } from "vitest";
import { TaskSchema } from "../src/frontend/contracts/tasks.js";
import { AgentProfileSchema } from "../src/frontend/contracts/profiles.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("tasks can be created, started and viewed on the board at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const { page } = value;
    const duplicate = await value.api("POST", "/api/admin/profiles/profile_native_root/duplicate");
    expect(duplicate.status).toBe(201);
    const alternate = AgentProfileSchema.parse(duplicate.body);
    const createdIds: string[] = [];
    await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    for (const immediate of [true, false]) {
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      const newTask = page.getByRole("button", { name: "New task", exact: true });
      if (!(await newTask.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
      await newTask.click();
      const dialog = page.getByRole("dialog", { name: "New task", exact: true });
      await dialog.getByLabel("Task title", { exact: true }).fill(`Task ${immediate}`);
      await dialog.getByLabel("Task description", { exact: true }).fill("Use the native Coordinator and Worker");
      if (immediate) {
        const diagram = dialog.getByRole("group", { name: "Standard workflow", exact: true });
        await diagram.getByRole("button", { name: /^Coordinator assignee:/ }).first().press("Enter");
        await page.getByRole("menuitemradio").filter({ hasText: alternate.name }).press("Enter");
        expect(await diagram.getByRole("button", { name: `Coordinator assignee: ${alternate.name}`, exact: true }).count()).toBe(2);
      } else {
        await dialog.getByRole("combobox", { name: "Workflow", exact: true }).click();
        await page.getByRole("option", { name: "Combined planning", exact: true }).click();
        const diagram = dialog.getByRole("group", { name: "Combined planning workflow", exact: true });
        await diagram.getByRole("button", { name: /^Plan A assignee:/ }).click();
        await page.getByRole("menuitemradio").filter({ hasText: alternate.name }).click();
        await dialog.getByRole("combobox", { name: "Delivery target", exact: true }).click();
        await page.getByRole("option", { name: "Push branch", exact: true }).click();
        expect(await diagram.textContent()).toContain("Push branch");
      }
      const response = page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/companies/${value.company.id}/tasks`));
      if (immediate) await dialog.getByLabel("Task description", { exact: true }).press("Control+Enter");
      else {
        await dialog.getByRole("button", { name: "Task start options", exact: true }).click();
        await page.getByRole("menuitem", { name: "Create in backlog", exact: true }).click();
      }
      const created = await response;
      expect(created.status(), await created.text()).toBe(201);
      const task = TaskSchema.parse(await created.json());
      expect(created.request().postDataJSON()).toMatchObject({ startImmediately: immediate, ...(immediate ? { rootProfileId: alternate.id } : { advisorProfileIds: { planner_a: alternate.id } }) });
      expect(task.deliveryTarget).toBe(immediate ? "pull_request_draft" : "remote_branch");
      createdIds.push(task.id);
      expect(task.workflow).toBe(immediate ? "standard" : "competing_plans");
      expect(task.status).toBe(immediate ? "active" : "backlog");
      await page.getByRole("heading", { name: `Task ${immediate}`, level: 2, exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Start task", exact: true }).count()).toBe(immediate ? 0 : 1);
      if (!immediate) {
        const started = page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${task.id}/start`));
        await page.getByRole("button", { name: "Start task", exact: true }).click();
        expect((await started).status()).toBe(200);
        expect((await value.api("GET", `/api/tasks/${task.id}`)).body).toMatchObject({ status: "active" });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.goto(`${value.base}/tasks?company=${value.company.id}`);
    }
    await page.goto(`${value.base}/board?company=${value.company.id}`);
    await page.getByRole("region", { name: "Active", exact: true }).waitFor();
    for (const id of createdIds) expect(await page.locator(`a[href*="/board/${id}"]`).count()).toBe(1);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
