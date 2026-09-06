import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { prepareTaskWorktree } from "../src/task-worktree.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test.each([1280, 390])("archive confirms dirty cleanup and returns to tasks at %ipx", { timeout: 45_000 }, async width => {
  const f = await nativeBrowser(width);
  const git = async (args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", cwd: f.project.repositoryPath, args })).stdout.trim();
  try {
    await git(["init", "-b", "main"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "seed"]);
    const startingSha = await git(["rev-parse", "HEAD"]);
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Archive example", description: "Keep the commits", startImmediately: true, idempotencyKey: "archive-ui" });
    const worktree = await prepareTaskWorktree({ taskId: task.id, ...task.configuration, startingSha });
    f.tasks.repository.controls.setWorktree(task.id, worktree);
    f.tasks.cancelTask(f.userId, task.id);
    await writeFile(join(worktree.path, "draft.txt"), "draft");
    await f.page.goto(`${f.base}/tasks/${task.id}?company=${f.company.id}`);
    await f.page.getByRole("button", { name: "Task options" }).click();
    await f.page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
    const dialog = f.page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("heading", { name: "Discard 1 uncommitted change and archive?" }).waitFor();
    expect(f.tasks.getTask(f.userId, task.id).archivedAt).toBeNull();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    await f.page.screenshot({ path: join(tmpdir(), `forge-archive-${width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Discard changes and archive", exact: true }).click();
    await f.page.waitForURL(url => url.pathname === "/tasks");
    expect(f.tasks.getTask(f.userId, task.id).archivedAt).not.toBeNull();
    await expect(access(worktree.path)).rejects.toThrow();
    expect(await git(["rev-parse", worktree.branch])).toBe(startingSha);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
