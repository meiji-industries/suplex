import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { createGitCommandGuard } from "../src/worker-environment.js";

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
