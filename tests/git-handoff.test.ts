import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { runCommand } from "../src/command-runner.js";
import { detectGitHandoff } from "../src/git-handoff.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repository(): Promise<{ root: string; first: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-git-handoff-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "file.txt"), "first\n");
  await git(root, "add", "file.txt"); await git(root, "commit", "-m", "first");
  return { root, first: await git(root, "rev-parse", "HEAD") };
}

test("detects a clean Developer commit and its tree", async () => {
  const { root, first } = await repository();
  await writeFile(join(root, "file.txt"), "second\n"); await git(root, "commit", "-am", "second");
  const headSha = await git(root, "rev-parse", "HEAD");
  await expect(detectGitHandoff({ worktreePath: root, branchName: "main", previousCommit: first, taskId: "task" })).resolves.toEqual({ kind: "clean_commit", headSha, treeSha: await git(root, "rev-parse", "HEAD^{tree}") });
});

test("classifies dirty, unchanged, wrong-branch, and missing worktrees", async () => {
  const { root, first } = await repository();
  await expect(detectGitHandoff({ worktreePath: root, branchName: "main", previousCommit: first, taskId: "task" })).resolves.toEqual({ kind: "no_new_commit", headSha: first });
  await writeFile(join(root, "dirty.txt"), "dirty\n");
  await expect(detectGitHandoff({ worktreePath: root, branchName: "main", previousCommit: first, taskId: "task" })).resolves.toMatchObject({ kind: "dirty", headSha: first, dirtyFileCount: 1 });
  await git(root, "clean", "-fd"); await git(root, "checkout", "-b", "other");
  await expect(detectGitHandoff({ worktreePath: root, branchName: "main", previousCommit: first, taskId: "task" })).resolves.toEqual({ kind: "wrong_branch", currentBranch: "other" });
  await expect(detectGitHandoff({ worktreePath: join(root, "gone"), branchName: "main", previousCommit: first, taskId: "task" })).resolves.toEqual({ kind: "missing_worktree" });
});
