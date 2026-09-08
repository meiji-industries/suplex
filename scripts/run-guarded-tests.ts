import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { runCommand } from "../src/platform/command-runner.js";
import { createGitCommandGuard, type GitCommandGuard } from "../src/coordination/worker-environment.js";

async function testGuard(guard: Pick<GitCommandGuard, "directory" | "env">, phase: "before" | "after"): Promise<void> {
  const git = join(guard.directory, "git");
  const allowed = await runCommand({ command: git, args: ["--version"], env: guard.env, taskId: null, stepId: null });
  if (allowed.exitCode !== 0) throw new Error(`The Worker Git guard did not allow git --version ${phase} the test process`);

  const denied = await runCommand({ command: git, args: ["worktree", "list"], env: guard.env, taskId: null, stepId: null, expectedExitCodes: [125] });
  if (denied.exitCode !== 125) throw new Error(`The Worker Git guard did not deny git worktree ${phase} the test process`);
}

async function testGuardContext(): Promise<GitCommandGuard> {
  const inheritedDirectory = process.env.FORGE_GIT_GUARD_DIR?.trim();
  if (inheritedDirectory) {
    return { directory: inheritedDirectory, env: process.env, async cleanup() {} };
  }

  const root = await mkdtemp(join(tmpdir(), "forge-guarded-tests-"));
  try {
    const guard = await createGitCommandGuard(root);
    return {
      ...guard,
      async cleanup() {
        await guard.cleanup();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function testEnvironment(guard: Pick<GitCommandGuard, "directory" | "env">): NodeJS.ProcessEnv {
  const env = { ...guard.env };
  const realGit = env.FORGE_GIT_REAL_BIN;
  if (realGit) env.FORGE_GIT_BIN = realGit;
  else delete env.FORGE_GIT_BIN;
  delete env.FORGE_GIT_GUARD_DIR;
  env.PATH = (env.PATH ?? "").split(delimiter).filter((entry) => entry && resolve(entry) !== resolve(guard.directory)).join(delimiter);
  return env;
}

const guard = await testGuardContext();
try {
  await testGuard(guard, "before");
  let exitCode: number;
  try {
    const child = spawn("pnpm", ["test", ...process.argv.slice(2)], { cwd: process.cwd(), env: testEnvironment(guard), stdio: "inherit" });
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? 1));
    });
  } finally {
    await testGuard(guard, "after");
  }
  process.exitCode = exitCode;
} finally {
  await guard.cleanup();
}
