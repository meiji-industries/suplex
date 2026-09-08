import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "../src/platform/command-runner.js";
import { createGitCommandGuard } from "../src/coordination/worker-environment.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ command: "git", args, cwd, taskId: null, stepId: null });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

test("Worker guards permit local repairs and CI reads without provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-worker-guard-"));
  try {
    const guard = await createGitCommandGuard(directory);
    const run = (name: string, args: string[]) => runCommand({ command: join(guard.directory, name), args, taskId: null, stepId: null, env: { ...guard.env, FORGE_GIT_REAL_BIN: "/bin/echo", FORGE_GH_REAL_BIN: "/bin/echo" } });
    for (const args of [["add", "reset"], ["commit", "-m", "merge"], ["merge", "origin/main"], ["-C", "push", "status"]]) {
      expect((await run("git", args)).stdout.trim()).toBe(args.join(" "));
    }
    for (const args of [["push"], ["-C", "repo", "push"], ["reset", "--hard"], ["commit", "--amend"], ["switch", "main"]]) {
      expect((await run("git", args)).exitCode).toBe(125);
    }
    expect((await run("gh", ["run", "view", "123", "--log-failed"])).stdout.trim()).toBe("run view 123 --log-failed");
    expect((await run("gh", ["pr", "merge", "7"])).exitCode).toBe(125);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Worker guard refreshes atomically replace complete executables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-worker-guard-refresh-"));
  try {
    const first = await createGitCommandGuard(directory);
    const executable = join(first.directory, "git");
    const before = await stat(executable);
    const refreshed = await createGitCommandGuard(directory);
    const after = await stat(executable);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o700).toBe(0o700);
    await expect(runCommand({
      command: executable,
      args: ["--version"],
      taskId: null,
      stepId: null,
      env: refreshed.env,
    })).resolves.toMatchObject({ exitCode: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Worker guards permit task rebases while every push form stays blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-worker-rebase-"));
  const remote = join(directory, "origin.git");
  const publisher = join(directory, "publisher");
  const task = join(directory, "task");
  try {
    mkdirSync(publisher);
    mkdirSync(task);
    await git(directory, "init", "--bare", remote);
    await git(directory, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await git(publisher, "init", "-b", "main");
    await git(publisher, "config", "user.name", "Forge Publisher");
    await git(publisher, "config", "user.email", "publisher@example.invalid");
    writeFileSync(join(publisher, "shared.txt"), "base\n");
    await git(publisher, "add", ".");
    await git(publisher, "commit", "-m", "base");
    await git(publisher, "remote", "add", "origin", remote);
    await git(publisher, "push", "-u", "origin", "main");
    await git(directory, "clone", remote, task);
    await git(task, "config", "user.name", "Forge Worker");
    await git(task, "config", "user.email", "worker@example.invalid");
    await git(task, "switch", "-c", "task");
    writeFileSync(join(task, "task.txt"), "task change\n");
    await git(task, "add", ".");
    await git(task, "commit", "-m", "task change");
    writeFileSync(join(publisher, "main.txt"), "published change\n");
    await git(publisher, "add", ".");
    await git(publisher, "commit", "-m", "published change");
    await git(publisher, "push", "origin", "main");

    const guard = await createGitCommandGuard(directory);
    const guardedGit = (args: string[], expectedExitCodes?: readonly number[]) => runCommand({
      command: join(guard.directory, "git"),
      args,
      cwd: task,
      env: guard.env,
      taskId: null,
      stepId: null,
      ...(expectedExitCodes ? { expectedExitCodes } : {}),
    });
    try {
      expect((await guardedGit(["fetch", "origin", "main"])).exitCode).toBe(0);
      expect((await guardedGit(["rebase", "origin/main"])).exitCode).toBe(0);
      expect(await git(task, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
      expect(await git(task, "show", "HEAD:task.txt")).toBe("task change");
      expect(await git(task, "show", "HEAD:main.txt")).toBe("published change");

      writeFileSync(join(task, "shared.txt"), "task conflict\n");
      await git(task, "add", ".");
      await git(task, "commit", "-m", "task conflict");
      const taskHead = await git(task, "rev-parse", "HEAD");
      writeFileSync(join(publisher, "shared.txt"), "published conflict\n");
      await git(publisher, "add", ".");
      await git(publisher, "commit", "-m", "published conflict");
      await git(publisher, "push", "origin", "main");
      const publishedHead = await git(publisher, "rev-parse", "HEAD");
      expect((await guardedGit(["fetch", "origin", "main"])).exitCode).toBe(0);
      expect((await guardedGit(["rebase", "origin/main"], [1])).exitCode).toBe(1);
      expect((await guardedGit(["rebase", "--abort"])).exitCode).toBe(0);
      expect(await git(task, "rev-parse", "HEAD")).toBe(taskHead);

      for (const args of [
        ["push", "origin", "HEAD:main"],
        ["push", "--force", "origin", "HEAD:main"],
        ["push", "-f", "origin", "HEAD:main"],
        ["push", "--force-with-lease", "origin", "HEAD:main"],
        ["push", "origin", "+HEAD:main"],
      ]) expect((await guardedGit(args, [125])).exitCode).toBe(125);
      expect(await git(directory, "--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(publishedHead);
    } finally {
      await guard.cleanup();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
