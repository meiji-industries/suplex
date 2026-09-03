import { dirname } from "node:path";

import { expect, test } from "vitest";

import { commandArgv, runPinnedVerification } from "../src/verification.js";

const runtimeNodeBinEnvironmentVariable = "FORGE_PINNED_VERIFICATION_RUNTIME_NODE_BIN";
const runtimeNodePathPrelude = `export PATH="$${runtimeNodeBinEnvironmentVariable}:$PATH"; `;
const pinnedShellInvocation = (command: string): [string, string, string] => ["sh", "-lc", `${runtimeNodePathPrelude}${command}`];

test("runs project-owned single-line setup and verification commands", () => {
  expect(commandArgv("pnpm install --frozen-lockfile")).toEqual(["sh", "-lc", "pnpm install --frozen-lockfile"]);
  expect(commandArgv("mise run test")).toEqual(["sh", "-lc", "mise run test"]);
  expect(commandArgv("make test-local && pnpm typecheck")).toEqual(["sh", "-lc", "make test-local && pnpm typecheck"]);
  expect(commandArgv("printf '%s' 'arbitrary project command' | sed 's/project/repo/'")).toEqual([
    "sh",
    "-lc",
    "printf '%s' 'arbitrary project command' | sed 's/project/repo/'",
  ]);
  expect(commandArgv("pnpm test\ngit push")).toBeUndefined();
});

test("runs setup before verification and returns bounded redacted evidence", async () => {
  const calls: string[] = [];
  const result = await runPinnedVerification({
    worktreePath: "/worktrees/task-1",
    setupCommand: "pnpm install",
    verificationCommand: "pnpm test",
  }, {
    guard: {
      directory: "/tmp/forge-test-guard",
      env: { ...process.env, [runtimeNodeBinEnvironmentVariable]: "/inherited/wrong-node-bin" },
      cleanup: async () => {},
    },
    execute: async (command, args, options) => {
      expect(options.env.MISE_TRUSTED_CONFIG_PATHS).toContain("/worktrees/task-1");
      expect(options.env[runtimeNodeBinEnvironmentVariable]).toBe(dirname(process.execPath));
      expect(options.env.NO_COLOR).toBe("1");
      expect(options.env.FORCE_COLOR).toBe("0");
      expect(options.env.CI).toBe("1");
      expect(options.maxBuffer).toBe(4 * 1024 * 1024);
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: `Bearer gho_secret ${"x".repeat(70_000)}`, stderr: "" };
    },
    now: (() => {
      let value = 0;
      return () => new Date(++value).toISOString();
    })(),
  });
  expect(calls).toEqual([
    pinnedShellInvocation("pnpm install").join(" "),
    pinnedShellInvocation("pnpm test").join(" "),
  ]);
  expect(result.outcome).toBe("passed");
  expect(JSON.stringify(result)).not.toContain("gho_secret");
  expect(JSON.stringify(result)).not.toContain("x".repeat(70_000));
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(256 * 1024);
});

test("runs mise tasks as configured", async () => {
  const calls: string[] = [];
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "mise run setup", verificationCommand: "mise run test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: "", stderr: "" };
    },
  });

  expect(calls).toEqual([
    pinnedShellInvocation("mise run setup").join(" "),
    pinnedShellInvocation("mise run test").join(" "),
  ]);
  expect(result.outcome).toBe("passed");
});

test("keeps caller display settings for every verification command", async () => {
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: { ...process.env, NO_COLOR: "caller-no-color", FORCE_COLOR: "caller-force-color", CI: "caller-ci" }, cleanup: async () => {} },
    execute: async (_command, _args, options) => {
      expect(options.env.NO_COLOR).toBe("caller-no-color");
      expect(options.env.FORCE_COLOR).toBe("caller-force-color");
      expect(options.env.CI).toBe("caller-ci");
      return { stdout: "", stderr: "" };
    },
  });

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
  expect(calls).toEqual(["sh"]);
  expect(result).toMatchObject({ outcome: "failed", code: "verification_failed" });
  expect(result.summary).toContain("pnpm install did not complete successfully.");
  expect(result.summary).toContain("Failures:\nerror: setup failed");
  expect(result.summary).toContain("Check the project's verification command.");
  expect(result.summary).toContain("Output tail:\nbuilding\nerror: setup failed");
});

test("keeps Vitest failures ahead of ANSI and Fastify warning noise", async () => {
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (_command, args) => {
      if (args[1] === `${runtimeNodePathPrelude}pnpm install`) return { stdout: "", stderr: "" };
      throw Object.assign(new Error("tests failed"), {
        code: 1,
        stdout: "\u001B[31mFAIL unit tests/company-clear.test.ts\u001B[0m\n  SqliteError: no such table: probe_workflows",
        stderr: "(node:123) [DEP0169] DeprecationWarning: FastifyDeprecation warning\nUse node --trace-deprecation ...\nFastifyDeprecation: disableRequestLogging",
      });
    },
  });

  expect(result.summary).toContain("FAIL unit tests/company-clear.test.ts");
  expect(result.summary).toContain("SqliteError: no such table: probe_workflows");
  expect(result.summary).not.toContain("\u001B");
  expect(result.summary).not.toContain("FastifyDeprecation");
  expect(result.commands[1]?.stdout).not.toContain("\u001B");
});

test("includes a redacted bounded output tail when final verification fails", async () => {
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (_command, args) => {
      if (args[1] === `${runtimeNodePathPrelude}pnpm install`) return { stdout: "", stderr: "" };
      throw Object.assign(new Error("missing manifest"), { code: 1, stderr: "ERR_PNPM_NO_PKG_MANIFEST No package.json found\nBearer gho_secret" });
    },
  });
  expect(result.summary).toContain("pnpm test did not complete successfully");
  expect(result.summary).toContain("ERR_PNPM_NO_PKG_MANIFEST No package.json found");
  expect(result.summary).toContain("Check the project's verification command.");
  expect(result.summary).not.toContain("gho_secret");
});

test("rebuilds native modules once and retries verification after an ABI mismatch", async () => {
  const calls: Array<{ command: string; args: string[]; runtimeNodeBin: string | undefined }> = [];
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: {
      directory: "/tmp/forge-test-guard",
      env: { ...process.env, [runtimeNodeBinEnvironmentVariable]: "/inherited/wrong-node-bin" },
      cleanup: async () => {},
    },
    execute: async (command, args, options) => {
      const invocation = { command, args, runtimeNodeBin: options.env[runtimeNodeBinEnvironmentVariable] };
      calls.push(invocation);
      const verificationCalls = calls.filter((call) => call.args[1] === `${runtimeNodePathPrelude}pnpm test`);
      if (args[1] === `${runtimeNodePathPrelude}pnpm test` && verificationCalls.length === 1) {
        throw Object.assign(new Error("native module ABI mismatch"), { code: 1, stderr: "better-sqlite3 was compiled against a different Node.js version; NODE_MODULE_VERSION 127 requires 147" });
      }
      return { stdout: "", stderr: "" };
    },
  });

  expect(calls).toEqual([
    { command: "sh", args: pinnedShellInvocation("pnpm install").slice(1), runtimeNodeBin: dirname(process.execPath) },
    { command: "sh", args: pinnedShellInvocation("pnpm test").slice(1), runtimeNodeBin: dirname(process.execPath) },
    { command: "sh", args: pinnedShellInvocation("pnpm rebuild").slice(1), runtimeNodeBin: dirname(process.execPath) },
    { command: "sh", args: pinnedShellInvocation("pnpm test").slice(1), runtimeNodeBin: dirname(process.execPath) },
  ]);
  for (const call of calls) expect(call.args).toHaveLength(2);
  expect(result).toMatchObject({ outcome: "passed" });
});

test("does not rebuild native modules for unrelated verification failures", async () => {
  const calls: string[] = [];
  const result = await runPinnedVerification({ worktreePath: "/worktrees/task-1", setupCommand: "pnpm install", verificationCommand: "pnpm test" }, {
    guard: { directory: "/tmp/forge-test-guard", env: process.env, cleanup: async () => {} },
    execute: async (command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);
      if (args[1] === `${runtimeNodePathPrelude}pnpm test`) throw Object.assign(new Error("test failure"), { code: 1, stderr: "AssertionError: expected true to be false" });
      return { stdout: "", stderr: "" };
    },
  });

  expect(calls).toEqual([
    pinnedShellInvocation("pnpm install").join(" "),
    pinnedShellInvocation("pnpm test").join(" "),
  ]);
  expect(result).toMatchObject({ outcome: "failed", code: "verification_failed" });
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
