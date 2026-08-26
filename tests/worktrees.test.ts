import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { asNonRetryableApplicationFailure } from "../src/temporal/activities/context.js";
import { createGitCommandGuard, reserveOwnedWorktree, withWorktreeBuildCaches, WorktreeFailure, WorktreeManager } from "../src/worktrees.js";

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
  await git(["config", "commit.gpgsign", "false"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "fixture"], repositoryPath);
  return { root, repositoryPath, worktreeRoot, baseSha: await git(["rev-parse", "HEAD"], repositoryPath) };
}

test("assigns Cargo task worktrees a mode-0700 shared per-project target directory", async () => {
  const value = await fixture();
  const worktreePath = join(value.worktreeRoot, "cargo-task");
  try {
    await mkdir(worktreePath);
    await writeFile(join(worktreePath, "Cargo.toml"), "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
    const env = await withWorktreeBuildCaches({ env: {}, worktreeRoot: value.worktreeRoot, worktreePath, projectId: "project_1" });
    const target = join(value.worktreeRoot, ".cache", "project_1", "cargo-target");
    expect(env.CARGO_TARGET_DIR).toBe(target);
    expect(await stat(target).then((entry) => entry.mode & 0o777)).toBe(0o700);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("does not assign Cargo caches to non-Cargo worktrees and preserves configured values", async () => {
  const value = await fixture();
  const worktreePath = join(value.worktreeRoot, "node-task");
  try {
    await mkdir(worktreePath);
    await writeFile(join(worktreePath, "package.json"), "{}\n");
    const env = await withWorktreeBuildCaches({ env: { PNPM_STORE_PATH: "/configured/pnpm" }, worktreeRoot: value.worktreeRoot, worktreePath, projectId: "project_1" });
    expect(env.CARGO_TARGET_DIR).toBeUndefined();
    expect(env.PNPM_STORE_PATH).toBe("/configured/pnpm");
    expect(env.npm_config_cache).toBe(join(value.worktreeRoot, ".cache", "project_1", "npm-cache"));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("synchronizes a clean base checkout and skips dirty or other-branch checkouts", async () => {
  const value = await fixture();
  const sha = "a".repeat(40);
  const calls: string[][] = [];
  let status = "";
  let branch = "main";
  const manager = new WorktreeManager({
    async run(args) {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "symbolic-ref") return branch;
      if (args[0] === "rev-parse") return sha;
      return "";
    },
  });
  try {
    await expect(manager.syncBase(value.repositoryPath, "main")).resolves.toEqual({ synced: true, headSha: sha });
    expect(calls).toContainEqual(["merge", "--ff-only", "refs/remotes/origin/main"]);

    calls.length = 0;
    status = " M README.md";
    await expect(manager.syncBase(value.repositoryPath, "main")).resolves.toEqual({ synced: false, reason: "dirty", headSha: sha });
    expect(calls.some((args) => args[0] === "merge")).toBe(false);

    calls.length = 0;
    status = "";
    branch = "feature/elsewhere";
    await expect(manager.syncBase(value.repositoryPath, "main")).resolves.toEqual({ synced: false, reason: "other-branch", headSha: sha });
    expect(calls.some((args) => args[0] === "merge")).toBe(false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

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

test("the Developer guard blocks every prohibited mutation family", async () => {
  const value = await fixture();
  const guard = await createGitCommandGuard(join(value.root, "runtime"));
  try {
    for (const args of [
      ["push"], ["rebase", "HEAD~1"], ["clean", "-fd"], ["reset", "--hard", "HEAD"], ["merge", "main"],
      ["cherry-pick", "HEAD"], ["revert", "HEAD"], ["worktree", "remove", "other"], ["update-ref", "refs/heads/main", "HEAD"],
      ["filter-repo"], ["gc"], ["prune"], ["branch", "-D", "old"], ["branch", "-d", "old"], ["commit", "--amend", "--no-edit"],
    ]) {
      await expect(execFileAsync("git", args, { cwd: value.repositoryPath, env: guard.env })).rejects.toThrow();
    }
    await expect(execFileAsync("gh", ["pr", "create"], { cwd: value.repositoryPath, env: guard.env })).rejects.toThrow();
  } finally {
    await guard.cleanup();
    await rm(value.root, { recursive: true, force: true });
  }
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

test("inspects preserved revision coordinates and validates exact bases without mutation", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    const record = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_revision", targetBaseSha: value.baseSha });
    await expect(manager.inspectForPlanRevision({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, worktreePath: record.worktreePath, branchName: record.branchName, baseSha: value.baseSha, resultCommit: value.baseSha })).resolves.toMatchObject({ branchName: record.branchName, baseSha: value.baseSha, headSha: value.baseSha, dirtyState: "clean" });
    await writeFile(join(record.worktreePath, "tracked.txt"), "dirty\n");
    await expect(manager.inspectForPlanRevision({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, worktreePath: record.worktreePath, branchName: record.branchName, baseSha: value.baseSha, resultCommit: value.baseSha })).rejects.toMatchObject({ code: "worktree-dirty" });
    await rm(join(record.worktreePath, "tracked.txt"));
    await expect(manager.validateExactBase({ repositoryPath: value.repositoryPath, candidateSha: value.baseSha, acceptedTargetSha: value.baseSha })).resolves.toBe(value.baseSha);
    await expect(manager.validateExactBase({ repositoryPath: value.repositoryPath, candidateSha: "0".repeat(40), acceptedTargetSha: value.baseSha })).rejects.toMatchObject({ code: "base-commit-mismatch" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects an invalid target-base commit before creating a branch", async () => {
  const value = await fixture();
  try {
    await expect(new WorktreeManager().create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_invalid", targetBaseSha: "0".repeat(40) })).rejects.toMatchObject({ code: "base-commit-mismatch" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("reuses the task worktree when the configured base has moved", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    const record = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_moved_base", targetBaseSha: value.baseSha });
    await writeFile(join(value.repositoryPath, "BASE_MOVED.md"), "new base\n");
    await git(["add", "BASE_MOVED.md"], value.repositoryPath);
    await git(["commit", "-m", "advance base"], value.repositoryPath);
    const movedBaseSha = await git(["rev-parse", "HEAD"], value.repositoryPath);

    await expect(manager.reuse({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_moved_base", targetBaseSha: movedBaseSha, branchName: record.branchName })).resolves.toMatchObject({
      branchName: record.branchName,
      worktreePath: record.worktreePath,
      targetBaseSha: value.baseSha,
    });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("reads the current delivery diff from the recorded base through committed and tracked worktree changes", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    const record = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_diff", targetBaseSha: value.baseSha });
    await writeFile(join(record.worktreePath, "DELIVERED.md"), "committed delivery\n");
    await git(["add", "DELIVERED.md"], record.worktreePath);
    await git(["commit", "-m", "deliver fixture"], record.worktreePath);
    const resultCommit = await git(["rev-parse", "HEAD"], record.worktreePath);
    await writeFile(join(record.worktreePath, "README.md"), "tracked current change\n");

    const current = await manager.currentDiff({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_diff", targetBaseSha: value.baseSha, branchName: record.branchName, worktreePath: record.worktreePath });
    expect(current.headSha).toBe(await git(["rev-parse", "HEAD"], record.worktreePath));
    expect(current.patch).toContain("diff --git a/DELIVERED.md b/DELIVERED.md");
    expect(current.patch).toContain("+committed delivery");
    expect(current.patch).toContain("+tracked current change");
    const delivered = await manager.currentDiff({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_diff", targetBaseSha: value.baseSha, branchName: record.branchName, worktreePath: record.worktreePath, resultCommit });
    expect(delivered.headSha).toBe(resultCommit);
    expect(delivered.patch).toContain("+committed delivery");
    expect(delivered.patch).not.toContain("+tracked current change");
    await expect(manager.currentDiff({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_diff", targetBaseSha: value.baseSha, branchName: record.branchName, worktreePath: value.repositoryPath })).resolves.toMatchObject({
      headSha: await git(["rev-parse", "HEAD"], record.worktreePath),
    });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("inspects the exact owned worktree registry tuple before activation", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    const record = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_registry", targetBaseSha: value.baseSha, branchName: "work/issue/task_registry" });
    const inspection = await manager.inspectOwned({ leaseId: "lease_registry", leaseTokenHash: "a".repeat(64), taskId: "task_registry", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", repositoryRoot: value.repositoryPath, worktreeRoot: value.worktreeRoot, worktreePath: record.worktreePath, branchName: record.branchName, startingSha: value.baseSha, legacy: false, status: "reserved" });
    expect(inspection).toMatchObject({ repositoryRegistered: true, head: value.baseSha, branch: record.branchName, dirtyState: "clean" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("reconnects an active owned worktree after its branch advances", async () => {
  const value = await fixture();
  try {
    const manager = new WorktreeManager();
    const record = await manager.create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_active", targetBaseSha: value.baseSha, branchName: "work/issue/task_active" });
    await writeFile(join(record.worktreePath, "DELIVERED.md"), "delivered\n");
    await git(["add", "DELIVERED.md"], record.worktreePath);
    await git(["commit", "-m", "deliver fixture"], record.worktreePath);

    await expect(manager.materialize({ leaseId: "lease_active", leaseTokenHash: "a".repeat(64), taskId: "task_active", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", repositoryRoot: value.repositoryPath, worktreeRoot: value.worktreeRoot, worktreePath: record.worktreePath, branchName: record.branchName, startingSha: value.baseSha, legacy: false, status: "active" })).resolves.toMatchObject({ repositoryRegistered: true, branch: record.branchName, dirtyState: "clean" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("an active lease adopts its existing worktree when configuration coordinates change", async () => {
  const value = await fixture();
  try {
    const record = await new WorktreeManager().create({ repositoryPath: value.repositoryPath, worktreeRoot: value.worktreeRoot, taskId: "task_lease", targetBaseSha: value.baseSha, branchName: "work/issue/task_lease" });
    const existing = {
      leaseId: "lease_active",
      leaseTokenHash: "a".repeat(64),
      taskId: "task_lease",
      companyId: "company_1",
      projectId: "project_1",
      workflowId: "workflow_1",
      repositoryRoot: value.repositoryPath,
      worktreeRoot: value.worktreeRoot,
      worktreePath: record.worktreePath,
      branchName: record.branchName,
      startingSha: value.baseSha,
      legacy: 0,
      status: "active" as const,
    };
    const updates: unknown[][] = [];
    const database = {
      authQuery<T>(operation: (db: { prepare: (_sql: string) => { get: (_taskId: string) => typeof existing } }) => T): T {
        return operation({ prepare: () => ({ get: () => existing }) });
      },
      authTransaction<T>(operation: (db: { prepare: (_sql: string) => { run: (...values: unknown[]) => void } }) => T): T {
        return operation({ prepare: () => ({ run: (...values) => { updates.push(values); } }) });
      },
    };

    const owned = reserveOwnedWorktree(database as never, {
      taskId: existing.taskId,
      companyId: existing.companyId,
      projectId: existing.projectId,
      workflowId: existing.workflowId,
      repositoryRoot: join(value.root, "new-repository-root"),
      worktreeRoot: join(value.root, "new-worktree-root"),
      worktreePath: join(value.root, "new-worktree-root", "task_lease"),
      branchName: "work/issue/changed-name",
      startingSha: "b".repeat(40),
    });

    expect(owned).toMatchObject({ worktreePath: record.worktreePath, branchName: record.branchName, repositoryRoot: join(value.root, "new-repository-root"), worktreeRoot: join(value.root, "new-worktree-root"), startingSha: "b".repeat(40) });
    expect(updates).toEqual([[join(value.root, "new-repository-root"), join(value.root, "new-worktree-root"), "b".repeat(40), existing.leaseId]]);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("maps every worktree failure code to a non-retryable Temporal failure", () => {
  expect(asNonRetryableApplicationFailure(new WorktreeFailure("any-worktree-condition", "Restore the worktree path, then retry."))).toMatchObject({
    type: "any-worktree-condition",
    nonRetryable: true,
    message: "Restore the worktree path, then retry.",
    details: [{ code: "any-worktree-condition", summary: "Restore the worktree path, then retry." }],
  });
});
