import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { prepareTaskWorktree } from "../src/task-worktree.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const git = async (cwd: string, args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", args, cwd })).stdout.trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-task-worktree-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);
  await git(repositoryPath, ["init", "-b", "main"]);
  await git(repositoryPath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "seed"]);
  const startingSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  return { taskId: "task_proof", repositoryPath, worktreeRoot: join(root, "worktrees"), branch: "task/proof", startingSha };
}

test("Git materialization reuses out-of-band commits and dirty files without a database gate", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await writeFile(join(initial.path, "committed.txt"), "out-of-band commit");
  await git(initial.path, ["add", "committed.txt"]);
  await git(initial.path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "external change"]);
  await writeFile(join(initial.path, "dirty.txt"), "preserve me");
  const resumed = await prepareTaskWorktree(intent);
  expect(resumed).toMatchObject({ path: initial.path, branch: intent.branch, dirty: true });
  expect(resumed.headSha).not.toBe(initial.headSha);
  expect(await readFile(join(resumed.path, "dirty.txt"), "utf8")).toBe("preserve me");
});

test("a missing worktree reattaches the existing branch without discarding its commits", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await git(initial.path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "external commit"]);
  const head = await git(initial.path, ["rev-parse", "HEAD"]);
  await rm(initial.path, { recursive: true });
  expect(await prepareTaskWorktree(intent)).toMatchObject({ path: initial.path, headSha: head, dirty: false });
});

test("a conflicting branch or symlink is never silently adopted", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await git(initial.path, ["switch", "-c", "somebody-else"]);
  await expect(prepareTaskWorktree(intent)).rejects.toThrow("conflicting owner");
  expect(await git(initial.path, ["branch", "--show-current"])).toBe("somebody-else");
  await git(intent.repositoryPath, ["worktree", "remove", initial.path]);
  await symlink(intent.repositoryPath, initial.path);
  await expect(prepareTaskWorktree(intent)).rejects.toThrow("conflicting owner");
});

test("a task branch already in another worktree is not checked out twice", async () => {
  const intent = await fixture();
  await prepareTaskWorktree(intent);
  await expect(prepareTaskWorktree({ ...intent, taskId: "another_task" })).rejects.toThrow("another worktree");
});

test("concurrent materialization converges on the same Git worktree", async () => {
  const intent = await fixture();
  const [first, second] = await Promise.all([prepareTaskWorktree(intent), prepareTaskWorktree(intent)]);
  expect(first).toEqual(second);
});

test("worktree roots cannot overlap the repository", async () => {
  const intent = await fixture();
  await expect(prepareTaskWorktree({ ...intent, worktreeRoot: join(intent.repositoryPath, "worktrees") })).rejects.toThrow("overlap");
});
