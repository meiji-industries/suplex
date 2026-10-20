import { expect, test } from "vitest";
import { TaskSchema } from "../apps/web/contracts/tasks.js";
import { AgentProfileSchema } from "../apps/web/contracts/profiles.js";
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
      const newTask = page.getByRole("button", { name: "New task", exact: true }).first();
      if (!(await newTask.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
      await newTask.click();
      const dialog = page.getByRole("dialog", { name: "New task", exact: true });
      await dialog.getByLabel("Task title", { exact: true }).fill(`Task ${immediate}`);
      await dialog.getByLabel("Task description", { exact: true }).fill("Use the native Coordinator and Worker");
      if (immediate) {
        const diagram = dialog.getByRole("group", { name: "Plan and build workflow", exact: true });
        await diagram.getByRole("button", { name: /^Coordinator assignee:/ }).first().press("Enter");
        await page.getByRole("menuitemradio").filter({ hasText: alternate.name }).press("Enter");
        expect(await diagram.getByRole("button", { name: `Coordinator assignee: ${alternate.name}`, exact: true }).count()).toBe(2);
      } else {
        await dialog.getByRole("button", { name: "Workflow", exact: true }).click();
        await page.getByRole("option", { name: "Double plans", exact: true }).click();
        const diagram = dialog.getByRole("group", { name: "Double plans workflow", exact: true });
        await diagram.getByRole("button", { name: /^Plan A assignee:/ }).click();
        await page.getByRole("menuitemradio").filter({ hasText: alternate.name }).click();
        await dialog.getByRole("button", { name: "Delivery target", exact: true }).click();
        await page.getByRole("option", { name: "push branch", exact: true }).click();
        expect(await diagram.textContent()).toContain("Push branch");
      }
      await dialog.getByRole("button", { name: "Task start mode", exact: true }).click();
      await page.getByRole("menuitemradio", { name: immediate ? "Run" : "Backlog", exact: true }).click();
      const response = page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/companies/${value.company.id}/tasks`));
      if (immediate) await dialog.getByLabel("Task description", { exact: true }).press("Control+Enter");
      else await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      const created = await response;
      expect(created.status(), await created.text()).toBe(201);
      const task = TaskSchema.parse(await created.json());
      expect(created.request().postDataJSON()).toMatchObject({ startImmediately: immediate, ...(immediate ? { rootProfileId: alternate.id } : { advisorProfileIds: { planner_a: alternate.id } }) });
      expect(task.deliveryTarget).toBe(immediate ? "pull_request_ready" : "remote_branch");
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
    // Started tasks can leave Active before the board loads, so wait for each card in any column.
    for (const id of createdIds) await page.locator(`[data-task-board] a[href*="/board/${id}"]`).waitFor();
    if (width === 1280) {
      // Drag a Backlog card to Queued. The server decides the resulting status.
      const backlog = await value.createTask({ title: "Drag example", description: "Move by drag", startImmediately: false, idempotencyKey: "board-drag" });
      await page.reload();
      const card = page.locator(`[data-task-board] a[href*="/board/${backlog.id}"]`);
      const started = page.waitForResponse(candidate => candidate.url().endsWith(`/api/tasks/${backlog.id}/start`));
      // Compact mode shows the empty Queued column only while you drag, so press, move, and then target it.
      await card.hover();
      await page.mouse.down();
      await page.mouse.move(0, 0, { steps: 2 });
      await page.getByRole("region", { name: "Queued", exact: true }).hover();
      await page.mouse.up();
      expect((await started).status()).toBe(200);
      expect((await value.api("GET", `/api/tasks/${backlog.id}`)).body).not.toMatchObject({ status: "backlog" });
      expect(new URL(page.url()).pathname).toBe("/board");
      // Keyboard only: G then B opens the board, J or Down moves to a card, Enter opens it, and Tab reaches the message field.
      // A delivered task accepts a message without a running agent.
      const target = (await value.createTask({ title: "Keyboard example", description: "Open by keyboard", startImmediately: false, idempotencyKey: "board-keyboard" })).id;
      value.database.prepare("UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id = ?").run(target);
      await page.goto(`${value.base}/tasks?company=${value.company.id}`);
      await page.locator("[data-task-list] [data-shortcut-item]").first().waitFor();
      await page.keyboard.press("g");
      await page.keyboard.press("b");
      await page.waitForURL(url => url.pathname === "/board");
      await page.locator(`[data-task-board] a[href*="/board/${target}"]`).waitFor();
      const focused = (): Promise<string> => page.evaluate(() => `${document.activeElement?.getAttribute("href") ?? ""}|${document.activeElement?.getAttribute("aria-label") ?? ""}`);
      for (let step = 0; step < 20 && !(await focused()).includes(`/board/${target}`); step++) await page.keyboard.press(step % 2 ? "ArrowDown" : "j");
      expect(await focused()).toContain(`/board/${target}`);
      await page.keyboard.press("Enter");
      await page.waitForURL(url => url.pathname === `/board/${target}`);
      await page.locator("[data-task-detail-header] h2").waitFor();
      for (let step = 0; step < 150 && !(await focused()).endsWith("|Message Coordinator"); step++) await page.keyboard.press("Tab");
      expect(await focused()).toMatch(/\|Message Coordinator$/);
      await page.keyboard.type("Keep the change small.");
      const sent = page.waitForResponse(candidate => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/tasks/${target}/note`));
      await page.keyboard.press("Enter");
      const note = await sent;
      expect(note.status(), await note.text()).toBe(200);
      expect(note.request().postDataJSON()).toEqual({ note: "Keep the change small." });
      // ? types into the field, so leave it first.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("?");
      const reference = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
      await reference.waitFor();
      await page.keyboard.press("Escape");
      await reference.waitFor({ state: "hidden" });
    }
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
