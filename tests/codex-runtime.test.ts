// eslint-disable-next-line no-restricted-imports -- the regression owns and stops a long-running display process group.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { advisorReportFromTurn } from "../src/coordination/advisor-report.js";
import type { HerdrClient, Pane, PaneProcessInfo } from "../src/integrations/herdr/client.js";
import { CodexSessionReader } from "../src/runtimes/codex/session-reader.js";
import { codexDisplayAttached, codexDisplayCommand } from "../src/runtimes/codex/display.js";
import { CodexTaskRuntime, codexArguments, codexSessionBusy, readCodexThreadId } from "../src/runtimes/codex/task-runtime.js";
import { createOpenCodePromptIntent } from "../src/runtimes/opencode/session.js";
import { advisorBridgeResultPath, profileHarness, sessionHarness, taskSessionRuntimeDirectory, type TaskScope } from "../src/runtimes/task-harness.js";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import type { TaskSession } from "../src/tasks/control.js";

const THREAD_ID = "11111111-2222-4333-8444-555555555555";
const SECOND_THREAD_ID = "99999999-8888-4777-8666-555555555555";
const directories: string[] = [];
const displayProcesses: { child: ChildProcess; processGroup: number }[] = [];

afterEach(async () => {
  await Promise.all(displayProcesses.splice(0).map(({ child, processGroup }) => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    try { process.kill(-processGroup, "SIGTERM"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      resolve();
    }
  })));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  for (const key of ["FORGE_ROOT_BINDING", "FORGE_ROOT_TOKEN", "FORGE_ADVISOR_BINDING", "FORGE_ADVISOR_TOKEN", "FORGE_ADVISOR_RESULT", "FORGE_GH_COMMAND", "FORGE_TEST_ARGS", "FORGE_TEST_PROMPT", "FORGE_TEST_BRIDGE_ENV", "FORGE_TEST_COUNT"]) delete process.env[key];
});

const event = (value: unknown): string => `printf '%s\\n' '${JSON.stringify(value)}'`;
const RATER_SUBMISSION = { rating: 10, blockingFindings: [], verification: "passed", verificationSummary: "Focused tests passed", summary: "Ready" };

const COMPLETE = [
  event({ type: "thread.started", thread_id: THREAD_ID }),
  event({ type: "turn.started" }),
  event({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "pnpm test", status: "in_progress" } }),
  event({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "pnpm test", aggregated_output: "2 passed", exit_code: 0, status: "completed" } }),
  `if [ -n "$FORGE_ADVISOR_RESULT" ]; then ${event({ type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "forge_advisor", tool: "submit_report", arguments: {}, result: { structuredContent: RATER_SUBMISSION }, status: "completed" } })}; fi`,
  event({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Reviewed the change." } }),
  event({ type: "turn.completed", usage: { input_tokens: 1_000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 } }),
];

const BEHAVIOURS = {
  complete: COMPLETE,
  // The whole successful turn is on disk while the process is still alive.
  complete_slow: [...COMPLETE, "sleep 30"],
  hang: [event({ type: "thread.started", thread_id: THREAD_ID }), "sleep 30"],
  crash: [event({ type: "thread.started", thread_id: THREAD_ID }), event({ type: "turn.failed", error: { message: "stream disconnected" } }), "exit 1"],
  startup_failure: ["echo 'Error: Not logged in' >&2", "exit 1"],
  // A started tool the process never completes.
  unsettled: [event({ type: "thread.started", thread_id: THREAD_ID }), event({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "pnpm test", status: "in_progress" } }), "exit 0"],
  resume_failure: [
    `if [ "$2" = "resume" ]; then printf 'error: no rollout found for thread id %s\\n' "$3" >&2; exit 1; fi`,
    `count=$(cat "$FORGE_TEST_COUNT" 2>/dev/null || echo 0); count=$((count + 1)); printf '%s' "$count" > "$FORGE_TEST_COUNT"`,
    `if [ "$count" = "1" ]; then thread='${THREAD_ID}'; else thread='${SECOND_THREAD_ID}'; fi`,
    `printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"`,
    ...COMPLETE.slice(1),
  ],
};

async function fixture(behaviour: keyof typeof BEHAVIOURS) {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-runtime-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const executable = join(root, "codex");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' '--TURN--' "$@" >> "$FORGE_TEST_ARGS"
printf '%s\\n' '--PROMPT--' >> "$FORGE_TEST_PROMPT"
cat >> "$FORGE_TEST_PROMPT"
printf '%s|%s|%s|%s|%s\\n' "$FORGE_ROOT_BINDING" "$FORGE_ROOT_TOKEN" "$FORGE_ADVISOR_BINDING" "$FORGE_ADVISOR_TOKEN" "$FORGE_ADVISOR_RESULT" >> "$FORGE_TEST_BRIDGE_ENV"
${BEHAVIOURS[behaviour].join("\n")}
`, { mode: 0o700 });
  process.env.FORGE_TEST_ARGS = join(root, "args.txt");
  process.env.FORGE_TEST_PROMPT = join(root, "prompt.txt");
  process.env.FORGE_TEST_BRIDGE_ENV = join(root, "bridge-env.txt");
  process.env.FORGE_TEST_COUNT = join(root, "count.txt");
  const databasePath = join(root, "forge.sqlite");
  const profile = { providerID: "codex", modelID: "gpt-5.6-sol", reasoningEffort: "low", serviceTier: "default" } as const;
  const scope: TaskScope = { id: "session-codex", taskId: "task-codex", directory: worktree, role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile };
  const sessionID = `codex-${THREAD_ID}`;
  const runtime = new CodexTaskRuntime(databasePath, {} as never, { executable });
  const intent = createOpenCodePromptIntent({ sessionID, directory: worktree, prompt: "Implement the change", model: { providerID: "codex", modelID: "gpt-5.6-sol" }, agent: "forge-worker", variant: "low" });
  return { root, databasePath, executable, scope, runtime, intent, sessionID, runtimeDirectory: taskSessionRuntimeDirectory(databasePath, scope.id) };
}

async function eventually(f: Awaited<ReturnType<typeof fixture>>, intent = f.intent, scope: TaskScope = f.scope) {
  let observed = await f.runtime.observe(scope, { ...intent, dispatch: "ambiguous" });
  for (let attempt = 0; attempt < 50 && observed.state === "running"; attempt += 1) {
    await delay(100);
    observed = await f.runtime.observe(scope, { ...intent, dispatch: "ambiguous" });
  }
  return observed;
}

const turns = async (root: string): Promise<string[][]> =>
  (await readFile(join(root, "args.txt"), "utf8")).split("--TURN--\n").filter(Boolean).map(turn => turn.trim().split("\n"));

test("Codex routing is unambiguous against the other harness identities", () => {
  expect(profileHarness("codex")).toBe("codex");
  expect(sessionHarness(`codex-${THREAD_ID}`)).toBe("codex");
  expect(sessionHarness(THREAD_ID)).toBe("claude-code");
  expect(sessionHarness("devin-abc")).toBe("devin");
  expect(sessionHarness("ses_abc")).toBe("opencode");
});

test("every policy rides on a config override and the bridge names its variables without values", () => {
  const profile = { providerID: "codex", modelID: "gpt-5.6-sol", reasoningEffort: "low", serviceTier: "default" } as const;
  const rootScope: TaskScope = { id: "s", taskId: "t", directory: "/w", role: "root", identity: { taskId: "t", sessionId: "s", generation: 1 }, workflow: "standard", evidenceRoot: null, profile };
  const bridge = { command: "/usr/bin/node", args: ["/tmp/cli.mjs", "/tmp/root-bridge.ts"], environment: { FORGE_ROOT_BINDING: "/tmp/root.binding.json", FORGE_ROOT_TOKEN: "t-1", FORGE_GH_COMMAND: "/opt/gh" } };

  expect(codexArguments({ scope: rootScope, resumeThreadId: null, bridge })).toEqual([
    "exec", "--json", "--skip-git-repo-check", "-m", "gpt-5.6-sol",
    "-c", 'model_reasoning_effort="low"',
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="read-only"',
    "-c", 'mcp_servers.forge_root={command="/usr/bin/node",args=["/tmp/cli.mjs","/tmp/root-bridge.ts"],env_vars=["FORGE_ROOT_BINDING","FORGE_ROOT_TOKEN","FORGE_GH_COMMAND"],default_tools_approval_mode="approve"}',
    "-",
  ]);
  expect(codexArguments({ scope: rootScope, resumeThreadId: null, bridge }).join(" ")).not.toContain("t-1");

  const advisorScope: TaskScope = { id: "s", taskId: "t", directory: "/w", role: "advisor", advisorRole: "rater", label: "Rater", workflow: "standard", evidenceRoot: null, profile };
  expect(codexArguments({ scope: advisorScope, resumeThreadId: THREAD_ID, bridge })).toEqual(expect.arrayContaining(["resume", THREAD_ID, 'sandbox_mode="read-only"']));
  expect(codexArguments({ scope: advisorScope, resumeThreadId: THREAD_ID, bridge })[1]).toBe("resume");

  const hostile = { command: "/usr/bin/node", args: [], environment: { 'a"b\\c\nd\te': "unused" } };
  const quoted = codexArguments({ scope: rootScope, resumeThreadId: null, bridge: hostile }).find(argument => argument.startsWith("mcp_servers."))!;
  expect(quoted).toBe('mcp_servers.forge_root={command="/usr/bin/node",args=[],env_vars=["a\\"b\\\\c\\nd\\te"],default_tools_approval_mode="approve"}');
  expect(quoted).not.toContain("\n");
});

test("a Worker starts without resume, persists the Codex thread id, then resumes it", async () => {
  const f = await fixture("complete");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  expect(await readdir(f.runtimeDirectory)).not.toContain("root.binding.json");
  expect(await readCodexThreadId(f.runtimeDirectory)).toBeNull();

  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed", assistantMessageID: f.intent.messageID, native: { providerID: "codex", modelID: "gpt-5.6-sol", agent: "forge-worker" } });
  expect(await readCodexThreadId(f.runtimeDirectory)).toBe(THREAD_ID);

  const second = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Check the change", model: { providerID: "codex", modelID: "gpt-5.6-sol" }, agent: "forge-worker", variant: "low" });
  await f.runtime.dispatch(f.scope, second, async () => true);
  expect(await eventually(f, second)).toMatchObject({ state: "completed" });

  const [first, resumed] = await turns(f.root);
  expect(first).toEqual([
    "exec", "--json", "--skip-git-repo-check", "-m", "gpt-5.6-sol",
    "-c", 'model_reasoning_effort="low"',
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="danger-full-access"',
    "-",
  ]);
  expect(first).not.toContain("resume");
  expect(first!.some(argument => argument.startsWith("mcp_servers."))).toBe(false);
  expect(resumed!.slice(0, 3)).toEqual(["exec", "resume", THREAD_ID]);

  const prompts = (await readFile(join(f.root, "prompt.txt"), "utf8")).split("--PROMPT--\n").filter(Boolean);
  expect(prompts[0]).toBe(`${taskRolePrompt("worker", { workflow: "standard", workerMode: "planned", purpose: "implementation" })}\n\nImplement the change`);
  expect(await readFile(join(f.runtimeDirectory, `turn-${f.intent.messageID}.prompt`), "utf8")).toBe(prompts[0]);
  expect((await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("\n")).toEqual(["||||", "||||"]);
});

test("a Coordinator turn passes the bridge as a config override and no project file", async () => {
  const f = await fixture("complete");
  const fakeGh = join(f.root, "gh");
  await writeFile(fakeGh, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env.FORGE_GH_COMMAND = fakeGh;
  const scope: TaskScope = { ...f.scope, role: "root", identity: { taskId: "task-codex", sessionId: "session-codex", generation: 1 } };

  await expect(f.runtime.ensureSession(scope, null)).resolves.toMatch(/^codex-/);
  await f.runtime.dispatch(scope, f.intent, async () => true);
  expect(await eventually(f, f.intent, scope)).toMatchObject({ state: "completed", native: { agent: "forge-root" } });

  const [first] = await turns(f.root);
  expect(first).toContain('sandbox_mode="read-only"');
  const override = first!.find(argument => argument.startsWith("mcp_servers."))!;
  expect(override).toContain(`mcp_servers.forge_root={command=`);
  expect(override).toContain(`env_vars=["FORGE_ROOT_BINDING","FORGE_ROOT_TOKEN","FORGE_GH_COMMAND"],default_tools_approval_mode="approve"`);
  expect(await readdir(f.scope.directory)).toEqual([]);
  const dispatched = (await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("|");
  expect(dispatched[0]).toBe(join(f.runtimeDirectory, "root.binding.json"));
  expect(dispatched[4]).toBe("");
  // The token reaches Codex through its environment, never through its argv.
  expect(dispatched[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(override).not.toContain(dispatched[1]!);
  const record = JSON.parse(await readFile(join(f.runtimeDirectory, "turn.json"), "utf8"));
  expect(JSON.stringify(record.processIdentity.argv)).not.toContain(dispatched[1]!);
});

test("an Advisor turn carries its result path and its bridge submission is the report", async () => {
  const f = await fixture("complete");
  const scope: TaskScope = { ...f.scope, role: "advisor", advisorRole: "rater", label: "Rater", workflow: "refine_pull_request" };
  await f.runtime.ensureSession(scope, f.sessionID);
  await f.runtime.dispatch(scope, f.intent, async () => true);
  const observation = await eventually(f, f.intent, scope);
  expect(observation).toMatchObject({ state: "completed", native: { mode: "forge-advisor" } });

  const dispatched = (await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("|");
  expect(dispatched[2]).toBe(join(f.runtimeDirectory, "advisor.binding.json"));
  expect(dispatched[3]).toMatch(/^[0-9a-f-]{36}$/);
  expect(dispatched[4]).toBe(advisorBridgeResultPath(f.runtimeDirectory, f.intent.messageID));
  const [first] = await turns(f.root);
  expect(first!.some(argument => argument.startsWith("mcp_servers.forge_advisor={command="))).toBe(true);

  const text = await f.runtime.resultText(scope, observation);
  const evidence = await f.runtime.turnEvidence(scope, observation);
  expect(advisorReportFromTurn("rater", evidence.tools, text)).toMatchObject({ result: { role: "rater", rating: 10 } });
});

test("a turn that has already printed its result is still running until the process exits", async () => {
  const f = await fixture("complete_slow");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(await f.runtime.observe(f.scope, { ...f.intent, dispatch: "ambiguous" })).toMatchObject({ state: "running", reason: "dispatch_process_running" });
    expect(await codexSessionBusy(f.runtimeDirectory)).toBe(true);
    await delay(50);
  }

  await f.runtime.stop(f.scope, f.sessionID);
  expect(await codexSessionBusy(f.runtimeDirectory)).toBe(false);
});

test("a tool left running when the process stops makes the turn's execution uncertain", async () => {
  const f = await fixture("unsettled");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "unknown", reason: "tool_execution_after_process_stopped", unsettledTools: true, executionUncertain: { stoppedServerGeneration: expect.any(String) } });
});

test("an unresumable thread is forgotten once, so the next turn starts a fresh one", async () => {
  const f = await fixture("resume_failure");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  expect(await readCodexThreadId(f.runtimeDirectory)).toBe(THREAD_ID);

  const second = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Continue", model: { providerID: "codex", modelID: "gpt-5.6-sol" }, agent: "forge-worker", variant: "low" });
  await f.runtime.dispatch(f.scope, second, async () => true);
  expect(await eventually(f, second)).toMatchObject({ state: "error", reason: "native_startup_failed" });
  expect(await readCodexThreadId(f.runtimeDirectory)).toBeNull();
  expect(await readdir(f.runtimeDirectory)).not.toContain("session.json");

  const third = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Try again", model: { providerID: "codex", modelID: "gpt-5.6-sol" }, agent: "forge-worker", variant: "low" });
  await f.runtime.dispatch(f.scope, third, async () => true);
  expect(await eventually(f, third)).toMatchObject({ state: "completed" });
  const [, resumed, fresh] = await turns(f.root);
  expect(resumed!.slice(0, 3)).toEqual(["exec", "resume", THREAD_ID]);
  expect(fresh).not.toContain("resume");
  expect(await readCodexThreadId(f.runtimeDirectory)).toBe(SECOND_THREAD_ID);
});

test("an authentication failure keeps the thread, because a new one would drop the conversation", async () => {
  const f = await fixture("startup_failure");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await writeFile(join(f.runtimeDirectory, "session.json"), JSON.stringify({ threadId: THREAD_ID }));
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "error", reason: "native_startup_failed" });
  expect(await readCodexThreadId(f.runtimeDirectory)).toBe(THREAD_ID);
});

test("a lost session record is rebuilt from the turn log so the thread still resumes", async () => {
  const f = await fixture("complete");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  await writeFile(join(f.runtimeDirectory, "session.json"), "{ not json");

  const second = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Check the change", model: { providerID: "codex", modelID: "gpt-5.6-sol" }, agent: "forge-worker", variant: "low" });
  await f.runtime.dispatch(f.scope, second, async () => true);
  expect(await eventually(f, second)).toMatchObject({ state: "completed" });
  expect((await turns(f.root))[1]!.slice(0, 3)).toEqual(["exec", "resume", THREAD_ID]);
  expect(await readCodexThreadId(f.runtimeDirectory)).toBe(THREAD_ID);
});

test("a Worker dispatch never inherits Forge's own bridge variables", async () => {
  const f = await fixture("complete");
  process.env.FORGE_ROOT_BINDING = "/contaminated/root.binding.json";
  process.env.FORGE_ROOT_TOKEN = "contaminated-token";
  process.env.FORGE_ADVISOR_RESULT = "/contaminated/result.json";
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  expect((await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim()).toBe("||||");
});

test("a hanging Codex turn is busy until stopped", async () => {
  const f = await fixture("hang");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await f.runtime.observe(f.scope, { ...f.intent, dispatch: "ambiguous" })).toMatchObject({ state: "running", reason: "dispatch_process_running" });
  expect(await codexSessionBusy(f.runtimeDirectory)).toBe(true);
  await f.runtime.stop(f.scope, f.sessionID);
  expect(await codexSessionBusy(f.runtimeDirectory)).toBe(false);
});

test("a failed turn is a native error and a startup failure retains stderr", async () => {
  const crash = await fixture("crash");
  await crash.runtime.ensureSession(crash.scope, crash.sessionID);
  await crash.runtime.dispatch(crash.scope, crash.intent, async () => true);
  expect(await eventually(crash)).toMatchObject({ state: "error", reason: "native_error" });
  expect(await readCodexThreadId(crash.runtimeDirectory)).toBe(THREAD_ID);

  const failed = await fixture("startup_failure");
  await failed.runtime.ensureSession(failed.scope, failed.sessionID);
  await failed.runtime.dispatch(failed.scope, failed.intent, async () => true);
  const observed = await eventually(failed);
  expect(observed).toMatchObject({ state: "error", reason: "native_startup_failed" });
  expect(await failed.runtime.resultText(failed.scope, observed)).toContain("Not logged in");
  expect(await readCodexThreadId(failed.runtimeDirectory)).toBeNull();
});

test("turn evidence and the session reader report the same native tools", async () => {
  const f = await fixture("complete");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  const observation = await eventually(f);

  expect(await f.runtime.resultText(f.scope, observation)).toBe("Reviewed the change.");
  const evidence = await f.runtime.turnEvidence(f.scope, observation);
  expect(evidence).toMatchObject({ limit: null, tools: [{ name: "command_execution", status: "completed", input: { command: "pnpm test" }, output: "2 passed", error: null }] });

  const session = { id: f.scope.id, nativeSessionId: f.sessionID, kind: "worker" as const } as TaskSession;
  const reader = new CodexSessionReader(f.databasePath);
  expect(await reader.turnEvidence(session, f.intent.messageID)).toMatchObject({ limitation: null, tools: [{ name: "command_execution" }] });
  expect(await reader.turnEvidence(session, "turn-absent")).toEqual({ tools: [], limitation: "The native turn log is missing" });
  expect(await reader.execution(session)).toMatchObject({ limited: false, plan: null });
  // Codex restarts its item ids at item_0 every turn, so the session view must namespace them.
  await writeFile(join(f.runtimeDirectory, "turn-later.jsonl"), `${JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "pnpm lint", exit_code: 0, status: "completed" } })}\n`);
  const ids = (await reader.execution(session)).tools.map(tool => tool.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain(`${f.intent.messageID}:item_0`);
  expect(ids).toContain("later:item_0");
  expect(await reader.history(session)).toMatchObject([{ role: "assistant", content: [{ type: "text", text: "Reviewed the change." }] }]);
  const timeline = await reader.timeline(session);
  expect(timeline.usage).toMatchObject([{ provider: "openai", model: "gpt-5.6-sol", tokens: { input: 300, cache: { read: 600, write: 100 } } }]);
});

async function waitForText(read: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (read().includes(text)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${text}`);
}

test("the passive display renders the Codex event stream without owning the turn", async () => {
  const f = await fixture("complete");
  process.env.FORGE_ROOT_BINDING = "/contaminated/root";
  process.env.FORGE_ADVISOR_RESULT = "/contaminated/result";
  await writeFile(f.executable, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"${THREAD_ID}"}'
sleep 0.15
printf '%s\\n' '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"pnpm test","status":"in_progress"}}'
printf '%s' '{"type":"item.completed","item":{"id":"item_2","type":"agent_'
sleep 0.15
printf '%s\\n' 'message","text":"Reviewed the change."}}'
printf '%s\\n' 'plain stderr line' >&2
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1}}'
`, { mode: 0o700 });
  const output = new Map<string, string>();
  const commands: string[] = [];
  const shell = (id: string): PaneProcessInfo => ({ pane_id: id, shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["/bin/zsh"] }] });
  const processes = new Map<string, PaneProcessInfo>([["pane", shell("pane")]]);
  const herdr: Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> = {
    async getPane(id): Promise<Pane | null> { return { paneId: id, cwd: f.scope.directory }; },
    async getPaneProcessInfo(id) { return processes.get(id)!; },
    async createWorkspace() { throw new Error("The display reuses the pane"); },
    async splitPane() { throw new Error("The display reuses the pane"); },
    async renamePane() {}, async reportPaneMetadata() {},
    async runPaneCommand(id, command) {
      commands.push(command);
      output.set(id, "");
      const child = spawn("/bin/sh", ["-c", `exec ${command}`], { cwd: f.scope.directory, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (!child.pid) throw new Error("Display process did not start");
      displayProcesses.push({ child, processGroup: child.pid });
      child.stdout!.on("data", chunk => output.set(id, `${output.get(id) ?? ""}${String(chunk)}`));
      child.stderr!.on("data", chunk => output.set(id, `${output.get(id) ?? ""}${String(chunk)}`));
      const display = codexDisplayCommand(f.runtimeDirectory);
      processes.set(id, { pane_id: id, shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: child.pid, name: "node", argv: [display.executable, ...display.args] }] });
    },
  };
  const runtime = new CodexTaskRuntime(f.databasePath, herdr, { executable: f.executable });
  await runtime.ensureSession(f.scope, f.sessionID);

  expect(await runtime.attach({ scope: f.scope, nativeSessionId: f.sessionID, paneId: "pane", persistPane: () => {} })).toBe("pane");
  expect(commands[0]).toContain("'-u' 'FORGE_ROOT_BINDING'");
  expect(commands[0]).toContain("'-u' 'FORGE_ADVISOR_RESULT'");
  expect(commands[0]).not.toContain("contaminated");
  await waitForText(() => output.get("pane") ?? "", "Waiting for Codex output");
  expect(await runtime.attach({ scope: f.scope, nativeSessionId: f.sessionID, paneId: "pane", persistPane: () => {} })).toBe("pane");
  expect(commands).toHaveLength(1);

  await runtime.dispatch(f.scope, f.intent, async () => true);
  await waitForText(() => output.get("pane") ?? "", "$ pnpm test");
  await waitForText(() => output.get("pane") ?? "", "Reviewed the change.");
  await waitForText(() => output.get("pane") ?? "", "plain stderr line");
  expect(output.get("pane")).not.toContain("item.completed");

  const display = codexDisplayCommand(f.runtimeDirectory);
  expect(codexDisplayAttached(f.runtimeDirectory, [display.executable, ...display.args])).toBe(true);
  expect(codexDisplayAttached(join(f.root, "other-runtime"), [display.executable, ...display.args])).toBe(false);
  expect(codexDisplayAttached(f.runtimeDirectory, [f.executable, "exec", "--json"])).toBe(false);
});
