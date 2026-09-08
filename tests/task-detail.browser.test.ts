import { expect, test } from "vitest";
import { join } from "node:path";
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

test("task worktree menu preserves copy feedback, keyboard access, and narrow layout", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(1280);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "A task title that remains usable on a narrow screen", description: "Open the checkout.", startImmediately: true, idempotencyKey: "worktree-menu" });
    const path = "/worktrees/narrow-task";
    value.tasks.repository.controls.setWorktree(task.id, { path, branch: task.configuration.branch, baseSha: "a", headSha: "a", dirty: false });
    await value.page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { document.documentElement.dataset.copiedPath = text; } } });
    });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    const openIn = value.page.getByRole("button", { name: "Open in", exact: true });
    await openIn.focus();
    await value.page.keyboard.press("Enter");
    expect(await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).count()).toBe(1);
    await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
    await value.page.getByText("Path copied", { exact: true }).waitFor();
    expect(await value.page.locator("html").getAttribute("data-copied-path")).toBe(path);
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await value.page.screenshot({ path: join(process.cwd(), "evidence/task-details-desktop-open-in.png"), animations: "disabled" });
    await value.page.setViewportSize({ width: 390, height: 844 });
    await openIn.click();
    await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).waitFor();
    expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await value.page.screenshot({ path: join(process.cwd(), "evidence/task-details-narrow-open-in.png"), animations: "disabled" });
    await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).press("Escape");
    await value.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
    await openIn.click();
    await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
    await value.page.getByText("Path copy failed", { exact: true }).waitFor();
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("task worktree menu loads deterministic applications and posts the selected application", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Launch application", description: "Open the checkout.", startImmediately: true, idempotencyKey: "worktree-app-launch" });
    value.tasks.repository.controls.setWorktree(task.id, { path: "/worktrees/app-launch", branch: task.configuration.branch, baseSha: "a", headSha: "a", dirty: false });
    await value.page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/worktree/apps")) return new Response(JSON.stringify({ apps: [{ id: "cursor", label: "Cursor" }] }), { headers: { "content-type": "application/json" } });
        if (url.endsWith("/worktree/open")) {
          document.documentElement.dataset.launch = init?.body?.toString() ?? "";
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
        }
        return fetch(input, init);
      };
    });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Open in", exact: true }).click();
    await value.page.getByRole("menuitem", { name: "Cursor", exact: true }).waitFor();
    await value.page.getByRole("menuitem", { name: "Cursor", exact: true }).press("Escape");
    await value.page.getByRole("button", { name: "Open in", exact: true }).click();
    await value.page.getByRole("menuitem", { name: "Cursor", exact: true }).click();
    expect(await value.page.locator("html").getAttribute("data-launch")).toBe('{"app":"cursor"}');
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("a non-loopback browser host offers copy only and does not request applications or launch", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport, "forge.test");
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Remote task", description: "Copy the checkout path.", startImmediately: true, idempotencyKey: "remote-worktree-menu" });
    value.tasks.repository.controls.setWorktree(task.id, { path: "/worktrees/remote", branch: task.configuration.branch, baseSha: "a", headSha: "a", dirty: false });
    const requests: string[] = [];
    await value.page.route("**/api/tasks/*/worktree/**", route => { requests.push(route.request().url()); return route.abort(); });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Open in", exact: true }).click();
    await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).waitFor();
    expect(await value.page.getByRole("menuitem", { name: "Finder", exact: true }).count()).toBe(0);
    expect(requests).toEqual([]);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("a task without a worktree has no worktree menu", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "No worktree", description: "Wait for the checkout.", startImmediately: true, idempotencyKey: "missing-worktree-menu" });
    await value.page.goto(`${value.base}/tasks/${task.id}?company=${value.company.id}`);
    expect(await value.page.getByRole("button", { name: "Open in", exact: true }).count()).toBe(0);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});

test("changing the displayed worktree path clears copy feedback", { timeout: 90_000 }, async () => {
  const value = await nativeBrowser(desktopViewport);
  try {
    const first = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "First path", description: "Copy the first path.", startImmediately: true, idempotencyKey: "first-worktree-path" });
    const second = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Second path", description: "Show another path.", startImmediately: true, idempotencyKey: "second-worktree-path" });
    value.tasks.repository.controls.setWorktree(first.task.id, { path: "/worktrees/first", branch: first.task.configuration.branch, baseSha: "a", headSha: "a", dirty: false });
    value.tasks.repository.controls.setWorktree(second.task.id, { path: "/worktrees/second", branch: second.task.configuration.branch, baseSha: "a", headSha: "a", dirty: false });
    await value.page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
    });
    await value.page.goto(`${value.base}/tasks/${first.task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Open in", exact: true }).click();
    await value.page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
    await value.page.getByText("Path copied", { exact: true }).waitFor();
    await value.page.goto(`${value.base}/tasks/${second.task.id}?company=${value.company.id}`);
    await value.page.getByRole("button", { name: "Open in", exact: true }).waitFor();
    expect(await value.page.getByText("Path copied", { exact: true }).count()).toBe(0);
    expect(value.errors).toEqual([]);
  } finally { await value.close(); }
});
