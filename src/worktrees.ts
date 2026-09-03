// eslint-disable-next-line no-restricted-imports -- synchronous Git probes run inside transaction paths.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, constants, lstat, mkdir, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import { delimiter, join, relative, resolve, sep } from "node:path";

import { DEFAULT_MIN_FREE_DISK_GB } from "./environment-settings.js";
import type { ForgeDatabase } from "./database.js";
import { OwnedWorktreeSchema, type OwnedWorktree } from "./developer-contracts.js";
import { runCommand, type CommandRunResult } from "./command-runner.js";


export class WorktreeFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorktreeFailure";
    this.code = code;
  }
}

async function rebuildNativeModulesIfNeeded(worktreePath: string, activity?: { taskId: string; stepId: string }): Promise<void> {
  if (!existsSync(join(worktreePath, "node_modules"))) return;
  const env = withWorktreeMiseTrust(process.env, worktreePath);
  const probe = await runCommand({ taskId: activity?.taskId ?? null, stepId: activity?.stepId ?? null, command: "node", args: ["-e", "require('better-sqlite3')"], cwd: worktreePath, env, timeout: 30_000, expectNonZero: true });
  if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED/.test(`${probe.stdout}\n${probe.stderr}`)) return;
  await runCommand({ taskId: activity?.taskId ?? null, stepId: activity?.stepId ?? null, command: "sh", args: ["-lc", "pnpm rebuild"], cwd: worktreePath, env, timeout: 20 * 60_000, expectNonZero: true });
}

export interface WorktreeInput {
  repositoryPath: string;
  worktreeRoot: string;
  taskId: string;
  targetBaseSha: string;
  branchName?: string;
  pathSegment?: string;
  /** Timeline step which caused this worktree operation. */
  stepId?: string;
}

export interface WorktreeRecord {
  branchName: string;
  worktreePath: string;
  targetBaseSha: string;
}

export interface AdoptWorktreeInput extends Omit<WorktreeInput, "targetBaseSha"> {
  branchName: string;
  baseBranch: string;
  sourceHeadSha?: string;
  preserveLocal?: boolean;
}

export interface SyncBaseResult {
  synced: boolean;
  reason?: "dirty" | "other-branch";
  headSha: string;
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

export interface LiveWorktreeDiffInput {
  repositoryPath: string;
  worktreeRoot: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string | null;
  baseBranch: string;
}

export interface LiveWorktreeDiff extends WorktreeDiff {
  branchName: string;
  baseSha: string;
  etag: string;
}
export interface BranchSync {
  remoteExists: boolean;
  ahead: number;
  behind: number;
  aheadOfBase: number;
  behindBase: number;
  conflictsWithBase: boolean;
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
  run(args: string[], cwd: string, activity?: { taskId: string; stepId: string }, options?: { expectNonZero?: boolean | ((result: CommandRunResult) => boolean); expectedExitCodes?: readonly number[] }): Promise<string>;
}

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const shaPattern = /^[a-f0-9]{40,64}$/i;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;
function exactRemoteCommit(output: string, remoteRef: string): string | null {
  const commits = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [commit, ref, ...extra] = line.trim().split(/\s+/);
    if (extra.length || ref !== remoteRef || !commit || !shaPattern.test(commit)) throw new WorktreeFailure("operation-recovery-ambiguous", "The exact remote branch observation was ambiguous");
    return commit.toLowerCase();
  });
  if (commits.length > 1) throw new WorktreeFailure("operation-recovery-ambiguous", "The exact remote branch observation was ambiguous");
  return commits[0] ?? null;
}
void exactRemoteCommit;
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

const branchFetches = new Map<string, number>();
const branchConflictProbes = new Map<string, { conflictsWithBase: boolean; probedAt: number }>();
const branchSyncProbes = new Map<string, Promise<BranchSync>>();
const branchSyncCache = new Map<string, { at: number; value: BranchSync }>();
const branchProbeIntervalMs = 60_000;
const branchSyncCacheTtlMs = 30_000;

export async function invalidateBranchSync(worktreePath: string, branchName: string): Promise<void> {
  const canonical = await realpath(worktreePath).catch(() => resolve(worktreePath));
  const prefix = `${canonical}\0${branchName}\0`;
  for (const key of branchSyncCache.keys()) {
    if (key.startsWith(prefix)) branchSyncCache.delete(key);
  }
}

const defaultGit: GitAdapter = {
  async run(args, cwd, activity, options) {
    const result = await runCommand({ taskId: activity?.taskId ?? "system", stepId: activity?.stepId ?? "system", command: "git", args, cwd, timeout: 30_000, ...options });
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("git command failed"), { stdout: result.stdout, stderr: result.stderr, code: result.exitCode });
    return result.stdout.trim();
  },
};

const liveDiffMaxBytes = 2 * 1024 * 1024;
const liveUntrackedFileMaxBytes = 256 * 1024;

async function runLiveGit(args: string[], cwd: string, maxBuffer = liveDiffMaxBytes): Promise<string> {
  void maxBuffer;
  const result = await runCommand({ taskId: "system", stepId: "system", command: "git", args, cwd, timeout: 5_000 });
  if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("git command failed"), { stdout: result.stdout, stderr: result.stderr, code: result.exitCode });
  return result.stdout;
}

function untrackedPatch(path: string, bytes: Buffer): string {
  const content = bytes.subarray(0, liveUntrackedFileMaxBytes);
  if (content.includes(0)) return `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`;
  const text = content.toString("utf8");
  const lines = text.split("\n");
  const rendered = lines.map((line) => `+${line}`).join("\n");
  const suffix = bytes.length > content.length ? `\n+… truncated after ${liveUntrackedFileMaxBytes} bytes` : "";
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${rendered}${suffix}\n`;
}

export async function assertWorktreeDiskHeadroom(worktreeRoot: string, statfsFn: typeof statfs = statfs, configuredMinFreeDiskGb = DEFAULT_MIN_FREE_DISK_GB): Promise<void> {
  const envGb = Number.parseFloat(process.env.FORGE_MIN_FREE_DISK_GB ?? "");
  const thresholdGb = Number.isFinite(envGb) && envGb >= 0 ? envGb : configuredMinFreeDiskGb;
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
  constructor(private readonly git: GitAdapter = defaultGit, private readonly minFreeDiskGb: () => number = () => DEFAULT_MIN_FREE_DISK_GB) {}

  async remove(repositoryPath: string, worktreePath: string): Promise<void> {
    const repository = await canonicalDirectory(repositoryPath, "repository-unavailable");
    await this.git.run(["worktree", "remove", "--force", worktreePath], repository);
    await this.git.run(["worktree", "prune"], repository);
  }

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

  async syncBase(repositoryPath: string, baseBranch: string): Promise<SyncBaseResult> {
    if (!branchPattern.test(baseBranch)) throw new WorktreeFailure("unsafe-branch", "Base branch is not a safe Git ref");
    const canonical = await canonicalDirectory(repositoryPath, "repository-unavailable");
    try {
      await this.git.run(["fetch", "--no-tags", "origin", `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], canonical);
      const [status, branch] = await Promise.all([
        this.git.run(["status", "--porcelain", "--untracked-files=all"], canonical),
        this.git.run(["symbolic-ref", "--short", "HEAD"], canonical),
      ]);
      if (status || branch !== baseBranch) {
        const headSha = await this.git.run(["rev-parse", "HEAD"], canonical);
        if (!shaPattern.test(headSha)) throw new WorktreeFailure("base-commit-mismatch", "Repository HEAD did not resolve to a commit");
        return { synced: false, reason: status ? "dirty" : "other-branch", headSha };
      }
      await this.git.run(["merge", "--ff-only", `refs/remotes/origin/${baseBranch}`], canonical);
      const headSha = await this.git.run(["rev-parse", "HEAD"], canonical);
      if (!shaPattern.test(headSha)) throw new WorktreeFailure("base-commit-mismatch", "Repository HEAD did not resolve to a commit");
      return { synced: true, headSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("base-sync-failed", "Git could not synchronize the repository base branch");
    }
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
      const activity = { taskId: input.taskId, stepId: input.stepId ?? input.taskId };
      const status = await this.git.run(["status", "--porcelain", "--untracked-files=all"], repositoryPath, activity);
      if (status) throw new WorktreeFailure("repository-dirty", "The recorded target repository must be clean before development starts");
      let resolvedBase: string;
      try { resolvedBase = await this.git.run(["rev-parse", "--verify", `${input.targetBaseSha}^{commit}`], repositoryPath, activity); } catch { throw new WorktreeFailure("base-commit-mismatch", "Target-base revision does not resolve to a commit in the repository"); }
      if (resolvedBase.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new WorktreeFailure("base-commit-mismatch", "Target-base revision does not resolve to the recorded commit");
      try {
        await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath, activity, { expectedExitCodes: [1] });
        throw new WorktreeFailure("branch-exists", "The deterministic issue branch already exists and cannot be reused implicitly");
      } catch (error) {
        if (error instanceof WorktreeFailure) throw error;
      }
      await assertWorktreeDiskHeadroom(worktreeRoot, statfs, this.minFreeDiskGb());
      await this.git.run(["worktree", "add", "-b", branchName, worktreePath, input.targetBaseSha], repositoryPath, activity);
      const canonicalWorktree = await realpath(worktreePath);
      if (canonicalWorktree !== worktreePath) throw new WorktreeFailure("worktree-symlink", "Created worktree path resolved through a symbolic link");
      const actualRoot = await this.git.run(["rev-parse", "--show-toplevel"], worktreePath, activity);
      const actualBranch = await this.git.run(["symbolic-ref", "--short", "HEAD"], worktreePath, activity);
      const actualHead = await this.git.run(["rev-parse", "HEAD"], worktreePath, activity);
      if (actualRoot !== worktreePath || actualBranch !== branchName || actualHead.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new WorktreeFailure("worktree-verification", "Created worktree did not match its recorded branch and base revision");
      await rebuildNativeModulesIfNeeded(worktreePath, activity);
      return { branchName, worktreePath, targetBaseSha: input.targetBaseSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("worktree-create-failed", "Git could not create the isolated issue worktree");
    }
  }

  async adopt(input: AdoptWorktreeInput): Promise<WorktreeRecord> {
    if (!taskIdPattern.test(input.taskId)) throw new WorktreeFailure("unsafe-task-id", "Issue identity is not safe for a worktree coordinate");
    if (!branchPattern.test(input.branchName) || input.branchName.includes("..") || !branchPattern.test(input.baseBranch)) throw new WorktreeFailure("unsafe-branch", "Source branch name is unsafe");
    const repositoryPath = await canonicalDirectory(input.repositoryPath, "repository-unavailable");
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "worktree-root-unavailable");
    const worktreePath = resolve(worktreeRoot, input.pathSegment ?? input.taskId);
    if (!withinRoot(worktreeRoot, worktreePath)) throw new WorktreeFailure("worktree-escape", "Source worktree escaped the configured root");
    const remoteRef = `refs/remotes/origin/${input.branchName}`;
    const activity = { taskId: input.taskId, stepId: input.stepId ?? input.taskId };
    let previousRemoteHead: string | undefined;
    try { previousRemoteHead = await this.git.run(["rev-parse", "--verify", `${remoteRef}^{commit}`], repositoryPath, activity); } catch {}
    try { await this.git.run(["fetch", "--no-tags", "origin", `+refs/heads/${input.branchName}:${remoteRef}`], repositoryPath, activity); }
    catch {
      const source = await this.git.run(["ls-remote", "--heads", "origin", input.branchName], repositoryPath, activity).catch(() => "");
      if (!source) throw new WorktreeFailure("source-branch-deleted", "The source branch no longer exists on origin");
      throw new WorktreeFailure("source-branch-unavailable", "Could not fetch the source branch from origin");
    }
    const remoteHead = await this.git.run(["rev-parse", "--verify", `${remoteRef}^{commit}`], repositoryPath, activity);
    await this.git.run(["fetch", "--no-tags", "origin", `+refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`], repositoryPath, activity).catch(() => { throw new WorktreeFailure("source-base-unavailable", "The source base branch is unavailable"); });
    const mergeBase = await this.git.run(["merge-base", `refs/remotes/origin/${input.baseBranch}`, remoteRef], repositoryPath, activity);
    let localExists = true;
    try { await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${input.branchName}`], repositoryPath, activity, { expectedExitCodes: [1] }); } catch { localExists = false; }
    const registrations = await this.git.run(["worktree", "list", "--porcelain"], repositoryPath, activity);
    const registered = registrations.split("\n\n").find((entry) => entry.includes(`branch refs/heads/${input.branchName}`));
    const registeredPath = registered?.match(/^worktree (.+)$/m)?.[1];
    if (registeredPath && resolve(registeredPath) !== worktreePath) throw new WorktreeFailure("branch_checked_out", `${input.branchName} is already checked out by ${registeredPath}`);
    let localBehindOrEqual = !localExists;
    let remoteBehindOrEqual = false;
    if (localExists) {
      try { await this.git.run(["merge-base", "--is-ancestor", input.branchName, remoteRef], repositoryPath, activity); localBehindOrEqual = true; } catch {}
      try { await this.git.run(["merge-base", "--is-ancestor", remoteRef, input.branchName], repositoryPath, activity); remoteBehindOrEqual = true; } catch {}
      if (!localBehindOrEqual && !input.preserveLocal) throw new WorktreeFailure("source-branch-diverged", "The local source branch has diverged from origin");
    }
    const rebaseDivergedLocal = input.preserveLocal && !localBehindOrEqual && !remoteBehindOrEqual;
    if (registered) {
      if (registeredPath) {
        try {
          const status = await this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], registeredPath, activity);
          if (status) throw new WorktreeFailure("worktree-dirty", "The source worktree has uncommitted changes");
          if (rebaseDivergedLocal) {
            const candidates = [
              input.sourceHeadSha,
              previousRemoteHead !== remoteHead ? previousRemoteHead : undefined,
              await this.git.run(["rev-parse", "--verify", `${remoteRef}@{1}^{commit}`], repositoryPath, activity).catch(() => undefined),
            ].filter((candidate): candidate is string => candidate !== undefined);
            let rebaseBase: string | undefined;
            for (const candidate of candidates) {
              try {
                await this.git.run(["merge-base", "--is-ancestor", candidate, input.branchName], repositoryPath, activity);
                rebaseBase = candidate;
                break;
              } catch {}
            }
            rebaseBase ??= await this.git.run(["merge-base", input.branchName, `refs/remotes/origin/${input.baseBranch}`], repositoryPath, activity);
            try { await this.git.run(["rebase", "--onto", remoteRef, rebaseBase, input.branchName], registeredPath, activity); }
            catch {
              await this.git.run(["rebase", "--abort"], registeredPath, activity).catch(() => {});
              throw new WorktreeFailure("source-branch-diverged", "The local source branch has diverged from origin");
            }
          } else if (localBehindOrEqual) await this.git.run(["merge", "--ff-only", remoteRef], registeredPath, activity);
          return { branchName: input.branchName, worktreePath: registeredPath, targetBaseSha: mergeBase };
        } catch (error) {
          if (error instanceof WorktreeFailure) throw error;
          if (!input.preserveLocal) throw new WorktreeFailure("worktree-unavailable", "The source worktree is unavailable");
          await this.git.run(["worktree", "prune"], repositoryPath, activity);
        }
      }
    }
    if (localExists && localBehindOrEqual) await this.git.run(["branch", "-f", input.branchName, remoteRef], repositoryPath, activity);
    else if (!localExists) await this.git.run(["branch", "--track", input.branchName, remoteRef], repositoryPath, activity);
    await assertWorktreeDiskHeadroom(worktreeRoot, statfs, this.minFreeDiskGb());
    try { await this.git.run(["worktree", "add", worktreePath, input.branchName], repositoryPath, activity); }
    catch (error) {
      const detail = String(error && typeof error === "object" && "stderr" in error ? error.stderr : error instanceof Error ? error.message : error);
      if (/already checked out|already used by worktree/i.test(detail)) throw new WorktreeFailure("branch_checked_out", `${input.branchName} is already checked out by another worktree`);
      throw new WorktreeFailure("worktree-create-failed", "Git could not create the source worktree");
    }
    const head = await this.git.run(["rev-parse", "HEAD"], worktreePath, activity);
    if (localBehindOrEqual && head !== remoteHead) throw new WorktreeFailure("source-branch-diverged", "The source branch did not adopt the current origin head");
    return { branchName: input.branchName, worktreePath, targetBaseSha: mergeBase };
  }

  async inspectDelivery(worktreePath: string, expectedBranch?: string): Promise<DeliveryGitState> {
    const canonical = await canonicalDirectory(worktreePath, "worktree-unavailable");
    try {
      const [headSha, treeSha, status] = await Promise.all([
        this.git.run(["rev-parse", "HEAD"], canonical),
        this.git.run(["rev-parse", "HEAD^{tree}"], canonical),
        this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], canonical),
      ]);
      let branchName: string;
      try {
        branchName = await this.git.run(["symbolic-ref", "--short", "HEAD"], canonical);
      } catch (error) {
        if (!expectedBranch || !branchPattern.test(expectedBranch)) throw error;
        await this.git.run(["branch", "-f", expectedBranch, "HEAD"], canonical);
        await this.git.run(["symbolic-ref", "HEAD", `refs/heads/${expectedBranch}`], canonical);
        console.warn(`Re-attached detached Developer delivery worktree ${canonical} to branch ${expectedBranch}`);
        branchName = expectedBranch;
      }
      return { branchName, headSha, treeSha, dirtyState: status ? "dirty" : "clean" };
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
      const detail = String(stderr ?? (error instanceof Error ? error.message : error)).trim().split(/\r?\n/, 1)[0];
      throw new WorktreeFailure("delivery-inspection-failed", `Git could not inspect the exact Developer delivery: ${detail}`);
    }
  }

  async inspectSync(worktreePath: string, branchName: string, baseBranch: string, observedConflict?: boolean): Promise<BranchSync> {
    if (!branchPattern.test(branchName) || !branchPattern.test(baseBranch)) throw new WorktreeFailure("unsafe-branch", "Task branch is unsafe");
    const canonical = await canonicalDirectory(worktreePath, "worktree-unavailable");
    const key = `${canonical}\0${branchName}\0${baseBranch}\0${observedConflict ?? ""}`;
    const cached = branchSyncCache.get(key);
    if (cached && cached.at + branchSyncCacheTtlMs > Date.now()) return cached.value;
    if (cached) branchSyncCache.delete(key);
    const existing = branchSyncProbes.get(key);
    if (existing) return existing;
    const probe = this.inspectSyncAt(canonical, branchName, baseBranch, observedConflict);
    branchSyncProbes.set(key, probe);
    try {
      const value = await probe;
      branchSyncCache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      if (branchSyncProbes.get(key) === probe) branchSyncProbes.delete(key);
    }
  }

  private async inspectSyncAt(canonical: string, branchName: string, baseBranch: string, observedConflict?: boolean): Promise<BranchSync> {
    const headSha = await this.git.run(["rev-parse", "HEAD"], canonical);
    const remoteRef = `refs/remotes/origin/${branchName}`;
    const baseRef = `refs/remotes/origin/${baseBranch}`;
    const fetch = async (branch: string, ref: string, force = false): Promise<void> => {
      const key = `${canonical}\0${branch}`;
      if ((branchFetches.get(key) ?? 0) + branchProbeIntervalMs > Date.now()) return;
      await this.git.run(["fetch", "--no-tags", "origin", `${force ? "+" : ""}refs/heads/${branch}:${ref}`], canonical);
      branchFetches.set(key, Date.now());
    };
    await fetch(baseBranch, baseRef).catch(() => {});
    const baseCounts = await this.git.run(["rev-list", "--left-right", "--count", `${baseRef}...${branchName}`], canonical)
      .then((counts) => counts.split(/\s+/).map(Number))
      .catch(() => [0, 0]);
    const [behindBase = 0, aheadOfBase = 0] = baseCounts;
    const conflictsWithBase = observedConflict ?? await (async () => {
      const baseSha = await this.git.run(["rev-parse", "--verify", `${baseRef}^{commit}`], canonical);
      const key = `${canonical}\0${branchName}\0${baseSha}`;
      const probe = branchConflictProbes.get(key);
      if (probe && probe.probedAt + branchProbeIntervalMs > Date.now()) return probe.conflictsWithBase;
      const conflictsWithBase = await this.git.run(["merge-tree", "--write-tree", baseRef, branchName], canonical, undefined, {
        expectNonZero: (result) => result.exitCode === 1,
      }).then(() => false).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === 1) return true;
        throw error;
      });
      branchConflictProbes.set(key, { conflictsWithBase, probedAt: Date.now() });
      return conflictsWithBase;
    })();
    const remoteExists = await this.git.run(["ls-remote", "--exit-code", "--heads", "origin", branchName], canonical, undefined, {
      expectNonZero: (result) => result.exitCode === 2,
    }).then(() => true).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === 2) return false;
      throw error;
    });
    if (!remoteExists) {
      const ahead = await this.git.run(["rev-list", "--count", branchName, "^refs/remotes/origin/HEAD"], canonical).then(Number).catch(() => 0);
      return { remoteExists: false, ahead, behind: 0, aheadOfBase, behindBase, conflictsWithBase, headSha };
    }
    await fetch(branchName, remoteRef, true);
    const [behind = 0, ahead = 0] = (await this.git.run(["rev-list", "--left-right", "--count", `${remoteRef}...${branchName}`], canonical)).split(/\s+/).map(Number);
    return { remoteExists: true, ahead, behind, aheadOfBase, behindBase, conflictsWithBase, headSha };
  }

  async push(worktreePath: string, branchName: string, _legacy?: unknown): Promise<void> {
    if (!branchPattern.test(branchName)) throw new WorktreeFailure("unsafe-branch", "Task branch is unsafe");
    const canonical = await canonicalDirectory(worktreePath, "worktree-unavailable");
    const remoteRef = `refs/heads/${branchName}`;
    const head = await this.git.run(["rev-parse", "HEAD"], canonical);
    if (!shaPattern.test(head)) throw new WorktreeFailure("invalid-result-commit", "The intended push commit is invalid");
    const headSha = head.toLowerCase();
    await this.git.run(["push", "--set-upstream", "origin", `${headSha}:${remoteRef}`], canonical);
    branchFetches.delete(`${canonical}\0${branchName}`);
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

  /** Read a task worktree without repairing or otherwise mutating it. */
  async liveDiff(input: LiveWorktreeDiffInput): Promise<LiveWorktreeDiff> {
    if (!branchPattern.test(input.branchName) || !branchPattern.test(input.baseBranch)) throw new WorktreeFailure("unsafe-branch", "Recorded Git branch is unsafe");
    const [repositoryPath, worktreeRoot] = await Promise.all([
      canonicalDirectory(input.repositoryPath, "repository-unavailable"),
      canonicalDirectory(input.worktreeRoot, "worktree-root-unavailable"),
    ]);
    const expectedWorktree = resolve(input.worktreePath);
    if (!withinRoot(worktreeRoot, expectedWorktree) || expectedWorktree === worktreeRoot) throw new WorktreeFailure("worktree-escape", "Recorded worktree is outside the configured worktree root");
    const worktreePath = await canonicalDirectory(expectedWorktree, "worktree-unavailable");
    try {
      const [repositoryGitDir, worktreeGitDir, actualRoot, actualBranch, headSha] = await Promise.all([
        runLiveGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryPath),
        runLiveGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath),
        runLiveGit(["rev-parse", "--show-toplevel"], worktreePath),
        runLiveGit(["symbolic-ref", "--short", "HEAD"], worktreePath),
        runLiveGit(["rev-parse", "HEAD"], worktreePath),
      ]);
      if (repositoryGitDir.trim() !== worktreeGitDir.trim() || actualRoot.trim() !== worktreePath || actualBranch.trim() !== input.branchName) throw new WorktreeFailure("worktree-not-owned", "Recorded worktree is not the task worktree");

      let baseSha = input.targetBaseSha;
      if (!baseSha || !shaPattern.test(baseSha)) {
        baseSha = (await runLiveGit(["merge-base", "HEAD", input.baseBranch], worktreePath)).trim();
      } else {
        try { baseSha = (await runLiveGit(["rev-parse", "--verify", `${baseSha}^{commit}`], worktreePath)).trim(); }
        catch { baseSha = (await runLiveGit(["merge-base", "HEAD", input.baseBranch], worktreePath)).trim(); }
      }
      if (!shaPattern.test(baseSha)) throw new WorktreeFailure("diff-unavailable", "Git could not resolve the task base revision");

      const [committed, uncommitted, untrackedOutput, indexPath] = await Promise.all([
        runLiveGit(["diff", "--no-color", `${baseSha}...HEAD`, "--"], worktreePath),
        runLiveGit(["diff", "--no-color", "HEAD", "--"], worktreePath),
        runLiveGit(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath),
        runLiveGit(["rev-parse", "--git-path", "index"], worktreePath),
      ]);
      const untracked = untrackedOutput.split("\0").filter(Boolean);
      const patches: string[] = [committed, uncommitted];
      let remaining = liveDiffMaxBytes - Buffer.byteLength(committed) - Buffer.byteLength(uncommitted);
      for (const path of untracked) {
        if (remaining <= 0) break;
        const bytes = await readFile(resolve(worktreePath, path));
        const patch = untrackedPatch(path, bytes);
        if (Buffer.byteLength(patch) > remaining) break;
        patches.push(patch);
        remaining -= Buffer.byteLength(patch);
      }
      const index = await stat(resolve(worktreePath, indexPath.trim()));
      return { patch: patches.join(""), branchName: actualBranch.trim(), baseSha, headSha: headSha.trim(), etag: `${baseSha}:${headSha.trim()}:${index.mtimeMs}:${untracked.length}` };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("diff-unavailable", "Git could not read the live Developer worktree diff");
    }
  }

  async commitDiff(repositoryPath: string, targetBaseSha: string, resultCommit: string): Promise<WorktreeDiff> {
    if (!shaPattern.test(targetBaseSha) || !shaPattern.test(resultCommit)) throw new WorktreeFailure("invalid-result-commit", "Recorded Developer Git coordinates are invalid");
    const repository = await canonicalDirectory(repositoryPath, "repository-unavailable");
    try {
      const [patch, headSha] = await Promise.all([
        runLiveGit(["diff", "--no-color", targetBaseSha, resultCommit, "--"], repository),
        runLiveGit(["rev-parse", "--verify", `${resultCommit}^{commit}`], repository),
      ]);
      return { patch, headSha: headSha.trim() };
    } catch {
      throw new WorktreeFailure("diff-unavailable", "Git could not read the recorded Developer delivery diff");
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
      await assertWorktreeDiskHeadroom(worktreeRoot, statfs, this.minFreeDiskGb());
      try {
        await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath, undefined, { expectedExitCodes: [1] });
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
      let targetBaseSha: string;
      try {
        const mergeBases = (await this.git.run(["merge-base", "--all", input.targetBaseSha, actualHead], canonicalWorktree)).split(/\s+/).filter(Boolean);
        if (mergeBases.length !== 1 || !shaPattern.test(mergeBases[0]!)) throw new Error("no exact merge base");
        targetBaseSha = mergeBases[0]!;
      } catch {
        throw new WorktreeFailure("worktree-base-mismatch", "The preserved task branch and supplied target base do not have one exact merge base");
      }
      await rebuildNativeModulesIfNeeded(canonicalWorktree, input.stepId ? { taskId: input.taskId, stepId: input.stepId } : undefined);
      return { branchName, worktreePath: canonicalWorktree, targetBaseSha };
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
      await assertWorktreeDiskHeadroom(worktreeRoot, statfs, this.minFreeDiskGb());
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
  const existing = database.authQuery((db) => db.prepare("SELECT id AS leaseId, lease_token_hash AS leaseTokenHash, task_id AS taskId, company_id AS companyId, project_id AS projectId, workflow_id AS workflowId, repository_path AS repositoryRoot, worktree_root AS worktreeRoot, worktree_path AS worktreePath, branch_name AS branchName, starting_sha AS startingSha, legacy FROM forge_issue_worktrees WHERE task_id = ? ORDER BY reserved_at DESC LIMIT 1").get(input.taskId) as (Omit<OwnedWorktree, "legacy"> & { legacy: number }) | undefined);
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
    database.authTransaction((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(owned.leaseId, owned.taskId, owned.companyId, owned.projectId, owned.workflowId, owned.repositoryRoot, owned.worktreeRoot, owned.worktreePath, owned.branchName, owned.startingSha, owned.leaseTokenHash, owned.legacy ? 1 : 0, new Date().toISOString()));
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
    const result = db.prepare("UPDATE forge_issue_worktrees SET activated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND project_id = ? AND workflow_id = ? AND worktree_path = ? AND branch_name = ? AND starting_sha = ?").run(new Date().toISOString(), inspection.owned.leaseId, inspection.owned.taskId, inspection.owned.companyId, inspection.owned.projectId, inspection.owned.workflowId, inspection.owned.worktreePath, inspection.owned.branchName, inspection.owned.startingSha);
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

export interface WorktreeBuildCacheInput {
  env: NodeJS.ProcessEnv;
  worktreeRoot: string;
  worktreePath: string;
  projectId: string;
}

/**
 * Give task worktrees a per-project cache without putting build output in a
 * disposable worktree. Callers supply their fully assembled environment, so a
 * project-specific or user-supplied setting always wins.
 */
export async function withWorktreeBuildCaches(input: WorktreeBuildCacheInput): Promise<NodeJS.ProcessEnv> {
  if (!pathSegmentPattern.test(input.projectId)) throw new WorktreeFailure("unsafe-project-id", "Project identity is not safe for a shared build-cache path");
  const worktreeRoot = resolve(input.worktreeRoot);
  const cacheRoot = resolve(worktreeRoot, ".cache", input.projectId);
  if (!withinRoot(worktreeRoot, cacheRoot)) throw new WorktreeFailure("build-cache-escape", "Shared build-cache path escaped the configured worktree root");

  const has = (filename: string): boolean => existsSync(join(input.worktreePath, filename));
  const isCargo = has("Cargo.toml");
  const isNode = has("package.json");
  const isGo = has("go.mod");
  const isPython = has("pyproject.toml") || has("requirements.txt");
  const isCOrCpp = ["CMakeLists.txt", "Makefile", "meson.build", "configure.ac"].some(has);
  const cachePaths: Array<[string, string, boolean]> = [
    ["CARGO_TARGET_DIR", "cargo-target", isCargo],
    ["PNPM_STORE_PATH", "pnpm-store", isNode],
    ["npm_config_cache", "npm-cache", isNode],
    ["GOCACHE", "go-cache", isGo],
    ["PIP_CACHE_DIR", "pip-cache", isPython],
    ["UV_CACHE_DIR", "uv-cache", isPython],
    ["CCACHE_DIR", "ccache", isCOrCpp],
  ];
  const additions: NodeJS.ProcessEnv = {};
  for (const [variable, directory, enabled] of cachePaths) {
    if (!enabled || input.env[variable] !== undefined) continue;
    const path = join(cacheRoot, directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    additions[variable] = path;
  }
  return { ...input.env, ...additions };
}

export async function createGitCommandGuard(runtimeRoot: string, name = "developer-guard"): Promise<GitCommandGuard> {
  const directory = join(resolve(runtimeRoot), name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configuredGitBin = process.env.FORGE_GIT_BIN?.trim();
  const resolvedGitBin = configuredGitBin ? undefined : await runCommand({ taskId: null, stepId: null, command: "which", args: ["git"] });
  const gitBin = configuredGitBin || (resolvedGitBin?.exitCode === 0 ? resolvedGitBin.stdout.trim() : "");
  if (!gitBin) throw new WorktreeFailure("git-unavailable", "Git is unavailable for the guarded build");
  const gitGuard = `#!/bin/sh
command=
for arg in "$@"; do
  case "$arg" in
    push|rebase|clean|reset|merge|cherry-pick|revert|worktree|update-ref|filter-repo|gc|prune) echo "Forge Developer policy blocked git $arg" >&2; exit 125 ;;
    --detach|--orphan) echo "Forge Developer policy blocked git detach" >&2; exit 125 ;;
    --amend|-D|-d|--force|-f) echo "Forge Developer policy blocked destructive git option $arg" >&2; exit 125 ;;
  esac
  case "$arg" in -*) continue ;; esac
  if [ -z "$command" ]; then
    case "$arg" in checkout|switch) command="$arg" ;; esac
  elif [ "$command" = checkout ] || [ "$command" = switch ]; then
    case "$arg" in *[!0-9a-f]*|'') ;; *) if [ "\${#arg}" -ge 7 ] && [ "\${#arg}" -le 40 ]; then echo "Forge Developer policy blocked git detach" >&2; exit 125; fi ;; esac
  fi
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
