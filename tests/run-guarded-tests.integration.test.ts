import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { runCommand } from "../src/command-runner.js";
import { createGitCommandGuard } from "../src/worker-environment.js";

test("the guarded test runner reuses an inherited Worker guard without removing it", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-guarded-test-runner-"));
  try {
    const guard = await createGitCommandGuard(root);
    try {
      const result = await runCommand({
        command: "pnpm",
        args: ["tsx", "scripts/run-guarded-tests.ts", "tests/worker-environment.test.ts"],
        cwd: process.cwd(),
        env: guard.env,
        taskId: null,
        stepId: null,
        timeout: 25_000,
      });

      expect(result.exitCode).toBe(0);
      await expect(access(guard.directory)).resolves.toBeUndefined();
      const denied = await runCommand({
        command: join(guard.directory, "git"),
        args: ["worktree", "list"],
        env: guard.env,
        taskId: null,
        stepId: null,
        expectedExitCodes: [125],
      });
      expect(denied.exitCode).toBe(125);
    } finally {
      await guard.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
