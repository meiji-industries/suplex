import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, constants, lstat, mkdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ForgeDatabase } from "./database.js";
import { OwnedWorktreeSchema, type OwnedWorktree } from "./developer-contracts.js";

const execFileAsync = promisify(execFile);

export class WorktreeFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorktreeFailure";
    this.code = code;
  }
}

export interface WorktreeInput {
  repositoryPath: string;
  worktreeRoot: string;
  taskId: string;
  targetBaseSha: string;
  branchName?: string;
  pathSegment?: string;
}

export interface WorktreeRecord {
  branchName: string;
  worktreePath: string;
  targetBaseSha: string;
}

export interface DeliveryGitState {
  branchName: string;
  headSha: string;
  treeSha: string;
  dirtyState: "clean" | "dirty";
}

export interface WorktreeDiffInput extends WorktreeInput {
  worktreePath: string;
  resultCommit?: string;
}

export interface WorktreeDiff {
  patch: string;
  headSha: string;
}

export interface PlanRevisionInspectionInput {
  repositoryPath: string;
  worktreeRoot: string;
  worktreePath: string;
  branchName: string;
  baseSha: string;
  resultCommit?: string | null;
  resultTree?: string | null;
}

export interface PlanRevisionInspectionResult {
  branchName: string;
  baseSha: string;
  headSha: string;
  treeSha: string;
  dirtyState: "clean";
}

export interface ExactBaseValidationInput {
  repositoryPath: string;
  candidateSha: string;
  acceptedTargetSha: string;
}

export interface OwnedWorktreeCoordinates {
  taskId: string;
  companyId: string;
  projectId: string;
  workflowId: string;
  repositoryRoot: string;
  worktreeRoot: string;
  worktreePath: string;
  branchName: string;
  startingSha: string;
  legacy?: boolean;
}

export interface OwnedWorktreeInspection {
  owned: OwnedWorktree;
  repositoryRegistered: boolean;
  pathExists: boolean;
  pathIsSymlink: boolean;
  branchHead: string | null;
  head: string | null;
  branch: string | null;
  dirtyState: "clean" | "dirty" | "unknown";
}

interface GitAdapter {
  run(args: string[], cwd: string): Promise<string>;
}

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const shaPattern = /^[a-f0-9]{40,64}$/i;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;
const pathSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function withinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function exactRegisteredWorktree(output: string, worktreePath: string, branchName: string, head: string | null): boolean {
  return output.split(/\n(?=worktree )/).some((block) => {
    const lines = block.split(/\r?\n/);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    const actualHead = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    return path === worktreePath && branch === branchName && (!head || actualHead?.toLowerCase() === head.toLowerCase());
  });
}

const defaultGit: GitAdapter = {
  async run(args, cwd) {
    const result = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  },
};

const defaultMinFreeDiskGb = 10;

export async function assertWorktreeDiskHeadroom(worktreeRoot: string, statfsFn: typeof statfs = statfs): Promise<void> {
  const envGb = Number.parseFloat(process.env.FORGE_MIN_FREE_DISK_GB ?? "");
  const thresholdGb = Number.isFinite(envGb) && envGb >= 0 ? envGb : defaultMinFreeDiskGb;
  const filesystem = await statfsFn(worktreeRoot);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const thresholdBytes = thresholdGb * 1024 * 1024 * 1024;
  if (freeBytes < thresholdBytes) throw new WorktreeFailure("host_capacity", `Free disk below ${thresholdGb} GB on ${worktreeRoot} (${(freeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB available); free space and retry`);
}

async function canonicalDirectory(raw: string, code: string): Promise<string> {
  const absolute = resolve(raw);
  try {
    const canonical = await realpath(absolute);
    const stat = await lstat(absolute);
    if (!stat.isDirectory()) throw new WorktreeFailure(code, "Configured path must be an existing canonical directory");
    return canonical;
  } catch (error) {
    if (error instanceof WorktreeFailure) throw error;
    throw new WorktreeFailure(code, "Configured path is unavailable or is a symbolic link");
  }
}

export class WorktreeManager {
  constructor(private readonly git: GitAdapter = defaultGit) {}

  // The base a task builds on must be the branch as it is now, not the snapshot pinned
  // when the project revision was accepted.
  async currentBaseSha(repositoryPath: string, baseBranch: string): Promise<string> {
    if (!branchPattern.test(baseBranch)) throw new WorktreeFailure("unsafe-branch", "Base branch is not a safe Git ref");
    const canonical = await canonicalDirectory(repositoryPath, "repository-unavailable");
    await this.git.run(["fetch", "--no-tags", "origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], canonical);
    const sha = await this.git.run(["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}`], canonical);
    if (!shaPattern.test(sha)) throw new WorktreeFailure("base-commit-mismatch", "Fetched base branch did not resolve to a commit");
    return sha;
  }

  async create(input: WorktreeInput): Promise<WorktreeRecord> {
    if (!taskIdPattern.test(input.taskId)) throw new WorktreeFailure("unsafe-task-id", "Issue identity is not safe for a worktree coordinate");
    if (!shaPattern.test(input.targetBaseSha)) throw new WorktreeFailure("invalid-base-commit", "Target-base revision is not a canonical commit hash");
    const repositoryPath = await canonicalDirectory(input.repositoryPath, "repository-unavailable");
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "worktree-root-unavailable");
    if (withinRoot(repositoryPath, worktreeRoot) || withinRoot(worktreeRoot, repositoryPath)) throw new WorktreeFailure("worktree-separation", "Worktree root must be separate from the repository");
    const branchName = input.branchName ?? `forge/issue/${input.taskId}`;
    if (!branchPattern.test(branchName) || branchName.includes("..")) throw new WorktreeFailure("unsafe-branch", "Issue branch name is unsafe");
    const pathSegment = input.pathSegment ?? input.taskId;
    if (!pathSegmentPattern.test(pathSegment)) throw new WorktreeFailure("unsafe-worktree-segment", "Worktree path segment is unsafe");
    const worktreePath = resolve(worktreeRoot, pathSegment);
    if (!withinRoot(worktreeRoot, worktreePath)) throw new WorktreeFailure("worktree-escape", "Worktree path escaped the configured root");
    try {
      await lstat(worktreePath);
      throw new WorktreeFailure("worktree-exists", "The deterministic issue worktree already exists and cannot be reused implicitly");
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorktreeFailure("worktree-unavailable", "The deterministic issue worktree cannot be inspected");
    }
    try {
      const status = await this.git.run(["status", "--porcelain", "--untracked-files=all"], repositoryPath);
      if (status) throw new WorktreeFailure("repository-dirty", "The recorded target repository must be clean before development starts");
      let resolvedBase: string;
      try { resolvedBase = await this.git.run(["rev-parse", "--verify", `${input.targetBaseSha}^{commit}`], repositoryPath); } catch { throw new WorktreeFailure("base-commit-mismatch", "Target-base revision does not resolve to a commit in the repository"); }
      if (resolvedBase.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new WorktreeFailure("base-commit-mismatch", "Target-base revision does not resolve to the recorded commit");
      try {
        await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath);
        throw new WorktreeFailure("branch-exists", "The deterministic issue branch already exists and cannot be reused implicitly");
      } catch (error) {
        if (error instanceof WorktreeFailure) throw error;
      }
      await assertWorktreeDiskHeadroom(worktreeRoot);
      await this.git.run(["worktree", "add", "-b", branchName, worktreePath, input.targetBaseSha], repositoryPath);
      const canonicalWorktree = await realpath(worktreePath);
      if (canonicalWorktree !== worktreePath) throw new WorktreeFailure("worktree-symlink", "Created worktree path resolved through a symbolic link");
      const actualRoot = await this.git.run(["rev-parse", "--show-toplevel"], worktreePath);
      const actualBranch = await this.git.run(["symbolic-ref", "--short", "HEAD"], worktreePath);
      const actualHead = await this.git.run(["rev-parse", "HEAD"], worktreePath);
      if (actualRoot !== worktreePath || actualBranch !== branchName || actualHead.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new WorktreeFailure("worktree-verification", "Created worktree did not match its recorded branch and base revision");
      return { branchName, worktreePath, targetBaseSha: input.targetBaseSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("worktree-create-failed", "Git could not create the isolated issue worktree");
    }
  }

  async inspectDelivery(worktreePath: string): Promise<DeliveryGitState> {
    const canonical = await canonicalDirectory(worktreePath, "worktree-unavailable");
    try {
      const [branchName, headSha, treeSha, status] = await Promise.all([
        this.git.run(["symbolic-ref", "--short", "HEAD"], canonical),
        this.git.run(["rev-parse", "HEAD"], canonical),
        this.git.run(["rev-parse", "HEAD^{tree}"], canonical),
        this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], canonical),
      ]);
      return { branchName, headSha, treeSha, dirtyState: status ? "dirty" : "clean" };
    } catch {
      throw new WorktreeFailure("delivery-inspection-failed", "Git could not inspect the exact Developer delivery");
    }
  }

  async currentDiff(input: WorktreeDiffInput): Promise<WorktreeDiff> {
    const record = await this.reuse(input);
    if (input.resultCommit && !shaPattern.test(input.resultCommit)) throw new WorktreeFailure("invalid-result-commit", "Recorded Developer result is not a canonical commit hash");
    try {
      const [patch, headSha] = input.resultCommit
        ? await Promise.all([
          this.git.run(["diff", "--no-ext-diff", "--find-renames", input.targetBaseSha, input.resultCommit, "--"], record.worktreePath),
          this.git.run(["rev-parse", "--verify", `${input.resultCommit}^{commit}`], record.worktreePath),
        ])
        : await Promise.all([
          this.git.run(["diff", "--no-ext-diff", "--find-renames", input.targetBaseSha, "--"], record.worktreePath),
          this.git.run(["rev-parse", "HEAD"], record.worktreePath),
        ]);
      return { patch, headSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("diff-unavailable", "Git could not read the current Developer delivery diff");
    }
  }

  async inspectForPlanRevision(input: PlanRevisionInspectionInput): Promise<PlanRevisionInspectionResult> {
    if (!shaPattern.test(input.baseSha) || (input.resultCommit && !shaPattern.test(input.resultCommit)) || (input.resultTree && !shaPattern.test(input.resultTree))) throw new WorktreeFailure("invalid-revision-coordinate", "Preserved Git coordinates are invalid");
    const repositoryPath = await canonicalDirectory(input.repositoryPath, "repository-unavailable");
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "worktree-root-unavailable");
    const expectedPath = resolve(input.worktreePath);
    if (!withinRoot(worktreeRoot, expectedPath) || expectedPath === worktreeRoot) throw new WorktreeFailure("worktree-escape", "Preserved worktree is outside the configured root");
    const canonicalWorktree = await canonicalDirectory(expectedPath, "worktree-unavailable");
    if (canonicalWorktree !== expectedPath) throw new WorktreeFailure("worktree-symlink", "Preserved worktree path is not canonical");
    try {
      const [configuredGitDir, worktreeGitDir, actualRoot, actualBranch, headSha, treeSha] = await Promise.all([
        this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryPath),
        this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], canonicalWorktree),
        this.git.run(["rev-parse", "--show-toplevel"], canonicalWorktree),
        this.git.run(["symbolic-ref", "--short", "HEAD"], canonicalWorktree),
        this.git.run(["rev-parse", "HEAD"], canonicalWorktree),
        this.git.run(["rev-parse", "HEAD^{tree}"], canonicalWorktree),
      ]);
      if (configuredGitDir !== worktreeGitDir) throw new WorktreeFailure("worktree-ownership", "Preserved worktree is not owned by the configured repository");
      if (actualRoot !== canonicalWorktree) throw new WorktreeFailure("worktree-ownership", "Preserved worktree belongs to a different repository");
      if (actualBranch !== input.branchName) throw new WorktreeFailure("branch-mismatch", "Preserved worktree branch does not match the recorded branch");
      const status = await this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], canonicalWorktree);
      if (status) throw new WorktreeFailure("worktree-dirty", "Preserved worktree is not clean");
      for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
        let markerPath: string;
        try { markerPath = await this.git.run(["rev-parse", "--git-path", marker], canonicalWorktree); } catch { throw new WorktreeFailure("git-operation-check-failed", "Git operation state could not be inspected"); }
        try { await access(resolve(canonicalWorktree, markerPath), constants.F_OK); throw new WorktreeFailure("git-operation-in-progress", "Preserved worktree has an incomplete Git operation"); } catch (error) {
          if (error instanceof WorktreeFailure) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorktreeFailure("git-operation-check-failed", "Git operation state could not be inspected");
        }
      }
      return { branchName: actualBranch, baseSha: input.baseSha, headSha, treeSha, dirtyState: "clean" };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("revision-inspection-failed", "Preserved worktree could not be safely inspected");
    }
  }

  async validateExactBase(input: ExactBaseValidationInput): Promise<string> {
    if (!shaPattern.test(input.candidateSha) || !shaPattern.test(input.acceptedTargetSha)) throw new WorktreeFailure("invalid-base-commit", "Exact base must be a canonical commit hash");
    const repositoryPath = await canonicalDirectory(input.repositoryPath, "repository-unavailable");
    let resolvedCandidate: string;
    try { resolvedCandidate = await this.git.run(["rev-parse", "--verify", `${input.candidateSha}^{commit}`], repositoryPath); } catch { throw new WorktreeFailure("base-commit-mismatch", "Exact base does not resolve to a commit"); }
    if (resolvedCandidate.toLowerCase() !== input.candidateSha.toLowerCase()) throw new WorktreeFailure("base-commit-mismatch", "Exact base does not resolve to the supplied commit");
    try { await this.git.run(["merge-base", "--is-ancestor", resolvedCandidate, input.acceptedTargetSha], repositoryPath); } catch { throw new WorktreeFailure("base-not-allowed", "Exact base is not an ancestor of the accepted project target"); }
    return resolvedCandidate;
  }

  async reuse(input: WorktreeInput): Promise<WorktreeRecord> {
    if (!taskIdPattern.test(input.taskId) || !shaPattern.test(input.targetBaseSha)) throw new WorktreeFailure("invalid-reuse-coordinate", "Preserved worktree coordinates are invalid");
    const repositoryPath = await canonicalDirectory(input.repositoryPath, "repository-unavailable");
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "worktree-root-unavailable");
    const branchName = input.branchName ?? `forge/issue/${input.taskId}`;
    if (!branchPattern.test(branchName) || branchName.includes("..")) throw new WorktreeFailure("unsafe-branch", "Issue branch name is unsafe");
    const worktreePath = resolve(worktreeRoot, input.pathSegment ?? input.taskId);
    if (!withinRoot(worktreeRoot, worktreePath)) throw new WorktreeFailure("worktree-escape", "Preserved worktree escaped the configured root");

    let canonicalWorktree: string;
    try {
      canonicalWorktree = await canonicalDirectory(worktreePath, "worktree-unavailable");
    } catch (error) {
      if (!(error instanceof WorktreeFailure) || error.code !== "worktree-unavailable") throw error;
      await assertWorktreeDiskHeadroom(worktreeRoot);
      try {
        await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath);
        await this.git.run(["worktree", "add", worktreePath, branchName], repositoryPath);
      } catch {
        try { await this.git.run(["worktree", "add", "-b", branchName, worktreePath, input.targetBaseSha], repositoryPath); }
        catch { throw new WorktreeFailure("worktree-recreate-failed", "The task worktree is unavailable and could not be recreated from its branch"); }
      }
      return await this.reuse(input);
    }
    try {
      const [configuredGitDir, worktreeGitDir, actualRoot, actualBranch, actualHead, status] = await Promise.all([
        this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryPath),
        this.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], canonicalWorktree),
        this.git.run(["rev-parse", "--show-toplevel"], canonicalWorktree),
        this.git.run(["symbolic-ref", "--short", "HEAD"], canonicalWorktree),
        this.git.run(["rev-parse", "HEAD"], canonicalWorktree),
        this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], canonicalWorktree),
      ]);
      if (configuredGitDir !== worktreeGitDir || actualRoot !== canonicalWorktree) throw new WorktreeFailure("worktree-not-owned", "The preserved directory is not a Git worktree of the configured repository");
      if (actualBranch !== branchName) {
        if (status) throw new WorktreeFailure("worktree-dirty", "The preserved worktree has uncommitted changes and cannot switch to the task branch");
        try { await this.git.run(["switch", branchName], canonicalWorktree); }
        catch { throw new WorktreeFailure("worktree-branch-switch-failed", "The preserved worktree could not switch to the task branch"); }
        return await this.reuse(input);
      }
      return { branchName, worktreePath: canonicalWorktree, targetBaseSha: actualHead };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("worktree-not-owned", "The preserved directory is not a usable Git worktree of the configured repository");
    }
  }

  async materialize(owned: OwnedWorktree): Promise<OwnedWorktreeInspection> {
    const validated = OwnedWorktreeSchema.parse(owned);
    const repositoryPath = await canonicalDirectory(validated.repositoryRoot, "repository-unavailable");
    const worktreeRoot = await canonicalDirectory(validated.worktreeRoot, "worktree-root-unavailable");
    if (withinRoot(repositoryPath, worktreeRoot) || withinRoot(worktreeRoot, repositoryPath) || !withinRoot(worktreeRoot, validated.worktreePath)) throw new WorktreeFailure("worktree-separation", "Owned worktree paths overlap or escape configured roots");
    if (!shaPattern.test(validated.startingSha)) throw new WorktreeFailure("invalid-base-commit", "Owned worktree starting SHA is invalid");
    try {
      await this.git.run(["rev-parse", "--verify", `${validated.startingSha}^{commit}`], repositoryPath);
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("base-commit-mismatch", "Owned worktree starting SHA is unavailable");
    }
    const before = await this.inspectOwned(validated, repositoryPath).catch(() => undefined);
    if (before?.pathIsSymlink || before?.pathExists && before.head === null) throw new WorktreeFailure("worktree-registry-ambiguous", "Owned worktree path exists but its Git identity is ambiguous");
    if (before?.repositoryRegistered && before.head && before.branch === validated.branchName) return before;
    if (validated.status === "active" && before?.repositoryRegistered && before.head && before.branch === validated.branchName) {
      return before;
    }
    const branchExists = Boolean(before?.branchHead);
    if (!before?.pathExists) {
      // Reattach an existing task branch so its commits survive a missing worktree.
      await assertWorktreeDiskHeadroom(worktreeRoot);
      const add = branchExists ? ["worktree", "add", validated.worktreePath, validated.branchName] : ["worktree", "add", "-b", validated.branchName, validated.worktreePath, validated.startingSha];
      try { await this.git.run(add, repositoryPath); } catch {
        const afterFailure = await this.inspectOwned(validated, repositoryPath).catch(() => undefined);
        if (!afterFailure?.head || afterFailure.branch !== validated.branchName) throw new WorktreeFailure("worktree-registry-ambiguous", "Git worktree creation failed with an unresolved registry state");
      }
      const created = await this.inspectOwned(validated, repositoryPath);
      if (!created.repositoryRegistered || !created.head || created.branch !== validated.branchName || created.dirtyState !== "clean") throw new WorktreeFailure("worktree-registry-ambiguous", "Created worktree did not match the task branch");
      return created;
    }
    throw new WorktreeFailure("worktree-registry-ambiguous", "Existing branch or path does not exactly match the reserved worktree");
  }

  async inspectOwned(owned: OwnedWorktree, repositoryPath = owned.repositoryRoot): Promise<OwnedWorktreeInspection> {
    const validated = OwnedWorktreeSchema.parse(owned);
    let pathExists = false;
    let pathIsSymlink = false;
    try { const stat = await lstat(validated.worktreePath); pathExists = true; pathIsSymlink = stat.isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorktreeFailure("worktree-unavailable", "Owned worktree path cannot be inspected"); }
    let branchHead: string | null = null;
    try { branchHead = await this.git.run(["rev-parse", "--verify", `refs/heads/${validated.branchName}`], repositoryPath); } catch { /* branch absent */ }
    let repositoryRegistered = false;
    try { repositoryRegistered = exactRegisteredWorktree(await this.git.run(["worktree", "list", "--porcelain"], repositoryPath), resolve(validated.worktreePath), validated.branchName, branchHead); } catch { /* ambiguous registry */ }
    if (!pathExists || pathIsSymlink) return { owned: validated, repositoryRegistered, pathExists, pathIsSymlink, branchHead, head: null, branch: null, dirtyState: pathIsSymlink ? "unknown" : "clean" };
    try {
      const [head, branch, status] = await Promise.all([
        this.git.run(["rev-parse", "HEAD"], validated.worktreePath),
        this.git.run(["symbolic-ref", "--short", "HEAD"], validated.worktreePath),
        this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], validated.worktreePath),
      ]);
      return { owned: validated, repositoryRegistered, pathExists, pathIsSymlink, branchHead, head, branch, dirtyState: status ? "dirty" : "clean" };
    } catch { return { owned: validated, repositoryRegistered, pathExists, pathIsSymlink, branchHead, head: null, branch: null, dirtyState: "unknown" }; }
  }
}

export function reserveOwnedWorktree(database: ForgeDatabase, input: OwnedWorktreeCoordinates): OwnedWorktree {
  const existing = database.authQuery((db) => db.prepare("SELECT id AS leaseId, lease_token_hash AS leaseTokenHash, task_id AS taskId, company_id AS companyId, project_id AS projectId, workflow_id AS workflowId, repository_path AS repositoryRoot, worktree_root AS worktreeRoot, worktree_path AS worktreePath, branch_name AS branchName, starting_sha AS startingSha, legacy, status FROM forge_issue_worktrees WHERE task_id = ? AND status <> 'released'").get(input.taskId) as (Omit<OwnedWorktree, "legacy"> & { legacy: number }) | undefined);
  if (existing) {
    const stored = OwnedWorktreeSchema.parse({ ...existing, legacy: existing.legacy === 1 });
    const checkedOutBranch = existsSync(stored.worktreePath)
      ? (() => {
          try { return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: stored.worktreePath, encoding: "utf8", timeout: 8_000 }).trim(); }
          catch { return null; }
        })()
      : null;
    if (!existsSync(stored.worktreePath) && hasUnpushedWork(stored)) {
      throw new WorktreeFailure("worktree-lease-conflict", `The recorded worktree path is gone while ${stored.branchName} has work that would be lost. Restore the worktree path or push/preserve that branch, then retry.`);
    }
    if (checkedOutBranch === stored.branchName && (stored.repositoryRoot !== input.repositoryRoot || stored.worktreeRoot !== input.worktreeRoot || stored.startingSha.toLowerCase() !== input.startingSha.toLowerCase())) {
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET repository_path = ?, worktree_root = ?, starting_sha = ? WHERE id = ?").run(input.repositoryRoot, input.worktreeRoot, input.startingSha, stored.leaseId));
      return { ...stored, repositoryRoot: input.repositoryRoot, worktreeRoot: input.worktreeRoot, startingSha: input.startingSha };
    }
    return stored;
  }
  const owned = OwnedWorktreeSchema.parse({ ...input, leaseId: `worktree_${randomBytes(12).toString("hex")}`, leaseTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"), legacy: input.legacy ?? false, status: "reserved" });
  try {
    database.authTransaction((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, status, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)").run(owned.leaseId, owned.taskId, owned.companyId, owned.projectId, owned.workflowId, owned.repositoryRoot, owned.worktreeRoot, owned.worktreePath, owned.branchName, owned.startingSha, owned.leaseTokenHash, owned.legacy ? 1 : 0, new Date().toISOString()));
  } catch (error) {
    if (error instanceof Error && /UNIQUE|active/i.test(error.message)) throw new WorktreeFailure("worktree-lease-conflict", "The issue, branch, or path already has an active worktree lease");
    throw error;
  }
  return owned;
}

function hasUnpushedWork(owned: OwnedWorktree): boolean {
  try {
    return Number.parseInt(execFileSync("git", ["rev-list", "--count", `${owned.startingSha}..${owned.branchName}`], { cwd: owned.repositoryRoot, encoding: "utf8", timeout: 8_000 }).trim(), 10) > 0;
  } catch {
    return false;
  }
}

export function activateOwnedWorktree(database: ForgeDatabase, inspection: OwnedWorktreeInspection): OwnedWorktree {
  if (!inspection.repositoryRegistered || inspection.dirtyState !== "clean" || !inspection.head || inspection.branch !== inspection.owned.branchName || inspection.pathIsSymlink) throw new WorktreeFailure("worktree-verification", "Owned worktree did not match the task branch");
  database.authTransaction((db) => {
    const result = db.prepare("UPDATE forge_issue_worktrees SET status = 'active', activated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND project_id = ? AND workflow_id = ? AND worktree_path = ? AND branch_name = ? AND starting_sha = ? AND status = 'reserved'").run(new Date().toISOString(), inspection.owned.leaseId, inspection.owned.taskId, inspection.owned.companyId, inspection.owned.projectId, inspection.owned.workflowId, inspection.owned.worktreePath, inspection.owned.branchName, inspection.owned.startingSha);
    if (result.changes !== 1) throw new WorktreeFailure("worktree-lease-conflict", "Owned worktree activation lost its compare-and-set lease");
  });
  return { ...inspection.owned, status: "active" };
}

export interface GitCommandGuard {
  directory: string;
  gitRealBin?: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export function withWorktreeMiseTrust(env: NodeJS.ProcessEnv, worktreePath: string): NodeJS.ProcessEnv {
  return { ...env, MISE_TRUSTED_CONFIG_PATHS: [env.MISE_TRUSTED_CONFIG_PATHS, worktreePath].filter(Boolean).join(delimiter) };
}

export async function createGitCommandGuard(runtimeRoot: string): Promise<GitCommandGuard> {
  const directory = join(resolve(runtimeRoot), `developer-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const gitBin = process.env.FORGE_GIT_BIN?.trim() || execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  if (!gitBin) throw new WorktreeFailure("git-unavailable", "Git is unavailable for guarded Developer execution");
  const gitGuard = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    push|rebase|clean|reset|merge|cherry-pick|revert|worktree|update-ref|filter-repo|gc|prune) echo "Forge Developer policy blocked git $arg" >&2; exit 125 ;;
    --amend|-D|-d|--force|-f) echo "Forge Developer policy blocked destructive git option $arg" >&2; exit 125 ;;
  esac
done
exec "$FORGE_GIT_REAL_BIN" "$@"
`;
  const ghGuard = `#!/bin/sh
echo "Forge Developer policy blocks provider-side GitHub mutation" >&2
exit 125
  `;
  await writeFile(join(directory, "git"), gitGuard, { encoding: "utf8", mode: 0o700 });
  await writeFile(join(directory, "gh"), ghGuard, { encoding: "utf8", mode: 0o700 });
  return {
    directory,
    gitRealBin: gitBin,
    env: { ...process.env, PATH: `${directory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`, FORGE_GIT_REAL_BIN: gitBin, FORGE_GIT_GUARD_DIR: directory },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}
