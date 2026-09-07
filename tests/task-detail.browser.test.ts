import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const desktopViewport = 1280;

test("native task detail supports answers, cancellation and safe archive refusal", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Native task detail", description: "Preserve the existing branch changes.", startImmediately: true, idempotencyKey: "native-detail" });
    const store = value.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindHarnessSession({ sessionId: root.id, generation: root.generation, nativeSessionId: "ses_browser_root" });
    store.askHuman(task.id, "Which base branch should I use?");
    const { page } = value;
    await page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await page.getByRole("heading", { name: "Native task detail", level: 2, exact: true }).waitFor();
    await page.locator("[data-app-header]").getByRole("button", { name: "Task options", exact: true }).waitFor();
    await page.getByRole("region", { name: "Question" }).getByText("Which base branch should I use?").waitFor();
    await page.getByLabel("Answer", { exact: true }).fill("Use main and preserve local work.");
    await page.getByRole("button", { name: "Answer and continue", exact: true }).click();
    await page.getByRole("region", { name: "Question" }).waitFor({ state: "hidden" });
    expect(store.get(task.id).status).toBe("active");
    expect(store.pendingTurns(root.id).some(turn => turn.promptText.includes("Use main and preserve local work."))).toBe(true);
    const uncertain = store.pendingTurns(root.id)[0]!;
    store.requireExecutionCleanup(uncertain);
    await page.reload();
    await page.getByLabel("Answer", { exact: true }).fill("I stopped the old commands and checked the worktree.");
    expect(await page.getByRole("button", { name: "Answer and continue", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("checkbox", { name: "All commands from this session have stopped", exact: true }).check();
    await page.getByRole("button", { name: "Answer and continue", exact: true }).click();
    await page.getByRole("region", { name: "Question" }).waitFor({ state: "hidden" });
    expect(store.get(task.id).recoveryTurnId).toBeNull();
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Cancel task", exact: true }).click();
    await page.getByText("Cancelled", { exact: true }).first().waitFor();
    expect(store.get(task.id).status).toBe("cancelled");
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive task", exact: true }).click();
    await page.getByText("The task server identity is missing. Confirm that its commands have stopped before cleanup.", { exact: true }).waitFor();
    expect(value.tasks.getTask(value.userId, task.id).archivedAt).toBeNull();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("backlog details save through the interface", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Original title", description: "Original description", startImmediately: false, idempotencyKey: "backlog-edit" });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Edit task title" }).click();
    await value.page.getByLabel("Task title", { exact: true }).fill("Updated title");
    await value.page.getByLabel("Task description", { exact: true }).fill("Updated objective");
    await value.page.getByRole("button", { name: "Save task", exact: true }).click();
    await value.page.getByRole("heading", { name: "Updated title", level: 2, exact: true }).waitFor();
    expect(value.tasks.getTask(value.userId, task.id)).toMatchObject({ title: "Updated title", description: "Updated objective", status: "backlog" });
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
