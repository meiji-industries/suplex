import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const run = promisify(execFile);

test("archive confirms dirty cleanup and returns to tasks", { timeout: 45_000 }, async () => {
  const f = await nativeBrowser();
  const git = async (...args: string[]) => (await run("git", ["-C", f.project.repositoryPath, ...args])).stdout.trim();
  try {
    const startingSha = await git("rev-parse", "HEAD");
    const task = await f.createTask({ title: "Archive example", description: "Keep the commits", startImmediately: false, idempotencyKey: "archive-ui" });
    const branch = task.configuration.branch;
    const worktree = join(f.project.worktreeRoot, task.id);
    await mkdir(f.project.worktreeRoot, { recursive: true });
    await git("worktree", "add", "--quiet", "-b", branch, worktree, startingSha);
    f.database.prepare("UPDATE suplex_task_controls SET status = 'active', worktree_json = ? WHERE task_id = ?")
      .run(JSON.stringify({ path: worktree, branch, baseSha: startingSha, headSha: startingSha, dirty: false }), task.id);
    expect((await f.api("POST", `/api/tasks/${task.id}/cancel`)).status).toBe(200);
    const dirtyFilePath = "draft.txt";
    await writeFile(join(worktree, dirtyFilePath), dirtyFilePath);
    await f.page.goto(`${f.base}/tasks/${task.id}?company=${f.company.id}`);
    await f.page.getByRole("button", { name: "Task options" }).click();
    await f.page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
    const dialog = f.page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("heading", { name: "Discard 1 uncommitted change and archive?" }).waitFor();
    await dialog.getByLabel("Uncommitted files").getByText(dirtyFilePath, { exact: true }).waitFor();
    expect((await f.api("GET", `/api/tasks/${task.id}`)).body).toMatchObject({ archivedAt: null });
    await expect(access(worktree)).resolves.toBeUndefined();
    expect(await readFile(join(worktree, dirtyFilePath), "utf8")).toBe(dirtyFilePath);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await readFile(join(worktree, dirtyFilePath), "utf8")).toBe(dirtyFilePath);
    await f.page.getByRole("button", { name: "Task options" }).click();
    await f.page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("button", { name: "Archive task", exact: true }).click();
    await dialog.getByRole("heading", { name: "Discard 1 uncommitted change and archive?" }).waitFor();
    await dialog.getByRole("button", { name: "Discard changes and archive", exact: true }).click();
    await f.page.waitForURL(url => url.pathname === "/tasks");
    expect((await f.api("GET", `/api/tasks/${task.id}`)).body).not.toMatchObject({ archivedAt: null });
    await expect(access(worktree)).rejects.toThrow();
    expect(await git("rev-parse", branch)).toBe(startingSha);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
