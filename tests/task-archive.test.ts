import { access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { prepareTaskWorktree } from "../src/task-worktree.js";
import { nativeApp } from "./helpers/native-app.js";

const git = async (cwd: string, args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", cwd, args })).stdout.trim();

async function fixture() {
  const value = await nativeApp();
  await git(value.project.repositoryPath, ["init", "-b", "main"]);
  await git(value.project.repositoryPath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "seed"]);
  const startingSha = await git(value.project.repositoryPath, ["rev-parse", "HEAD"]);
  const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Archive task", description: "Keep the branch", startImmediately: true, idempotencyKey: "archive-task" });
  const worktree = await prepareTaskWorktree({ taskId: task.id, ...task.configuration, startingSha });
  value.tasks.repository.controls.setWorktree(task.id, worktree);
  value.tasks.cancelTask(value.userId, task.id);
  return { ...value, task, worktree };
}

test("archive removes the worktree and registration but retains the branch and history", async () => {
  const f = await fixture();
  try {
    await git(f.worktree.path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "unpublished work"]);
    const head = await git(f.worktree.path, ["rev-parse", "HEAD"]);
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${f.task.id}/archive`, headers: f.headers, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    await expect(access(f.worktree.path)).rejects.toThrow();
    expect(await git(f.project.repositoryPath, ["worktree", "list", "--porcelain"])).not.toContain(f.worktree.path);
    expect(await git(f.project.repositoryPath, ["rev-parse", f.worktree.branch])).toBe(head);
    expect(f.tasks.getTask(f.userId, f.task.id).archivedAt).not.toBeNull();
    const repeated = await f.app.inject({ method: "POST", url: `/api/tasks/${f.task.id}/archive`, headers: f.headers, payload: {} });
    expect(repeated.statusCode, repeated.body).toBe(200);
    await f.app.inject({ method: "POST", url: `/api/tasks/${f.task.id}/unarchive`, headers: f.headers });
    expect(f.tasks.getTask(f.userId, f.task.id).archivedAt).toBeNull();
    await expect(access(f.worktree.path)).rejects.toThrow();
  } finally { await f.close(); }
});

test("failed Git cleanup leaves the task visible", async () => {
  const f = await fixture();
  try {
    await git(f.project.repositoryPath, ["worktree", "lock", f.worktree.path]);
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${f.task.id}/archive`, headers: f.headers, payload: { confirmDiscardDirty: true } });
    expect(response.statusCode).toBe(409);
    expect(f.tasks.getTask(f.userId, f.task.id).archivedAt).toBeNull();
    await expect(access(f.worktree.path)).resolves.toBeUndefined();
  } finally { await f.close(); }
});

test("archive requires confirmation for untracked changes before hiding the task", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktree.path, "draft.txt"), "unsaved draft");
    const request = { method: "POST" as const, url: `/api/tasks/${f.task.id}/archive`, headers: f.headers };
    const first = await f.app.inject({ ...request, payload: {} });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: "confirmation_required", dirtyFileCount: 1 });
    expect(f.tasks.getTask(f.userId, f.task.id).archivedAt).toBeNull();
    expect(await readFile(join(f.worktree.path, "draft.txt"), "utf8")).toBe("unsaved draft");
    const second = await f.app.inject({ ...request, payload: { confirmDiscardDirty: true } });
    expect(second.statusCode, second.body).toBe(200);
    await expect(access(f.worktree.path)).rejects.toThrow();
  } finally { await f.close(); }
});

test("archive refuses a worktree that is now on somebody else's branch", async () => {
  const f = await fixture();
  try {
    await git(f.worktree.path, ["switch", "-c", "other-work"]);
    const response = await f.app.inject({ method: "POST", url: `/api/tasks/${f.task.id}/archive`, headers: f.headers, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(f.tasks.getTask(f.userId, f.task.id).archivedAt).toBeNull();
    await expect(access(f.worktree.path)).resolves.toBeUndefined();
  } finally { await f.close(); }
});
