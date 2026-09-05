import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("native task detail supports answers, cancellation and archival at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Native task detail", description: "Preserve the existing branch changes.", startImmediately: true, idempotencyKey: "native-detail" });
    const store = value.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_browser_root" });
    store.askHuman(task.id, "Which base branch should I use?");
    const { page } = value;
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Native task detail", level: 2, exact: true }).waitFor();
    await page.getByRole("region", { name: "Question" }).getByText("Which base branch should I use?").waitFor();
    await page.getByLabel("Answer", { exact: true }).fill("Use main and preserve local work.");
    await page.getByRole("button", { name: "Answer and continue", exact: true }).click();
    await page.getByRole("region", { name: "Question" }).waitFor({ state: "hidden" });
    expect(store.get(task.id).status).toBe("active");
    expect(store.pendingTurns(root.id).some(turn => turn.promptText.includes("Use main and preserve local work."))).toBe(true);
    expect(await page.getByLabel("Note to Root", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Send note", exact: true }).count()).toBe(0);
    const uncertain = store.pendingTurns(root.id)[0]!;
    store.requireExecutionCleanup(uncertain);
    await page.reload();
    await page.getByLabel("Answer", { exact: true }).fill("I stopped the old commands and checked the worktree.");
    expect(await page.getByRole("button", { name: "Answer and continue", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("checkbox", { name: "All commands from this session have stopped", exact: true }).check();
    await page.getByRole("button", { name: "Answer and continue", exact: true }).click();
    await page.getByRole("region", { name: "Question" }).waitFor({ state: "hidden" });
    expect(store.get(task.id).recoveryTurnId).toBeNull();
    expect(await page.getByText("ses_browser_root", { exact: true }).isVisible()).toBe(false);
    await page.getByRole("tab", { name: "Other", exact: true }).click();
    await page.getByText("Runtime diagnostics", { exact: true }).click();
    await page.getByRole("region", { name: "Sessions", exact: true }).getByText("ses_browser_root", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    expect(await page.getByText(/Planner|Builder|Integrator|Start planning/).count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `forge-native-task-detail-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Cancel task", exact: true }).click();
    await page.getByText("Cancelled", { exact: true }).first().waitFor();
    expect(store.get(task.id).status).toBe("cancelled");
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Keep in archive", exact: true }).click();
    await expect.poll(() => value.tasks.getTask(value.userId, task.id).archivedAt).not.toBeNull();
    expect(value.tasks.getTask(value.userId, task.id).archivedAt).not.toBeNull();
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open from archive", exact: true }).click();
    await expect.poll(() => value.tasks.getTask(value.userId, task.id).archivedAt).toBeNull();
    expect(value.tasks.getTask(value.userId, task.id).archivedAt).toBeNull();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test.each([1280, 390])("backlog details save through the interface at %ipx", { timeout: 90_000 }, async width => {
  const value = await nativeBrowser(width);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Original title", description: "Original description", startImmediately: false, idempotencyKey: "backlog-edit" });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Edit task title" }).click();
    await value.page.getByLabel("Task title", { exact: true }).fill("Updated title");
    await value.page.getByLabel("Task description", { exact: true }).fill("Updated objective");
    await value.page.getByRole("button", { name: "Save task", exact: true }).click();
    await value.page.getByRole("heading", { name: "Updated title", level: 2, exact: true }).waitFor();
    expect(value.tasks.getTask(value.userId, task.id)).toMatchObject({ title: "Updated title", description: "Updated objective", status: "backlog" });
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
