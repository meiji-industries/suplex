import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { ForgeDatabase } from "./database.js";

const execFileAsync = promisify(execFile);

export interface ForwardMergeResult {
  status: "no_drift" | "merged" | "conflict";
  priorHead: string;
  targetBaseSha: string;
  mergeCommit: string | null;
  tree: string | null;
  conflictFiles: string[];
  conflictDiff?: string;
  forwardMergeId?: string;
}

export class ForwardMergeFailure extends Error {
  constructor(readonly code: "unsafe-command" | "not-ancestor" | "conflict" | "git") {
    super(`Forward merge ${code}`);
    this.name = "ForwardMergeFailure";
  }
}

export class ForwardMergeService {
  constructor(private readonly database?: ForgeDatabase) {}

  async reconcile(input: { worktreePath: string; expectedBaseSha: string; currentBaseSha: string; branchName: string; repositoryPath: string; taskId?: string; companyId?: string }): Promise<ForwardMergeResult> {
    if (input.expectedBaseSha.toLowerCase() === input.currentBaseSha.toLowerCase()) {
      const head = await this.git(["rev-parse", "HEAD"], input.worktreePath);
      const result: ForwardMergeResult = { status: "no_drift", priorHead: head, targetBaseSha: input.currentBaseSha, mergeCommit: null, tree: null, conflictFiles: [] };
      const forwardMergeId = this.record(input, result);
      if (forwardMergeId) result.forwardMergeId = forwardMergeId;
      return result;
    }
    const priorHead = await this.git(["rev-parse", "HEAD"], input.worktreePath);
    const branch = await this.git(["branch", "--show-current"], input.worktreePath);
    if (branch !== input.branchName) throw new ForwardMergeFailure("git");
    const ancestry = await this.gitOptional(["merge-base", "--is-ancestor", input.expectedBaseSha, input.currentBaseSha], input.worktreePath);
    if (ancestry === undefined) throw new ForwardMergeFailure("not-ancestor");
    const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], input.worktreePath);
    if (status) throw new ForwardMergeFailure("git");
    try {
      await this.git(["merge", "--no-ff", "--no-edit", input.currentBaseSha], input.worktreePath);
    } catch {
      const conflicts = (await this.gitOptional(["diff", "--name-only", "--diff-filter=U"], input.worktreePath))?.split(/\r?\n/).filter(Boolean) ?? [];
      if (!conflicts.length) throw new ForwardMergeFailure("git");
      const conflictDiff = (await this.gitOptional(["diff", "--cc", "--no-ext-diff"], input.worktreePath) ?? "").slice(0, 80_000);
      const result: ForwardMergeResult = { status: "conflict", priorHead, targetBaseSha: input.currentBaseSha, mergeCommit: null, tree: null, conflictFiles: conflicts, conflictDiff };
      const forwardMergeId = this.record(input, result);
      if (forwardMergeId) result.forwardMergeId = forwardMergeId;
      return result;
    }
    const mergeCommit = await this.git(["rev-parse", "HEAD"], input.worktreePath);
    const tree = await this.git(["rev-parse", "HEAD^{tree}"], input.worktreePath);
    const result: ForwardMergeResult = { status: "merged", priorHead, targetBaseSha: input.currentBaseSha, mergeCommit, tree, conflictFiles: [] };
    const forwardMergeId = this.record(input, result);
    if (forwardMergeId) result.forwardMergeId = forwardMergeId;
    return result;
  }

  private async git(args: string[], cwd: string): Promise<string> {
    if (args.some((arg) => ["rebase", "reset", "clean", "push", "update-ref"].includes(arg) || arg.includes("--force"))) throw new ForwardMergeFailure("unsafe-command");
    try { return (await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 128 * 1024 })).stdout.trim(); } catch { throw new ForwardMergeFailure("git"); }
  }

  private async gitOptional(args: string[], cwd: string): Promise<string | undefined> {
    try { return await this.git(args, cwd); } catch { return undefined; }
  }

  private record(input: { worktreePath: string; expectedBaseSha: string; currentBaseSha: string; branchName: string; repositoryPath: string; taskId?: string; companyId?: string }, result: ForwardMergeResult): string | undefined {
    if (!this.database || !input.taskId || !input.companyId) return undefined;
    const id = `merge_${createHash("sha256").update(`${input.companyId}:${input.taskId}:${result.status}:${input.expectedBaseSha}:${input.currentBaseSha}:${result.priorHead}:${result.mergeCommit ?? ""}:${result.tree ?? ""}:${JSON.stringify(result.conflictFiles)}`).digest("hex").slice(0, 32)}`;
    const now = new Date().toISOString();
    this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.taskId, input.companyId, input.expectedBaseSha, input.currentBaseSha, result.priorHead, result.mergeCommit, result.tree, result.status, JSON.stringify(result.conflictFiles), now));
    return id;
  }
}
