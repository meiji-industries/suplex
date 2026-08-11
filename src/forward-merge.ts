import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
      const result = { status: "no_drift" as const, priorHead: head, targetBaseSha: input.currentBaseSha, mergeCommit: null, tree: null, conflictFiles: [] };
      this.record(input, result);
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
      this.record(input, { status: "conflict", priorHead, targetBaseSha: input.currentBaseSha, mergeCommit: null, tree: null, conflictFiles: conflicts });
      throw new ForwardMergeFailure(conflicts.length ? "conflict" : "git");
    }
    const mergeCommit = await this.git(["rev-parse", "HEAD"], input.worktreePath);
    const tree = await this.git(["rev-parse", "HEAD^{tree}"], input.worktreePath);
    const result = { status: "merged" as const, priorHead, targetBaseSha: input.currentBaseSha, mergeCommit, tree, conflictFiles: [] };
    this.record(input, result);
    return result;
  }

  private async git(args: string[], cwd: string): Promise<string> {
    if (args.some((arg) => ["rebase", "reset", "clean", "push", "update-ref"].includes(arg) || arg.includes("--force"))) throw new ForwardMergeFailure("unsafe-command");
    try { return (await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 128 * 1024 })).stdout.trim(); } catch { throw new ForwardMergeFailure("git"); }
  }

  private async gitOptional(args: string[], cwd: string): Promise<string | undefined> {
    try { return await this.git(args, cwd); } catch { return undefined; }
  }

  private record(input: { worktreePath: string; expectedBaseSha: string; currentBaseSha: string; branchName: string; repositoryPath: string; taskId?: string; companyId?: string }, result: ForwardMergeResult): void {
    if (!this.database || !input.taskId || !input.companyId) return;
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`merge_${randomBytes(12).toString("hex")}`, input.taskId, input.companyId, input.expectedBaseSha, input.currentBaseSha, result.priorHead, result.mergeCommit, result.tree, result.status, JSON.stringify(result.conflictFiles), new Date().toISOString()));
  }
}
