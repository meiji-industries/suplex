import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "./command-runner.js";
import type { WorktreeReference } from "./task-control.js";

export interface TaskWorktreeIntent {
  taskId: string;
  repositoryPath: string;
  worktreeRoot: string;
  branch: string;
  startingSha: string;
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function git(cwd: string, args: string[]) {
  return runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
}

async function registeredWorktrees(repository: string): Promise<Array<{ path: string; branch: string | null }>> {
  const output = (await git(repository, ["worktree", "list", "--porcelain", "-z"])).stdout;
  return output.split("\0\0").filter(Boolean).map(record => {
    const fields = record.split("\0");
    const path = fields.find(field => field.startsWith("worktree "))?.slice(9);
    if (!path) throw new Error("Git returned an invalid worktree registry");
    const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18) ?? null;
    return { path: resolve(path), branch };
  });
}

async function observe(path: string, repository: string, intent: TaskWorktreeIntent): Promise<WorktreeReference> {
  const [actualRoot, common, expectedCommon, head, branch, dirty] = await Promise.all([
    git(path, ["rev-parse", "--show-toplevel"]),
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(path, ["rev-parse", "HEAD"]),
    git(path, ["symbolic-ref", "--short", "HEAD"]),
    git(path, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (await realpath(actualRoot.stdout.trim()) !== path || await realpath(common.stdout.trim()) !== await realpath(expectedCommon.stdout.trim()) || branch.stdout.trim() !== intent.branch) {
    throw new Error("Task worktree does not match its repository and branch");
  }
  return { path, branch: intent.branch, baseSha: intent.startingSha, headSha: head.stdout.trim(), dirty: dirty.stdout.length > 0 };
}

export async function prepareTaskWorktree(intent: TaskWorktreeIntent): Promise<WorktreeReference> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(intent.taskId) || !/^[a-f0-9]{40,64}$/i.test(intent.startingSha)) throw new Error("Invalid task worktree identity");
  if (!isAbsolute(intent.repositoryPath) || !isAbsolute(intent.worktreeRoot)) throw new Error("Task worktree roots must be absolute");
  const repository = await realpath(intent.repositoryPath);
  const root = resolve(intent.worktreeRoot);
  if (contains(repository, root) || contains(root, repository)) throw new Error("Task worktree roots overlap");
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  if (contains(repository, canonicalRoot) || contains(canonicalRoot, repository)) throw new Error("Task worktree roots overlap");
  const path = join(canonicalRoot, intent.taskId);
  await git(repository, ["check-ref-format", `refs/heads/${intent.branch}`]);
  const registry = await registeredWorktrees(repository);
  if (registry.some(entry => entry.branch === intent.branch && entry.path !== path)) throw new Error("Task branch is checked out in another worktree");
  const existing = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory() || !registry.some(entry => entry.path === path && entry.branch === intent.branch)) throw new Error("Task worktree path has a conflicting owner");
    return observe(path, repository, intent);
  }
  const branch = await runCommand({ taskId: null, stepId: null, command: "git", cwd: repository, args: ["show-ref", "--verify", "--quiet", `refs/heads/${intent.branch}`], expectNonZero: true });
  if (branch.exitCode !== 0 && branch.exitCode !== 1) throw new Error("Git could not inspect the task branch");
  if (branch.exitCode === 1) await git(repository, ["cat-file", "-e", `${intent.startingSha}^{commit}`]);
  const staleRegistration = registry.find(entry => entry.path === path);
  if (staleRegistration && staleRegistration.branch !== intent.branch) throw new Error("Task worktree registry has a conflicting owner");
  const args = ["worktree", "add", ...(staleRegistration ? ["--force"] : []), ...(branch.exitCode === 1 ? ["-b", intent.branch] : []), path, branch.exitCode === 1 ? intent.startingSha : intent.branch];
  try { await git(repository, args); }
  catch (error) {
    const after = await registeredWorktrees(repository);
    if (!after.some(entry => entry.path === path && entry.branch === intent.branch)) throw error;
  }
  return observe(path, repository, intent);
}

export type WorktreeCleanup = { status: "cleaned" | "already_absent" } | { status: "confirmation_required"; dirtyFileCount: number; dirtyFilePaths: string[] };

export async function removeTaskWorktree(intent: TaskWorktreeIntent, reference: WorktreeReference | null, confirmDiscardDirty: boolean, authorize: () => void): Promise<WorktreeCleanup> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(intent.taskId) || !isAbsolute(intent.repositoryPath) || !isAbsolute(intent.worktreeRoot)) throw new Error("Invalid task worktree identity");
  const missing = (error: unknown): null => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; };
  const root = await realpath(intent.worktreeRoot).catch(missing) ?? resolve(intent.worktreeRoot);
  const repository = await realpath(intent.repositoryPath).catch(missing) ?? resolve(intent.repositoryPath);
  if (contains(repository, root) || contains(root, repository)) throw new Error("Task worktree roots overlap");
  const path = join(root, intent.taskId);
  if (reference && (resolve(reference.path) !== path || reference.branch !== intent.branch)) throw new Error("Recorded worktree does not match the task path and branch");
  const existing = await lstat(path).catch(missing);
  if (!existing && !await lstat(repository).catch(missing)) return { status: "already_absent" };
  const registry = await registeredWorktrees(repository);
  const registered = registry.find(entry => entry.path === path);
  if (!existing && !registered) return { status: "already_absent" };
  if (!registered || registered.branch !== intent.branch || existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error("Task worktree path has a conflicting owner");
  if (existing) {
    await observe(path, repository, intent);
    const changes = (await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).stdout.split("\0").filter(Boolean);
    if (changes.length && !confirmDiscardDirty) return {
      status: "confirmation_required",
      dirtyFileCount: changes.length,
      dirtyFilePaths: changes.map(change => change.slice(3)),
    };
  }
  authorize();
  await git(repository, ["worktree", "remove", ...(confirmDiscardDirty ? ["--force"] : []), path]);
  if (await lstat(path).catch(missing) || (await registeredWorktrees(repository)).some(entry => entry.path === path)) throw new Error("Git did not remove the task worktree");
  return { status: existing ? "cleaned" : "already_absent" };
}
