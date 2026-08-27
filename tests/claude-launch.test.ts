import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { prepareClaudeLaunch } from "../src/agent-providers/claude-launch.js";
import { claudeRuntime } from "../src/agent-providers/herdr-runtime.js";

test("Claude runtime launches fresh sessions and resumes transcripts", () => {
  const settings = { model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" as const };
  expect(claudeRuntime.launchArgs(settings, "session", false)).toEqual(["--model", "claude-fable-5", "--effort", "high", "--permission-mode", "bypassPermissions", "--session-id", "session"]);
  expect(claudeRuntime.launchArgs(settings, "session", true)).toEqual(["--model", "claude-fable-5", "--effort", "high", "--permission-mode", "bypassPermissions", "--resume", "session"]);
  expect(() => claudeRuntime.launchArgs({ ...settings, model: "invalid model" }, "session", false)).toThrow("Claude launch settings are invalid");
  expect(() => claudeRuntime.launchArgs({ ...settings, reasoningLevel: "max" }, "session", false)).toThrow("Claude launch settings are invalid");
});

test("Claude preparation creates and preserves its config idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-claude-launch-"));
  const cwd = join(root, "worktree");
  const configDir = join(root, "config");
  await writeFile(join(root, ".keep"), "");
  await mkdir(cwd, { recursive: true });
  try {
    const env = { CLAUDE_CONFIG_DIR: configDir };
    await prepareClaudeLaunch({ cwd, env });
    const configFile = join(configDir, ".claude.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    expect(config).toMatchObject({ bypassPermissionsModeAccepted: true, projects: { [await realpath(cwd)]: { hasTrustDialogAccepted: true } } });
    const before = await stat(configFile);
    await prepareClaudeLaunch({ cwd, env });
    expect((await stat(configFile)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
