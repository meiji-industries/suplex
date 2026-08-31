import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import type { GithubReleasePort } from "./github-release.js";
import { redact } from "./logging.js";
import { z } from "zod";
import { jsonRequired } from "./task-utils.js";

const execFileAsync = promisify(execFile);
const shaPattern = /^[a-f0-9]{40,64}$/i;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;

export const ForwardMergeConflictArtifactSchema = z.object({
  version: z.literal(1),
  checkpoint: z.enum(["pre_release", "pre_final_review", "pre_acceptance", "ci_update_from_base"]),
  expectedBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  observedBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  priorHead: z.string().regex(/^[a-f0-9]{40,64}$/i),
  priorTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  conflictFiles: z.array(z.string().min(1)).min(1),
  combinedDiff: z.string().max(240_000),
  priorCommitSummary: z.string(),
  baseCommitSummary: z.string(),
  commandEvidence: z.object({ command: z.literal("git diff --cc --no-ext-diff"), complete: z.literal(true) }).strict(),
}).strict();
export type ForwardMergeConflictArtifact = z.infer<typeof ForwardMergeConflictArtifactSchema>;

export interface ForwardMergeResult {
  status: "no_drift" | "merged" | "conflict";
  priorHead: string;
  priorTree: string;
  targetBaseSha: string;
  mergeCommit: string | null;
  tree: string | null;
  conflictFiles: string[];
  conflictDiff?: string;
  conflictArtifact?: Pick<StoredArtifact, "id" | "sha256" | "kind">;
  conflictEvidenceTooLarge?: boolean;
  forwardMergeId?: string;
}

export class ForwardMergeFailure extends Error {
  constructor(readonly code: "unsafe-command" | "not-ancestor" | "conflict" | "git" | "provider-unavailable" | "authentication-required" | "remote-identity-mismatch" | "base-advanced-again" | "worktree-ownership-mismatch" | "merge-state-ownership-mismatch") {
    super(`Forward merge ${code}`);
    this.name = "ForwardMergeFailure";
  }
}

type ForwardMergeProvider = Pick<GithubReleasePort, "getBranchHead" | "getRemoteRepository">;

interface ForwardMergeInput {
  worktreePath: string;
  repositoryPath: string;
  branchName: string;
  expectedBaseSha: string;
  expectedHeadSha?: string;
  expectedHeadTree?: string;
  currentBaseSha?: string;
  repository?: string;
  baseBranch?: string;
  taskId?: string;
  companyId?: string;
  workflowId?: string;
  projectRevisionId?: string;
  checkpoint?: string;
  developerExecutionId?: string;
  releaseId?: string;
  deliveryReviewId?: string;
  ciRunId?: string;
  finalReviewId?: string;
  acceptanceId?: string;
}

export class ForwardMergeService {
  constructor(private readonly database?: ForgeDatabase, private readonly provider?: ForwardMergeProvider, private readonly artifacts?: ArtifactStore) {}

  async reconcile(input: ForwardMergeInput): Promise<ForwardMergeResult> {
    this.validateInput(input);
    const observedBaseSha = input.currentBaseSha ?? await this.observeBase(input);
    if (input.baseBranch) {
      try {
        await this.git(["fetch", "--no-tags", "origin", `refs/heads/${input.baseBranch}`], input.worktreePath);
        await this.git(["cat-file", "-e", `${observedBaseSha}^{commit}`], input.worktreePath);
      } catch {
        throw new ForwardMergeFailure("git");
      }
    }
    if (!input.currentBaseSha) {
      const secondObservation = await this.observeBase(input);
      if (secondObservation.toLowerCase() !== observedBaseSha.toLowerCase()) throw new ForwardMergeFailure("base-advanced-again");
    }
    const stored = this.lookupStoredOperation(input, observedBaseSha);
    if (stored) {
      if (stored.status === "no_drift") {
        const ownership = await this.inspectOwnership(input);
        if (ownership.headSha.toLowerCase() === stored.priorHead.toLowerCase() && ownership.treeSha.toLowerCase() === stored.priorTree?.toLowerCase() && !await this.isAncestor(observedBaseSha, ownership.headSha, input.worktreePath)) {
          this.database!.authTransaction((db) => db.prepare("DELETE FROM forge_forward_merges WHERE id = ? AND task_id = ? AND company_id = ?").run(stored.id, input.taskId, input.companyId));
        } else {
          return this.revalidateStoredOperation(input, stored, observedBaseSha);
        }
      } else {
        return this.revalidateStoredOperation(input, stored, observedBaseSha);
      }
    }
    const ownership = await this.inspectOwnership(input);
    if (await this.isAncestor(observedBaseSha, ownership.headSha, input.worktreePath)) {
      const result: ForwardMergeResult = { status: "no_drift", priorHead: ownership.headSha, priorTree: ownership.treeSha, targetBaseSha: observedBaseSha, mergeCommit: null, tree: null, conflictFiles: [] };
      const forwardMergeId = this.record(input, result, ownership.treeSha);
      if (forwardMergeId) result.forwardMergeId = forwardMergeId;
      return result;
    }

    const ancestry = await this.gitOptional(["merge-base", "--is-ancestor", input.expectedBaseSha, observedBaseSha], input.worktreePath);
    if (ancestry === undefined) throw new ForwardMergeFailure("not-ancestor");
    try {
      await this.git(["merge", "--no-ff", "--no-edit", observedBaseSha], input.worktreePath);
    } catch {
      const conflicts = (await this.gitOptional(["diff", "--name-only", "--diff-filter=U", "-z"], input.worktreePath) ?? "").split("\0").filter(Boolean);
      if (!conflicts.length) throw new ForwardMergeFailure("git");
      if (conflicts.some((file) => !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\u0000-\u001f\u007f]).{1,1000}$/.test(file)) || conflicts.length > 128) throw new ForwardMergeFailure("git");
      const mergeHead = await this.gitOptional(["rev-parse", "MERGE_HEAD"], input.worktreePath);
      const currentHead = await this.gitOptional(["rev-parse", "HEAD"], input.worktreePath);
      if (mergeHead?.toLowerCase() !== observedBaseSha.toLowerCase() || currentHead?.toLowerCase() !== ownership.headSha.toLowerCase()) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
      const conflictDiff = await this.gitOptional(["diff", "--cc", "--no-ext-diff"], input.worktreePath) ?? "";
      const result: ForwardMergeResult = { status: "conflict", priorHead: ownership.headSha, priorTree: ownership.treeSha, targetBaseSha: observedBaseSha, mergeCommit: null, tree: null, conflictFiles: conflicts, ...(this.artifacts ? {} : { conflictDiff: conflictDiff.slice(0, 80_000) }) };
      if (this.artifacts && input.companyId) {
        const artifact = await this.persistConflictArtifact(input, result, conflictDiff);
        if (artifact) result.conflictArtifact = artifact;
        else result.conflictEvidenceTooLarge = true;
      }
      const forwardMergeId = this.record(input, result, ownership.treeSha);
      if (forwardMergeId) result.forwardMergeId = forwardMergeId;
      return result;
    }
    const branch = await this.git(["branch", "--show-current"], input.worktreePath);
    const mergeCommit = await this.git(["rev-parse", "HEAD"], input.worktreePath);
    const tree = await this.git(["rev-parse", "HEAD^{tree}"], input.worktreePath);
    if (branch !== input.branchName) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
    await this.assertMergedOwnership({ worktreePath: input.worktreePath, branchName: input.branchName, priorHead: ownership.headSha, targetBaseSha: observedBaseSha, mergeCommit, tree });
    const result: ForwardMergeResult = { status: "merged", priorHead: ownership.headSha, priorTree: ownership.treeSha, targetBaseSha: observedBaseSha, mergeCommit, tree, conflictFiles: [] };
    const forwardMergeId = this.record(input, result, ownership.treeSha);
    if (forwardMergeId) result.forwardMergeId = forwardMergeId;
    return result;
  }

  async assertMergedOwnership(input: { worktreePath: string; branchName: string; priorHead: string; targetBaseSha: string; mergeCommit: string; tree: string }): Promise<void> {
    const branch = await this.git(["branch", "--show-current"], input.worktreePath);
    const currentHead = await this.git(["rev-parse", "HEAD"], input.worktreePath);
    const tree = await this.git(["rev-parse", "HEAD^{tree}"], input.worktreePath);
    const parents = (await this.git(["rev-list", "--parents", "-n", "1", "HEAD"], input.worktreePath)).split(/\s+/).filter(Boolean);
    const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], input.worktreePath);
    const mergeHead = await this.gitOptional(["rev-parse", "MERGE_HEAD"], input.worktreePath);
    if (branch !== input.branchName || currentHead.toLowerCase() !== input.mergeCommit.toLowerCase() || tree.toLowerCase() !== input.tree.toLowerCase() || parents.length !== 3 || parents[1]!.toLowerCase() !== input.priorHead.toLowerCase() || parents[2]!.toLowerCase() !== input.targetBaseSha.toLowerCase() || status || mergeHead !== undefined) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
  }

  async revalidateMergedOperation(input: { forwardMergeId: string; worktreePath: string; repositoryPath: string; branchName: string; expectedBaseSha: string; expectedHeadSha: string; expectedHeadTree: string; taskId: string; companyId: string; workflowId: string; projectRevisionId: string; checkpoint: string; developerExecutionId: string }): Promise<ForwardMergeResult> {
    if (!this.database) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
    const stored = this.database.authQuery((db) => db.prepare(`SELECT id, status, expected_base_sha AS expectedBaseSha, current_base_sha AS targetBaseSha,
        prior_head AS priorHead, prior_tree AS priorTree, merge_commit AS mergeCommit, tree, result_head AS resultHead, result_tree AS resultTree, developer_execution_id AS developerExecutionId
      FROM forge_forward_merges
      WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND project_revision_id = ? AND checkpoint = ?`).get(input.forwardMergeId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId, input.checkpoint) as { id: string; status: string; expectedBaseSha: string; targetBaseSha: string; priorHead: string; priorTree: string | null; mergeCommit: string | null; tree: string | null; resultHead: string | null; resultTree: string | null; developerExecutionId: string | null } | undefined);
    if (!stored || stored.status !== "merged" || !stored.priorTree || !stored.mergeCommit || !stored.tree || !stored.resultHead || !stored.resultTree) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
    await this.inspectOwnership({ worktreePath: input.worktreePath, repositoryPath: input.repositoryPath, branchName: input.branchName, expectedBaseSha: input.expectedBaseSha, expectedHeadSha: input.expectedHeadSha, expectedHeadTree: input.expectedHeadTree });
    await this.assertMergedOwnership({ worktreePath: input.worktreePath, branchName: input.branchName, priorHead: stored.priorHead, targetBaseSha: stored.targetBaseSha, mergeCommit: stored.mergeCommit, tree: stored.tree });
    return { status: "merged", priorHead: stored.priorHead, priorTree: stored.priorTree, targetBaseSha: stored.targetBaseSha, mergeCommit: stored.mergeCommit, tree: stored.tree, conflictFiles: [], forwardMergeId: stored.id };
  }

  private validateInput(input: ForwardMergeInput): void {
    if (![input.expectedBaseSha, input.expectedHeadSha, input.expectedHeadTree].filter(Boolean).every((value) => shaPattern.test(value!))) throw new ForwardMergeFailure("git");
    if (!branchPattern.test(input.branchName) || (input.baseBranch !== undefined && !branchPattern.test(input.baseBranch))) throw new ForwardMergeFailure("unsafe-command");
    if (input.repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw new ForwardMergeFailure("remote-identity-mismatch");
  }

  private async inspectOwnership(input: ForwardMergeInput): Promise<{ headSha: string; treeSha: string }> {
    try {
      const worktree = await realpath(input.worktreePath);
      const repository = await realpath(input.repositoryPath);
      const [actualRoot, commonDirRaw, repositoryCommonDirRaw, branchName, headSha, treeSha] = await Promise.all([
        this.git(["rev-parse", "--show-toplevel"], worktree),
        this.git(["rev-parse", "--git-common-dir"], worktree),
        this.git(["rev-parse", "--git-common-dir"], repository),
        this.git(["branch", "--show-current"], worktree),
        this.git(["rev-parse", "HEAD"], worktree),
        this.git(["rev-parse", "HEAD^{tree}"], worktree),
      ]);
      const [commonDir, repositoryCommonDir] = await Promise.all([
        realpath(resolve(worktree, commonDirRaw)).catch(() => commonDirRaw),
        realpath(resolve(repository, repositoryCommonDirRaw)).catch(() => repositoryCommonDirRaw),
      ]);
      if (actualRoot !== worktree || commonDir !== repositoryCommonDir || branchName !== input.branchName) throw new ForwardMergeFailure("worktree-ownership-mismatch");
      return { headSha, treeSha };
    } catch (error) {
      if (error instanceof ForwardMergeFailure) throw error;
      throw new ForwardMergeFailure("worktree-ownership-mismatch");
    }
  }

  private async observeBase(input: ForwardMergeInput): Promise<string> {
    if (!this.provider?.getBranchHead || !input.repository || !input.baseBranch) throw new ForwardMergeFailure("provider-unavailable");
    try {
      if (this.provider.getRemoteRepository) {
        const remote = await this.provider.getRemoteRepository({ cwd: input.repositoryPath });
        if (remote.toLowerCase() !== input.repository.toLowerCase()) throw new ForwardMergeFailure("remote-identity-mismatch");
      }
      const sha = await this.provider.getBranchHead({ repository: input.repository, branch: input.baseBranch });
      if (!sha || !shaPattern.test(sha)) throw new ForwardMergeFailure("provider-unavailable");
      return sha;
    } catch (error) {
      if (error instanceof ForwardMergeFailure) throw error;
      const message = error instanceof Error ? error.message : "";
      throw new ForwardMergeFailure(/auth|login|token/i.test(message) ? "authentication-required" : "provider-unavailable");
    }
  }

  private async git(args: string[], cwd: string): Promise<string> {
    if (args.some((arg) => ["rebase", "reset", "clean", "push", "update-ref", "filter-repo", "gc", "prune"].includes(arg) || arg.includes("--force") || arg === "--amend")) throw new ForwardMergeFailure("unsafe-command");
    try { return (await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 128 * 1024 })).stdout.trim(); } catch { throw new ForwardMergeFailure("git"); }
  }

  private async gitOptional(args: string[], cwd: string): Promise<string | undefined> {
    try { return await this.git(args, cwd); } catch { return undefined; }
  }

  private async isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, timeout: 30_000, maxBuffer: 128 * 1024 });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
      throw new ForwardMergeFailure("git");
    }
  }

  private async persistConflictArtifact(input: ForwardMergeInput, result: ForwardMergeResult, conflictDiff: string): Promise<Pick<StoredArtifact, "id" | "sha256" | "kind"> | undefined> {
    const [priorCommitSummary, baseCommitSummary] = await Promise.all([
      this.git(["show", "-s", "--format=%H%n%s", result.priorHead], input.worktreePath),
      this.git(["show", "-s", "--format=%H%n%s", result.targetBaseSha], input.worktreePath),
    ]);
    const payload = JSON.stringify({
      version: 1,
      checkpoint: input.checkpoint ?? "pre_release",
      expectedBaseSha: input.expectedBaseSha,
      observedBaseSha: result.targetBaseSha,
      priorHead: result.priorHead,
      priorTree: result.priorTree,
      conflictFiles: result.conflictFiles,
      combinedDiff: redact(conflictDiff),
      priorCommitSummary: redact(priorCommitSummary),
      baseCommitSummary: redact(baseCommitSummary),
      commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true },
    }, null, 2);
    if (Buffer.byteLength(payload, "utf8") > 256 * 1024) return undefined;
    const artifact = await this.artifacts!.putArtifact(input.companyId!, "forward-merge-conflict", { filename: `${input.taskId ?? "forward-merge"}.json`, mimeType: "application/json", bytes: Buffer.from(payload, "utf8") });
    if (this.database) this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
    return { id: artifact.id, sha256: artifact.sha256, kind: artifact.kind };
  }

  private record(input: ForwardMergeInput, result: ForwardMergeResult, priorTree: string): string | undefined {
    if (!this.database || !input.taskId || !input.companyId) return undefined;
    const operationKey = this.operationKey(input, result.targetBaseSha);
    const id = `merge_${createHash("sha256").update(operationKey ?? `${input.companyId}:${input.taskId}:${result.status}:${input.expectedBaseSha}:${result.targetBaseSha}:${result.priorHead}:${result.mergeCommit ?? ""}:${result.tree ?? ""}:${JSON.stringify(result.conflictFiles)}`).digest("hex").slice(0, 32)}`;
    const now = new Date().toISOString();
    this.database.authTransaction((db) => db.prepare(`INSERT OR IGNORE INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, operation_key, prior_tree, result_head, result_tree, developer_execution_id, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, release_id, invalidated_delivery_review_id, invalidated_ci_run_id, invalidated_final_review_id, invalidated_acceptance_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.taskId, input.companyId, input.expectedBaseSha, result.targetBaseSha, result.priorHead, result.mergeCommit, result.tree, result.status, JSON.stringify(result.conflictFiles), now, input.workflowId ?? null, input.projectRevisionId ?? null, input.checkpoint ?? null, operationKey ?? null, priorTree, result.mergeCommit, result.tree, input.developerExecutionId ?? null, result.conflictArtifact?.id ?? null, result.conflictArtifact?.sha256 ?? null, result.conflictFiles.length || null, input.releaseId ?? null, input.deliveryReviewId ?? null, input.ciRunId ?? null, input.finalReviewId ?? null, input.acceptanceId ?? null, now));
    return id;
  }

  private operationKey(input: ForwardMergeInput, observedBaseSha: string): string | undefined {
    if (!input.workflowId || !input.checkpoint || !input.projectRevisionId) return undefined;
    return `${input.workflowId}:${input.checkpoint}:${input.projectRevisionId}:${input.expectedBaseSha}:${observedBaseSha}:${input.expectedHeadSha ?? ""}`;
  }

  private lookupStoredOperation(input: ForwardMergeInput, observedBaseSha: string): { id: string; status: "no_drift" | "merged" | "conflict"; priorHead: string; priorTree: string | null; mergeCommit: string | null; tree: string | null; conflictFilesJson: string; conflictArtifactId: string | null; conflictArtifactSha256: string | null } | undefined {
    const operationKey = this.operationKey(input, observedBaseSha);
    if (!this.database || !operationKey || !input.taskId || !input.companyId) return undefined;
    return this.database.authQuery((db) => db.prepare("SELECT id, status, prior_head AS priorHead, prior_tree AS priorTree, merge_commit AS mergeCommit, tree, conflict_files_json AS conflictFilesJson, conflict_artifact_id AS conflictArtifactId, conflict_artifact_sha256 AS conflictArtifactSha256 FROM forge_forward_merges WHERE operation_key = ? AND task_id = ? AND company_id = ?").get(operationKey, input.taskId, input.companyId) as { id: string; status: "no_drift" | "merged" | "conflict"; priorHead: string; priorTree: string | null; mergeCommit: string | null; tree: string | null; conflictFilesJson: string; conflictArtifactId: string | null; conflictArtifactSha256: string | null } | undefined);
  }

  private async revalidateStoredOperation(input: ForwardMergeInput, stored: { id: string; status: "no_drift" | "merged" | "conflict"; priorHead: string; priorTree: string | null; mergeCommit: string | null; tree: string | null; conflictFilesJson: string; conflictArtifactId: string | null; conflictArtifactSha256: string | null }, observedBaseSha: string): Promise<ForwardMergeResult> {
    if (!stored.priorTree) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
    if (stored.status === "no_drift") {
      const ownership = await this.inspectOwnership(input);
      if (ownership.headSha.toLowerCase() !== stored.priorHead.toLowerCase() || ownership.treeSha.toLowerCase() !== stored.priorTree.toLowerCase()) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
      return { status: "no_drift", priorHead: stored.priorHead, priorTree: stored.priorTree, targetBaseSha: observedBaseSha, mergeCommit: null, tree: null, conflictFiles: [], forwardMergeId: stored.id };
    }
    const branch = await this.git(["branch", "--show-current"], input.worktreePath);
    const currentHead = await this.git(["rev-parse", "HEAD"], input.worktreePath);
    if (branch !== input.branchName) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
    if (stored.status === "conflict") {
      const mergeHead = await this.gitOptional(["rev-parse", "MERGE_HEAD"], input.worktreePath);
      const conflicts = (await this.gitOptional(["diff", "--name-only", "--diff-filter=U", "-z"], input.worktreePath) ?? "").split("\0").filter(Boolean);
      const expected = jsonRequired(stored.conflictFilesJson) as unknown;
      if (currentHead.toLowerCase() !== stored.priorHead.toLowerCase() || mergeHead?.toLowerCase() !== observedBaseSha.toLowerCase() || JSON.stringify(conflicts) !== JSON.stringify(expected)) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
      return { status: "conflict", priorHead: stored.priorHead, priorTree: stored.priorTree, targetBaseSha: observedBaseSha, mergeCommit: null, tree: null, conflictFiles: conflicts, ...(stored.conflictArtifactId && stored.conflictArtifactSha256 ? { conflictArtifact: { id: stored.conflictArtifactId, sha256: stored.conflictArtifactSha256, kind: "forward-merge-conflict" as const } } : {}), forwardMergeId: stored.id };
    }
    if (!stored.mergeCommit || !stored.tree) throw new ForwardMergeFailure("merge-state-ownership-mismatch");
    await this.assertMergedOwnership({ worktreePath: input.worktreePath, branchName: input.branchName, priorHead: stored.priorHead, targetBaseSha: observedBaseSha, mergeCommit: stored.mergeCommit, tree: stored.tree });
    return { status: "merged", priorHead: stored.priorHead, priorTree: stored.priorTree, targetBaseSha: observedBaseSha, mergeCommit: stored.mergeCommit, tree: stored.tree, conflictFiles: [], forwardMergeId: stored.id };
  }
}
