import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { runCommand } from "../src/command-runner.js";
import { createGitCommandGuard } from "../src/worker-environment.js";

test("the Git integration environment creates worktrees while a new Worker guard stays active", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-git-environment-proof-"));
  try {
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    await mkdir(repository);
    const git = (args: string[], cwd = repository) => runCommand({ command: "git", args, cwd, taskId: null, stepId: null });
    expect(await git(["init", "-b", "main"])).toMatchObject({ exitCode: 0 });
    expect(await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "seed"])).toMatchObject({ exitCode: 0 });
    expect(await git(["worktree", "add", "-b", "task/proof", worktree])).toMatchObject({ exitCode: 0 });

    const guard = await createGitCommandGuard(root);
    try {
      const guardedGit = (args: string[]) => runCommand({ command: join(guard.directory, "git"), args, cwd: repository, env: guard.env, taskId: null, stepId: null });
      expect(await guardedGit(["status", "--short"])).toMatchObject({ exitCode: 0 });
      expect(await guardedGit(["worktree", "list"])).toMatchObject({ exitCode: 125, stderr: expect.stringContaining("blocked git worktree") });
    } finally {
      await guard.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
