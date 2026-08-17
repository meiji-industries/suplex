import { expect, test } from "vitest";

import { commandArgv, runPinnedVerification } from "../src/verification.js";

test("maps only accepted literal setup and verification commands", () => {
  expect(commandArgv("pnpm install --frozen-lockfile")).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  expect(commandArgv("mise run test")).toEqual(["mise", "run", "test"]);
  expect(commandArgv("pnpm test && git push")).toBeUndefined();
  expect(commandArgv("pnpm test -- malicious")).toBeUndefined();
});

test("runs setup before verification and returns bounded redacted evidence", async () => {
  const calls: string[] = [];
  const result = await runPinnedVerification({
    worktreePath: "/worktrees/task-1",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
  }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (command, args, options) => {
      expect(options.env.MISE_TRUSTED_CONFIG_PATHS).toContain("/worktrees/task-1");
      expect(options.maxBuffer).toBe(4 * 1024 * 1024);
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: `Bearer gho_secret ${"x".repeat(70_000)}`, stderr: "" };
    },
    now: (() => {
      let value = 0;
      return () => new Date(++value).toISOString();
    })(),
  });
  expect(calls).toEqual(["pnpm install", "pnpm test"]);
  expect(result.outcome).toBe("passed");
  expect(JSON.stringify(result)).not.toContain("gho_secret");
  expect(JSON.stringify(result)).not.toContain("x".repeat(70_000));
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(256 * 1024);
});

test("trusts a worktree before running mise tasks", async () => {
  const calls: string[] = [];
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "mise run setup", verificationCommand: "mise run test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: "", stderr: "" };
    },
  });

  expect(calls).toEqual(["mise trust", "mise run setup", "mise run test"]);
  expect(result.outcome).toBe("passed");
});

test("returns a typed failure without running verification after setup failure", async () => {
  const calls: string[] = [];
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (command) => {
      calls.push(command);
      throw Object.assign(new Error("setup failed"), { code: 1, stdout: "building\nerror: setup failed" });
    },
  });
  expect(calls).toEqual(["pnpm"]);
  expect(result).toMatchObject({ outcome: "failed", code: "verification_failed", summary: "pnpm install did not complete successfully: error: setup failed" });
});

test("preserves a successful verification with bounded command output", async () => {
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async () => ({ stdout: "😀".repeat(100_000), stderr: "stderr" }),
  });
  expect(result).toMatchObject({ outcome: "passed" });
  for (const command of result.commands) expect(Buffer.byteLength(command.stdout, "utf8")).toBeLessThanOrEqual(8 * 1024);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(256 * 1024);
});
