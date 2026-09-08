import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { prepareTaskWorktree } from "../src/task-worktree.js";
import { nativeBrowser } from "./helpers/native-browser.js";

test("archive confirms dirty cleanup and returns to tasks", { timeout: 45_000 }, async () => {
  const f = await nativeBrowser();
  const git = async (args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", cwd: f.project.repositoryPath, args })).stdout.trim();
  try {
    await git(["init", "-b", "main"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "seed"]);
    const startingSha = await git(["rev-parse", "HEAD"]);
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Archive example", description: "Keep the commits", startImmediately: true, idempotencyKey: "archive-ui" });
    const worktree = await prepareTaskWorktree({ taskId: task.id, ...task.configuration, startingSha });
    f.tasks.repository.controls.setWorktree(task.id, worktree);
    f.tasks.cancelTask(f.userId, task.id);
    const dirtyFilePath = "draft.txt";
    await writeFile(join(worktree.path, dirtyFilePath), dirtyFilePath);
    await f.page.goto(`${f.base}/tasks/${task.id}?company=${f.company.id}`);
    await f.page.getByRole("button", { name: "Task options" }).click();
    await f.page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
    const dialog = f.page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("heading", { name: "Discard 1 uncommitted change and archive?" }).waitFor();
    const fileList = dialog.getByLabel("Uncommitted files");
    await fileList.getByText(dirtyFilePath, { exact: true }).waitFor();
    expect(f.tasks.getTask(f.userId, task.id).archivedAt).toBeNull();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await readFile(join(worktree.path, dirtyFilePath), "utf8")).toBe(dirtyFilePath);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await readFile(join(worktree.path, dirtyFilePath), "utf8")).toBe(dirtyFilePath);
    await f.page.getByRole("button", { name: "Task options" }).click();
    await f.page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("button", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("heading", { name: "Discard 1 uncommitted change and archive?" }).waitFor();
    await dialog.getByRole("button", { name: "Discard changes and archive", exact: true }).click();
    await f.page.waitForURL(url => url.pathname === "/tasks");
    expect(f.tasks.getTask(f.userId, task.id).archivedAt).not.toBeNull();
    await expect(access(worktree.path)).rejects.toThrow();
    expect(await git(["rev-parse", worktree.branch])).toBe(startingSha);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
