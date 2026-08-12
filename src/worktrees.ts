import { execFile, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

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
}

export interface WorktreeDiff {
  patch: string;
  headSha: string;
}

interface GitAdapter {
  run(args: string[], cwd: string): Promise<string>;
}

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const shaPattern = /^[a-f0-9]{40,64}$/i;
const branchPattern = /^(?![./])(?!.*(?:\.\.|\.lock$|\/\/|\s|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/;

function withinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

const defaultGit: GitAdapter = {
  async run(args, cwd) {
    const result = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  },
};

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

  async metadataDirectories(repositoryPath: string, worktreePath: string): Promise<string[]> {
    const repository = await canonicalDirectory(repositoryPath, "repository-unavailable");
    const repositoryGit = await canonicalDirectory(join(repository, ".git"), "git-metadata-unavailable");
    const worktree = await canonicalDirectory(worktreePath, "worktree-unavailable");
    try {
      const [rawGitDirectory, rawCommonDirectory] = await Promise.all([
        this.git.run(["rev-parse", "--absolute-git-dir"], worktree),
        this.git.run(["rev-parse", "--git-common-dir"], worktree),
      ]);
      const directories = await Promise.all([rawGitDirectory, rawCommonDirectory].map((path) => realpath(resolve(worktree, path))));
      if (directories.some((path) => !withinRoot(repositoryGit, path))) throw new WorktreeFailure("git-metadata-mismatch", "Issue worktree Git metadata escaped the recorded target repository");
      return [...new Set(directories)];
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("git-metadata-unavailable", "Git metadata for the isolated issue worktree is unavailable");
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
    const worktreePath = resolve(worktreeRoot, input.taskId);
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
    if (resolve(input.worktreePath) !== record.worktreePath) throw new WorktreeFailure("worktree-reuse-mismatch", "Recorded Developer worktree did not match the task worktree coordinate");
    try {
      const [patch, headSha] = await Promise.all([
        this.git.run(["diff", "--no-ext-diff", "--find-renames", input.targetBaseSha, "--"], record.worktreePath),
        this.git.run(["rev-parse", "HEAD"], record.worktreePath),
      ]);
      return { patch, headSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("diff-unavailable", "Git could not read the current Developer delivery diff");
    }
  }

  async reuse(input: WorktreeInput): Promise<WorktreeRecord> {
    if (!taskIdPattern.test(input.taskId) || !shaPattern.test(input.targetBaseSha)) throw new WorktreeFailure("invalid-reuse-coordinate", "Preserved worktree coordinates are invalid");
    await canonicalDirectory(input.repositoryPath, "repository-unavailable");
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "worktree-root-unavailable");
    const branchName = input.branchName ?? `forge/issue/${input.taskId}`;
    const worktreePath = resolve(worktreeRoot, input.taskId);
    if (!withinRoot(worktreeRoot, worktreePath)) throw new WorktreeFailure("worktree-escape", "Preserved worktree escaped the configured root");
    const canonicalWorktree = await canonicalDirectory(worktreePath, "worktree-unavailable");
    try {
      const [actualRoot, actualBranch, baseCommit] = await Promise.all([
        this.git.run(["rev-parse", "--show-toplevel"], canonicalWorktree),
        this.git.run(["symbolic-ref", "--short", "HEAD"], canonicalWorktree),
        this.git.run(["merge-base", "--is-ancestor", input.targetBaseSha, "HEAD"], canonicalWorktree).then(() => "ancestor").catch(() => "not-ancestor"),
      ]);
      if (actualRoot !== canonicalWorktree || actualBranch !== branchName || baseCommit !== "ancestor") throw new WorktreeFailure("worktree-reuse-mismatch", "Preserved worktree ownership or target base could not be proven");
      return { branchName, worktreePath: canonicalWorktree, targetBaseSha: input.targetBaseSha };
    } catch (error) {
      if (error instanceof WorktreeFailure) throw error;
      throw new WorktreeFailure("worktree-reuse-mismatch", "Preserved worktree ownership or target base could not be proven");
    }
  }
}

export interface GitCommandGuard {
  directory: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
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
  await chmod(join(directory, "git"), 0o700);
  await chmod(join(directory, "gh"), 0o700);
  return {
    directory,
    env: { ...process.env, PATH: `${directory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`, FORGE_GIT_REAL_BIN: gitBin },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}
