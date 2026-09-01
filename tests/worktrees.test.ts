import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { WorktreeManager } from "../src/worktrees.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("creates and inspects a worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worktrees-"));
  const repositoryPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    await git(repositoryPath, ["init", "-b", "main"]);
    await git(repositoryPath, ["config", "user.email", "test@example.invalid"]);
    await git(repositoryPath, ["config", "user.name", "Forge Test"]);
    await writeFile(join(repositoryPath, "README.md"), "fixture\n");
    await git(repositoryPath, ["add", "README.md"]);
    await git(repositoryPath, ["commit", "-m", "fixture"]);
    const baseSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
    const worktree = await new WorktreeManager().create({ repositoryPath, worktreeRoot, taskId: "task", targetBaseSha: baseSha, branchName: "forge/task" });
    await expect(stat(worktree.worktreePath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
