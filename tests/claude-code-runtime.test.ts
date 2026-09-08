import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { ClaudeCodeTaskRuntime, claudeArguments, claudeSessionBusy } from "../src/claude-code-task-runtime.js";
import type { HerdrClient, Pane, PaneProcessInfo } from "../src/herdr-client.js";
import { createOpenCodePromptIntent } from "../src/opencode-session.js";
import { CLAUDE_CODE_PROVIDER, HarnessRouter, profileHarness, sessionHarness, taskSessionRuntimeDirectory, taskSessionTitle, type TaskScope } from "../src/task-harness.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const sessionID = "71618050-0d31-428e-a547-d6c4a2eca88f";

async function fixture(behaviour: "complete" | "hang" | "crash" | "startup_failure") {
  const root = await mkdtemp(join(tmpdir(), "forge-claude-runtime-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const configDirectory = join(root, "claude-config");
  await mkdir(join(configDirectory, "projects"), { recursive: true });
  const executable = join(root, "claude");
  const line = (value: unknown) => `echo '${JSON.stringify(value)}'`;
  const script = {
    complete: [line({ type: "system", subtype: "init", session_id: sessionID, cwd: worktree, model: "claude-haiku-4-5-20251001", tools: [] }), line({ type: "assistant", uuid: "a1", session_id: sessionID, message: { role: "assistant", model: "claude-haiku-4-5-20251001", id: "msg_1", content: [{ type: "text", text: "Reviewed." }] } }), line({ type: "result", subtype: "success", is_error: false, result: "Reviewed the change.", session_id: sessionID, uuid: "r1" })],
    hang: [line({ type: "system", subtype: "init", session_id: sessionID, cwd: worktree, model: "m", tools: [] }), line({ type: "assistant", uuid: "a1", session_id: sessionID, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep" } }] } }), "exec sleep 30"],
    crash: [line({ type: "system", subtype: "init", session_id: sessionID, cwd: worktree, model: "m", tools: [] }), "exit 1"],
    startup_failure: ["echo 'Error: Not logged in' >&2", "exit 1"],
  }[behaviour];
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "$FORGE_TEST_ARGS"\ncat > "$FORGE_TEST_PROMPT"\n${script.join("\n")}\n`, { mode: 0o700 });
  process.env.FORGE_TEST_ARGS = join(root, "args.txt");
  process.env.FORGE_TEST_PROMPT = join(root, "prompt.txt");
  const scope: TaskScope = { id: "session-claude", taskId: "task-claude", directory: worktree, role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile: { providerID: CLAUDE_CODE_PROVIDER, modelID: "haiku", reasoningEffort: "low", serviceTier: "default" } };
  const runtime = new ClaudeCodeTaskRuntime(join(root, "forge.sqlite"), {} as HerdrClient, { executable, configDirectory });
  const intent = createOpenCodePromptIntent({ sessionID, directory: worktree, prompt: "Implement the change", model: { providerID: CLAUDE_CODE_PROVIDER, modelID: "haiku" }, agent: "forge-worker", variant: "low" });
  return { root, worktree, configDirectory, executable, scope, runtime, intent, runtimeDirectory: taskSessionRuntimeDirectory(join(root, "forge.sqlite"), scope.id) };
}

test("a headless turn is dispatched once, observed from its stream, and reported as the result", async () => {
  const f = await fixture("complete");
  expect(await f.runtime.ensureSession(f.scope, null)).toMatch(/^[0-9a-f-]{36}$/);
  expect(await f.runtime.ensureSession(f.scope, sessionID)).toBe(sessionID);
  expect(await f.runtime.observe(f.scope, f.intent)).toMatchObject({ state: "unknown", admission: "not_observed", retry: "allowed" });
  const claims: string[] = [];
  const dispatched = await f.runtime.dispatch(f.scope, f.intent, async generation => { claims.push(generation); return true; });
  expect(claims).toHaveLength(1);
  expect(dispatched.admission).toBe("observed");
  let observed = dispatched;
  for (let attempt = 0; attempt < 50 && observed.state !== "completed"; attempt += 1) { await delay(100); observed = await f.runtime.observe(f.scope, f.intent, { serverGeneration: claims[0]!, claimedAt: new Date().toISOString() }); }
  expect((await readFile(join(f.root, "prompt.txt"), "utf8"))).toBe("Implement the change");
  const args = (await readFile(join(f.root, "args.txt"), "utf8")).trim().split("\n");
  expect(args).toEqual(expect.arrayContaining(["-p", "--session-id", sessionID, "--model", "haiku", "--effort", "low", "--dangerously-skip-permissions"]));
  expect(args).not.toContain("--resume");
  expect(observed).toMatchObject({ state: "completed", admission: "observed", retry: "forbidden", assistantMessageID: "a1", native: { providerID: "claude-code", modelID: "claude-haiku-4-5-20251001", finish: "success" } });
  expect(await f.runtime.resultText(f.scope, observed)).toBe("Reviewed the change.");
  await expect(f.runtime.dispatch(f.scope, f.intent, async () => true)).rejects.toThrow("replay is blocked");
  expect(await f.runtime.observe(f.scope, { ...f.intent, dispatch: "ambiguous" })).toMatchObject({ state: "completed" });
  expect(await claudeSessionBusy(f.runtimeDirectory)).toBe(false);
});

test("a running turn is busy until stopped, then reads as an uncertain execution when tools were open", async () => {
  const f = await fixture("hang");
  await f.runtime.ensureSession(f.scope, sessionID);
  const dispatched = await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(dispatched).toMatchObject({ state: "running", admission: "observed" });
  const attempt = { serverGeneration: JSON.parse(await readFile(join(f.runtimeDirectory, "turn.json"), "utf8")).generation as string, claimedAt: new Date().toISOString() };
  let observed = dispatched;
  for (let poll = 0; poll < 50 && !observed.unsettledTools; poll += 1) { await delay(100); observed = await f.runtime.observe(f.scope, { ...f.intent, dispatch: "ambiguous" }, attempt); }
  expect(observed).toMatchObject({ state: "running", unsettledTools: true });
  expect(await claudeSessionBusy(f.runtimeDirectory)).toBe(true);
  await f.runtime.stop(f.scope, sessionID);
  expect(await claudeSessionBusy(f.runtimeDirectory)).toBe(false);
  expect(await f.runtime.recoverDispatch(f.scope, f.intent, attempt)).toMatchObject({ state: "unknown", executionUncertain: { stoppedServerGeneration: attempt.serverGeneration } });
});

test("a turn whose process exits without a result is interrupted, and a startup failure surfaces its stderr", async () => {
  const crashed = await fixture("crash");
  await crashed.runtime.ensureSession(crashed.scope, sessionID);
  await crashed.runtime.dispatch(crashed.scope, crashed.intent, async () => true);
  let observed;
  for (let attempt = 0; attempt < 50; attempt += 1) { observed = await crashed.runtime.observe(crashed.scope, { ...crashed.intent, dispatch: "ambiguous" }); if (observed.state !== "running") break; await delay(100); }
  expect(observed).toMatchObject({ state: "interrupted", reason: "dispatch_process_stopped" });
  const failed = await fixture("startup_failure");
  await failed.runtime.ensureSession(failed.scope, sessionID);
  await failed.runtime.dispatch(failed.scope, failed.intent, async () => true);
  for (let attempt = 0; attempt < 50; attempt += 1) { observed = await failed.runtime.observe(failed.scope, { ...failed.intent, dispatch: "ambiguous" }); if (observed.state !== "running") break; await delay(100); }
  expect(observed).toMatchObject({ state: "error", reason: "native_startup_failed" });
  expect(await failed.runtime.resultText(failed.scope, observed!)).toContain("Not logged in");
});

test("an unclaimed prompt is never spawned and a log without an identity is uncertain", async () => {
  const f = await fixture("complete");
  await expect(f.runtime.dispatch(f.scope, f.intent, async () => false)).rejects.toThrow("claim was not acquired");
  expect(await readdir(f.runtimeDirectory)).not.toContain("turn.json");
  await writeFile(join(f.runtimeDirectory, `turn-${f.intent.messageID}.jsonl`), "");
  expect(await f.runtime.observe(f.scope, { ...f.intent, dispatch: "ambiguous" }, { serverGeneration: "b775df17-718a-4cb2-8e23-6912b8aa0d39", claimedAt: new Date().toISOString() })).toMatchObject({ state: "unknown", retry: "forbidden", reason: "dispatch_identity_missing", executionUncertain: {} });
});

test("the display resumes the transcript in a Herdr pane only after the session exists", async () => {
  const f = await fixture("complete");
  const rootScope: TaskScope = { ...f.scope, id: "session-root", role: "root", identity: { taskId: "task-claude", sessionId: "session-root", generation: 1 } };
  const commands: string[] = [];
  const shell = (id: string): PaneProcessInfo => ({ pane_id: id, shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["/bin/zsh"] }] });
  const processes = new Map<string, PaneProcessInfo>([["pane", shell("pane")]]);
  const herdr: Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> = {
    async getPane(id): Promise<Pane> { return { paneId: id, cwd: f.worktree, tokens: { forge_binding_id: rootScope.id } }; },
    async getPaneProcessInfo(id) { return processes.get(id)!; },
    async createWorkspace() { throw new Error("No workspace expected"); }, async splitPane() { throw new Error("No split expected"); },
    async renamePane() {}, async reportPaneMetadata() {},
    async runPaneCommand(id, command) { commands.push(command); processes.set(id, { pane_id: id, shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: 11, name: "claude", argv: [f.executable, "--resume", sessionID, "--model", "haiku"] }] }); },
  };
  const runtime = new ClaudeCodeTaskRuntime(join(f.root, "forge.sqlite"), herdr, { executable: f.executable, configDirectory: f.configDirectory });
  await runtime.ensureSession(rootScope, sessionID);
  expect(JSON.parse(await readFile(join(taskSessionRuntimeDirectory(join(f.root, "forge.sqlite"), rootScope.id), "mcp.json"), "utf8")).mcpServers.forge_root.args).toContain("--binding");
  const attach = () => runtime.attach({ scope: rootScope, nativeSessionId: sessionID, paneId: "pane", persistPane: () => {} });
  await expect(attach()).rejects.toThrow("has not started");
  await mkdir(join(f.configDirectory, "projects", "-worktree"), { recursive: true });
  await writeFile(join(f.configDirectory, "projects", "-worktree", `${sessionID}.jsonl`), "");
  expect(await attach()).toBe("pane");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain(`'--resume' '${sessionID}'`);
  expect(commands[0]).toContain("'--allowedTools' 'mcp__forge_root'");
  expect(commands[0]).not.toContain("'-p'");
  expect(await attach()).toBe("pane");
  expect(commands).toHaveLength(1);
});

test("harness selection follows the profile provider and the native session identity", () => {
  expect(profileHarness(CLAUDE_CODE_PROVIDER)).toBe("claude-code");
  expect(profileHarness("anthropic")).toBe("opencode");
  expect(sessionHarness(sessionID)).toBe("claude-code");
  expect(sessionHarness("ses_abc")).toBe("opencode");
  const calls: string[] = [];
  const fake = (name: string) => ({ ensureSession: async () => { calls.push(name); return name; }, stop: async () => { calls.push(`stop:${name}`); } }) as never;
  const router = new HarnessRouter({ opencode: fake("opencode"), "claude-code": fake("claude-code") });
  const scope: TaskScope = { id: "s", taskId: "t", directory: "/repo", role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile: { providerID: "openai", modelID: "m", reasoningEffort: "low", serviceTier: "default" } };
  void router.ensureSession(scope, null);
  void router.ensureSession({ ...scope, profile: { ...scope.profile, providerID: CLAUDE_CODE_PROVIDER } }, null);
  void router.stop(scope, sessionID);
  void router.stop(scope, "ses_abc");
  void router.stop(scope, null);
  expect(calls).toEqual(["opencode", "claude-code", "stop:claude-code", "stop:opencode", "stop:opencode"]);
  const rootArguments = claudeArguments({ scope: { ...scope, role: "root", identity: { taskId: "t", sessionId: "s", generation: 1 } }, sessionID, resume: true, print: true, runtimeDirectory: "/runtime" });
  expect(rootArguments).toEqual(expect.arrayContaining(["--tools", "--allowedTools", "mcp__forge_root", "--mcp-config", "/runtime/mcp.json", "--strict-mcp-config", "--permission-prompts", "none"]));
  expect(rootArguments).not.toContain("--dangerously-skip-permissions");
});

test("Claude workflow roles retain their prompts, read-only Advisor tools, and evidence directory", async () => {
  const f = await fixture("complete");
  const evidenceRoot = join(f.root, "evidence", "task-claude");
  const scope: TaskScope = { ...f.scope, role: "advisor", label: "Reviewer", workflow: "independent_review", evidenceRoot };
  await f.runtime.ensureSession(scope, sessionID);
  expect(await readdir(evidenceRoot)).toEqual([]);
  expect(taskSessionTitle(scope)).toBe("task-claude Reviewer");
  const args = claudeArguments({ scope, sessionID, resume: false, print: true, runtimeDirectory: f.runtimeDirectory });
  expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,WebFetch,WebSearch,TodoWrite");
  expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  expect(args[args.indexOf("--add-dir") + 1]).toBe(scope.evidenceRoot);
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("mcp__forge_root");
  expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("Advisor");
  const worker = claudeArguments({ scope: { ...f.scope, role: "worker", workflow: "direct_build", workerMode: "direct", purpose: "verification" }, sessionID, resume: false, print: true, runtimeDirectory: f.runtimeDirectory });
  expect(worker[worker.indexOf("--append-system-prompt") + 1]).toContain("Direct build assignment");
  expect(worker[worker.indexOf("--append-system-prompt") + 1]).toContain("verification only");
});

test("workflow evidence routes to Claude and reads only the requested native turn", async () => {
  const f = await fixture("complete");
  await f.runtime.ensureSession(f.scope, sessionID);
  const observation = { sessionID, messageID: f.intent.messageID, state: "completed", admission: "observed", retry: "forbidden", assistantMessageIDs: [] } satisfies Awaited<ReturnType<typeof f.runtime.observe>>;
  const opencode = new FakeTaskHarness();
  opencode.turnEvidence = async () => { throw new Error("Wrong harness"); };
  const router = new HarnessRouter({ "claude-code": f.runtime, opencode });
  expect(await router.turnEvidence(f.scope, observation)).toMatchObject({ tools: [], limit: expect.stringContaining("missing") });
  await writeFile(join(f.runtimeDirectory, "turn-other.jsonl"), JSON.stringify({ type: "assistant", uuid: "other", message: { role: "assistant", content: [{ type: "tool_use", id: "other-tool", name: "Bash", input: { command: "wrong turn" } }] } }));
  await writeFile(join(f.runtimeDirectory, `turn-${observation.messageID}.jsonl`), [
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "check", name: "Bash", input: { command: "pnpm test" } }] } },
    { type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "check", content: "Tests passed" }] } },
  ].map(value => JSON.stringify(value)).join("\n"));
  expect(await router.turnEvidence(f.scope, observation)).toEqual({ tools: [{ id: "check", name: "Bash", status: "completed", input: { command: "pnpm test" }, output: "Tests passed", error: null }], limit: null });
});
