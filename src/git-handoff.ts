import { access } from "node:fs/promises";

import { runCommand } from "./command-runner.js";
import type { ForgeDatabase } from "./database.js";

export type GitHandoff =
  | { kind: "clean_commit"; headSha: string; treeSha: string }
  | { kind: "no_new_commit"; headSha: string | null }
  | { kind: "dirty"; headSha: string | null; dirtyFileCount: number }
  | { kind: "wrong_branch"; currentBranch: string | null }
  | { kind: "missing_worktree" };

async function git(worktreePath: string, args: string[]): Promise<string | null> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd: worktreePath, timeout: 8_000 });
  return result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : null;
}

export async function detectGitHandoff(input: { worktreePath: string; branchName: string; previousCommit: string | null; taskId: string; database?: ForgeDatabase }): Promise<GitHandoff> {
  try { await access(input.worktreePath); } catch { return { kind: "missing_worktree" }; }
  const currentBranch = await git(input.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch !== input.branchName) return { kind: "wrong_branch", currentBranch };
  const headSha = await git(input.worktreePath, ["rev-parse", "HEAD"]);
  if (!headSha) return { kind: "missing_worktree" };
  const porcelain = await git(input.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (porcelain === null) return { kind: "missing_worktree" };
  if (porcelain) return { kind: "dirty", headSha, dirtyFileCount: porcelain.split(/\r?\n/).filter(Boolean).length };
  let previousCommit = input.previousCommit;
  if (!previousCommit && input.database) {
    previousCommit = (input.database.authQuery((db) => db.prepare("SELECT target_base_sha FROM forge_developer_executions WHERE task_id = ? AND worktree_path = ? ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.worktreePath)) as { target_base_sha: string } | undefined)?.target_base_sha ?? null;
  }
  if (previousCommit && headSha.toLowerCase() === previousCommit.toLowerCase()) return { kind: "no_new_commit", headSha };
  const treeSha = await git(input.worktreePath, ["rev-parse", "HEAD^{tree}"]);
  return treeSha ? { kind: "clean_commit", headSha, treeSha } : { kind: "missing_worktree" };
}
