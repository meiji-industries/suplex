import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeCodeTaskRuntime } from "../src/runtimes/claude-code/task-runtime.js";
import type { TaskPanePort } from "../src/runtimes/task-display.js";
import { createOpenCodePromptIntent } from "../src/runtimes/opencode/session.js";
import { CLAUDE_CODE_PROVIDER, type TaskScope } from "../src/runtimes/task-harness.js";

const directories: string[] = [];
const sessionID = "71618050-0d31-428e-a547-d6c4a2eca88f";
const expectedEnvironment = { sentinel: true, ghConfig: true, ghConfigFile: true, homeUnchanged: true, claudeConfig: true };
const noPane: TaskPanePort = {
  getPane: async () => { throw new Error("Dispatch must not use a task pane"); },
  getPaneProcessInfo: async () => { throw new Error("Dispatch must not use a task pane"); },
  createWorkspace: async () => { throw new Error("Dispatch must not use a task pane"); },
  splitPane: async () => { throw new Error("Dispatch must not use a task pane"); },
  renamePane: async () => { throw new Error("Dispatch must not use a task pane"); },
  runPaneCommand: async () => { throw new Error("Dispatch must not use a task pane"); },
  reportPaneMetadata: async () => { throw new Error("Dispatch must not use a task pane"); },
};

type EnvironmentObservation = typeof expectedEnvironment;
type Fixture = { executable: string; observation: string; providerConfig: string; root: string; worktree: string };
type CallerEnvironment = { claudeConfig: string; ghConfig: string; homeHash: string; sentinel: string };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-claude-environment-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  const providerConfig = join(root, "provider-config");
  const executable = join(root, "claude");
  const bin = join(root, "bin");
  const tool = `forge-gh-config-probe-${randomUUID()}`;
  const observation = join(root, "environment.json");
  const expectation = join(root, "expected-environment.json");
  await Promise.all([mkdir(worktree), mkdir(providerConfig), mkdir(bin)]);
  await writeFile(join(bin, tool), `#!${process.execPath}
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const failed = { sentinel: false, ghConfig: false, ghConfigFile: false, homeUnchanged: false, claudeConfig: false };
let checks = failed;
try {
  const expected = JSON.parse(fs.readFileSync(${JSON.stringify(expectation)}, "utf8"));
  checks = {
    sentinel: process.env.FORGE_CLAUDE_ENV_SENTINEL === expected.sentinel,
    ghConfig: process.env.GH_CONFIG_DIR === expected.ghConfig,
    ghConfigFile: typeof process.env.GH_CONFIG_DIR === "string" && fs.readFileSync(path.join(process.env.GH_CONFIG_DIR, "hosts.yml"), "utf8") === "github.com:\\n  user: fixture\\n",
    homeUnchanged: createHash("sha256").update(process.env.HOME ?? "").digest("hex") === expected.homeHash,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR === expected.claudeConfig,
  };
} catch { checks = failed; }
process.stdout.write(JSON.stringify(checks));
process.exit(Object.values(checks).every(Boolean) ? 0 : 4);
`, { mode: 0o700 });
  await writeFile(executable, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const result = spawnSync(${JSON.stringify(tool)}, [], { encoding: "utf8" });
const failed = { sentinel: false, ghConfig: false, ghConfigFile: false, homeUnchanged: false, claudeConfig: false };
let observation = failed;
try { observation = result.stdout ? JSON.parse(result.stdout) : failed; } catch { observation = failed; }
fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify(observation));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "${sessionID}", cwd: process.cwd(), model: "haiku", tools: [] }));
if (result.status === 0) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Nested configuration probe completed", session_id: "${sessionID}", uuid: "result" }));
  process.exit(0);
}
console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Nested configuration probe failed", session_id: "${sessionID}", uuid: "result" }));
process.exit(result.status ?? 4);
`, { mode: 0o700 });
  return { executable, observation, providerConfig, root, worktree };
}

async function writeExpectation(root: string, expected: CallerEnvironment): Promise<void> {
  await writeFile(join(root, "expected-environment.json"), JSON.stringify(expected));
}

async function configureCallerEnvironment(root: string, name: string): Promise<CallerEnvironment> {
  const parentConfig = join(root, `${name}-parent-claude-config`);
  const ghConfig = join(root, `${name}-gh-config`);
  await Promise.all([mkdir(parentConfig), mkdir(ghConfig)]);
  await writeFile(join(ghConfig, "hosts.yml"), "github.com:\n  user: fixture\n");
  vi.stubEnv("FORGE_CLAUDE_ENV_SENTINEL", `${name}-sentinel`);
  vi.stubEnv("CLAUDE_CONFIG_DIR", parentConfig);
  vi.stubEnv("GH_CONFIG_DIR", ghConfig);
  const expected = { sentinel: `${name}-sentinel`, claudeConfig: parentConfig, ghConfig, homeHash: createHash("sha256").update(process.env.HOME ?? "").digest("hex") };
  await writeExpectation(root, expected);
  return expected;
}

function configureFixtureExecutable(f: Fixture): void {
  vi.stubEnv("PATH", `${join(f.root, "bin")}:${process.env.PATH ?? ""}`);
}

async function readObservation(path: string): Promise<EnvironmentObservation> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await delay(25);
    }
  }
  throw new Error("Fixture Claude process did not write its environment observation");
}

async function waitForTerminalObservation(runtime: ClaudeCodeTaskRuntime, taskScope: TaskScope, taskIntent: Parameters<ClaudeCodeTaskRuntime["observe"]>[1]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const observation = await runtime.observe(taskScope, { ...taskIntent, dispatch: "ambiguous" });
    if (observation.state !== "running") return observation;
    await delay(25);
  }
  throw new Error("Fixture Claude process did not finish");
}

function scope(input: { role: "root" | "advisor"; worktree: string; providerConfig?: string | null }): TaskScope {
  const base = {
    id: `claude-${input.role}`,
    taskId: "task-claude",
    directory: input.worktree,
    workflow: "standard" as const,
    evidenceRoot: null,
    profile: { providerID: CLAUDE_CODE_PROVIDER, modelID: "haiku", reasoningEffort: "low" as const, serviceTier: "default" as const, ...(input.providerConfig === undefined ? {} : { instanceHomeDirectory: input.providerConfig }) },
  };
  return input.role === "root"
    ? { ...base, role: "root", identity: { taskId: base.taskId, sessionId: base.id, generation: 1 } }
    : { ...base, role: "advisor", advisorRole: "reviewer", label: "Reviewer" };
}

function intent(role: "root" | "advisor", prompt = "Inspect configuration") {
  return createOpenCodePromptIntent({ sessionID, directory: "/fixture", prompt, model: { providerID: CLAUDE_CODE_PROVIDER, modelID: "haiku" }, agent: `forge-${role}`, variant: "low" });
}

test.each([
  ["root", undefined],
  ["root", null],
  ["root", "custom"],
  ["advisor", undefined],
  ["advisor", null],
  ["advisor", "custom"],
] as const)("%s dispatch inherits caller configuration and applies the %s instance setting", async (role, instance) => {
  const f = await fixture();
  configureFixtureExecutable(f);
  const expected = await configureCallerEnvironment(f.root, `${role}-${instance ?? "default"}`);
  const providerConfig = instance === "custom" ? f.providerConfig : instance;
  if (providerConfig) await writeExpectation(f.root, { ...expected, claudeConfig: providerConfig });
  const taskScope = scope(providerConfig === undefined ? { role, worktree: f.worktree } : { role, worktree: f.worktree, providerConfig });
  const runtime = new ClaudeCodeTaskRuntime(join(f.root, "forge.sqlite"), noPane, { executable: f.executable });
  const taskIntent = intent(role);
  await runtime.dispatch(taskScope, taskIntent, async () => true);
  expect(await readObservation(f.observation)).toEqual(expectedEnvironment);
  expect((await waitForTerminalObservation(runtime, taskScope, taskIntent)).state).toBe("completed");
  await runtime.stop(taskScope, sessionID);
});

test("a recreated runtime reads the caller environment again without a pane", async () => {
  const f = await fixture();
  configureFixtureExecutable(f);
  const rootScope = scope({ role: "root", worktree: f.worktree, providerConfig: null });
  await configureCallerEnvironment(f.root, "first");
  const firstIntent = intent("root");
  const initialRuntime = new ClaudeCodeTaskRuntime(join(f.root, "forge.sqlite"), noPane, { executable: f.executable });
  await initialRuntime.dispatch(rootScope, firstIntent, async () => true);
  expect(await readObservation(f.observation)).toEqual(expectedEnvironment);
  expect((await waitForTerminalObservation(initialRuntime, rootScope, firstIntent)).state).toBe("completed");
  await initialRuntime.stop(rootScope, sessionID);
  await rm(f.observation);
  await configureCallerEnvironment(f.root, "second");
  const secondIntent = intent("root", "Inspect configuration again");
  const recreatedRuntime = new ClaudeCodeTaskRuntime(join(f.root, "forge.sqlite"), noPane, { executable: f.executable });
  await recreatedRuntime.dispatch(rootScope, secondIntent, async () => true);
  expect(await readObservation(f.observation)).toEqual(expectedEnvironment);
  expect((await waitForTerminalObservation(recreatedRuntime, rootScope, secondIntent)).state).toBe("completed");
  await recreatedRuntime.stop(rootScope, sessionID);
});
