import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { createGitCommandGuard, WorktreeManager } from "../src/worktrees.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-worktree-test-"));
  const repositoryPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "fixture"], repositoryPath);
  return { root, repositoryPath, worktreeRoot, baseSha: await git(["rev-parse", "HEAD"], repositoryPath) };
}

test("creates a deterministic exact-base worktree and guards prohibited Git/provider operations", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    const record = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_exact_base", targetBaseSha: value.baseSha });
    expect(record).toMatchObject({ branchName: "forge/issue/task_exact_base", targetBaseSha: value.baseSha });
    expect(await git(["rev-parse", "HEAD"], record.worktreePath)).toBe(value.baseSha);
    expect(await manager.inspectDelivery(record.worktreePath)).toMatchObject({ branchName: record.branchName, headSha: value.baseSha, dirtyState: "clean" });
    const guard = await createGitCommandGuard(join(value.root, "runtime"));
    try {
      await expect(execFileAsync("git", ["push"], { cwd: record.worktreePath, env: guard.env })).rejects.toThrow();
      await expect(execFileAsync("gh", ["pr", "create"], { cwd: record.worktreePath, env: guard.env })).rejects.toThrow();
    } finally { await guard.cleanup(); }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects dirty, reused, colliding, symlinked, and unsafe worktree coordinates", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    await writeFile(join(value.repositoryPath, "dirty.txt"), "dirty\n");
    await expect(manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_dirty", targetBaseSha: value.baseSha })).rejects.toMatchObject({ code: "repository-dirty" });
    await rm(join(value.repositoryPath, "dirty.txt"));
    const first = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_reused", targetBaseSha: value.baseSha });
    await expect(manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_reused", targetBaseSha: value.baseSha })).rejects.toMatchObject({ code: "worktree-exists" });
    await expect(manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_other", targetBaseSha: value.baseSha, branchName: first.branchName })).rejects.toMatchObject({ code: "branch-exists" });
    await symlink(value.worktreeRoot, join(value.root, "worktree-link"));
    await expect(manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: join(value.root, "worktree-link"), taskId: "task_link", targetBaseSha: value.baseSha })).rejects.toMatchObject({ code: "worktree-root-unavailable" });
    await expect(manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "../escape", targetBaseSha: value.baseSha })).rejects.toMatchObject({ code: "unsafe-task-id" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects an invalid target-base commit before creating a branch", async () => {
  const value = await fixture();
  try {
    await expect(new WorktreeManager().create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_invalid", targetBaseSha: "0".repeat(40) })).rejects.toMatchObject({ code: "base-commit-mismatch" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
