// eslint-disable-next-line no-restricted-imports -- the regression owns and stops a long-running display process group.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import type { HerdrClient, Pane, PaneProcessInfo } from "../src/integrations/herdr/client.js";
import { DevinTaskRuntime, devinArguments, devinSessionBusy, readDevinSessionId } from "../src/runtimes/devin/task-runtime.js";
import { devinDisplayAttached, devinDisplayCommand } from "../src/runtimes/devin/display.js";
import { createOpenCodePromptIntent } from "../src/runtimes/opencode/session.js";
import { advisorBridgeResultPath, profileHarness, sessionHarness, taskSessionRuntimeDirectory, writeAdvisorReportBridgeBinding, type TaskScope } from "../src/runtimes/task-harness.js";
import { advisorReportFromTurn } from "../src/coordination/advisor-report.js";
import { initializeAndList, runMcpProcess } from "./helpers/mcp-process.js";
import { DevinSessionReader } from "../src/runtimes/devin/session-reader.js";
import type { TaskSession } from "../src/tasks/control.js";
import { runCommand } from "../src/platform/command-runner.js";

const directories: string[] = [];
const displayProcesses: { child: ChildProcess; processGroup: number }[] = [];
async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommand({ taskId: null, stepId: null, command: "git", args, cwd })).stdout;
}
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
  for (const key of ["SUPLEX_ROOT_BINDING", "SUPLEX_ROOT_TOKEN", "SUPLEX_ADVISOR_BINDING", "SUPLEX_ADVISOR_TOKEN", "SUPLEX_ADVISOR_RESULT", "SUPLEX_GH_COMMAND", "SUPLEX_TEST_LOCK_ROOT", "SUPLEX_TEST_INVOCATIONS"]) delete process.env[key];
});

async function fixture(behaviour: "complete" | "hang" | "silent_hang" | "crash" | "startup_failure") {
  const root = await mkdtemp(join(tmpdir(), "suplex-devin-runtime-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const executable = join(root, "devin");
  const script = { complete: ["echo 'Reviewed the change.'"], hang: ["echo 'Working'", "sleep 30"], silent_hang: ["sleep 30"], crash: ["echo 'Working'", "exit 1"], startup_failure: ["echo 'Error: Not logged in' >&2", "exit 1"] }[behaviour];
  await writeFile(executable, `#!/bin/sh
if [ "$1" = list ]; then echo '[{"id":"assigned-session"}]'; exit 0; fi
printf '%s\n' '--TURN--' "$@" >> "$SUPLEX_TEST_ARGS"
printf '%s\n' "$MISE_TRUSTED_CONFIG_PATHS" > "$SUPLEX_TEST_MISE"
printf '%s|%s|%s|%s|%s\n' "$SUPLEX_ROOT_BINDING" "$SUPLEX_ROOT_TOKEN" "$SUPLEX_ADVISOR_BINDING" "$SUPLEX_ADVISOR_TOKEN" "$SUPLEX_ADVISOR_RESULT" >> "$SUPLEX_TEST_BRIDGE_ENV"
${script.join("\n")}
while [ "$#" -gt 0 ]; do
  if [ "$1" = --export ]; then shift; printf '%s\n' '{"schema_version":"ATIF-v1.7","session_id":"assigned-session"}' > "$1"; fi
  shift
done
`, { mode: 0o700 });
  process.env.SUPLEX_TEST_ARGS = join(root, "args.txt");
  process.env.SUPLEX_TEST_MISE = join(root, "mise.txt");
  process.env.SUPLEX_TEST_BRIDGE_ENV = join(root, "bridge-env.txt");
  const scope: TaskScope = { id: "session-devin", taskId: "task-devin", directory: worktree, role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile: { providerID: "devin", modelID: "swe", reasoningEffort: "low", serviceTier: "default" } };
  const sessionID = "devin-71618050-0d31-428e-a547-d6c4a2eca88f";
  const runtime = new DevinTaskRuntime(join(root, "suplex.sqlite"), {} as never, { executable });
  const intent = createOpenCodePromptIntent({ sessionID, directory: worktree, prompt: "Implement the change", model: { providerID: "devin", modelID: "swe" }, agent: "suplex-worker", variant: "low" });
  return { root, scope, runtime, intent, sessionID, runtimeDirectory: taskSessionRuntimeDirectory(join(root, "suplex.sqlite"), scope.id) };
}

async function eventually(f: Awaited<ReturnType<typeof fixture>>, intent = f.intent, scope: TaskScope = f.scope) {
  let observed = await f.runtime.observe(scope, { ...intent, dispatch: "ambiguous" });
  for (let attempt = 0; attempt < 50 && observed.state === "running"; attempt += 1) {
    await delay(100);
    observed = await f.runtime.observe(scope, { ...intent, dispatch: "ambiguous" });
  }
  return observed;
}

test("Devin starts without resume, persists its assigned id, then resumes", async () => {
  const f = await fixture("complete");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  expect(await readdir(f.scope.directory)).not.toContain(".devin");
  expect(await readdir(f.runtimeDirectory)).not.toContain("root.binding.json");
  expect(await readdir(f.runtimeDirectory)).not.toContain("advisor.binding.json");
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed", native: { providerID: "devin" } });
  expect(await readDevinSessionId(f.runtimeDirectory)).toBe("assigned-session");
  await unlink(join(f.runtimeDirectory, "session.json"));
  await f.runtime.ensureSession(f.scope, f.sessionID);
  expect(await readDevinSessionId(f.runtimeDirectory)).toBe("assigned-session");
  const second = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Check the change", model: { providerID: "devin", modelID: "swe" }, agent: "suplex-worker", variant: "low" });
  await f.runtime.dispatch(f.scope, second, async () => true);
  expect(await eventually(f, second)).toMatchObject({ state: "completed" });
  const turns = (await readFile(join(f.root, "args.txt"), "utf8")).split("--TURN--\n").filter(Boolean).map(turn => turn.trim().split("\n"));
  expect(turns[0]).toEqual(expect.arrayContaining(["--print", "--prompt-file", "--model", "swe", "--permission-mode", "dangerous", "--respect-workspace-trust", "false"]));
  expect(turns[0]).not.toContain("--resume");
  expect(turns[1]).toEqual(expect.arrayContaining(["--resume", "assigned-session"]));
  expect(await readFile(join(f.root, "mise.txt"), "utf8")).toContain(f.scope.directory);
  expect(await readFile(join(f.runtimeDirectory, `turn-${f.intent.messageID}.prompt`), "utf8")).toBe(`${taskRolePrompt("worker", { workflow: "standard", workerMode: "planned", purpose: "implementation" })}\n\nImplement the change`);
});

test("a hanging Devin turn is busy until stopped", async () => {
  const f = await fixture("hang");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await devinSessionBusy(f.runtimeDirectory)).toBe(true);
  await f.runtime.stop(f.scope, f.sessionID);
  expect(await devinSessionBusy(f.runtimeDirectory)).toBe(false);
});

test("non-zero turns are errors and startup failures retain stderr", async () => {
  const crash = await fixture("crash");
  await crash.runtime.ensureSession(crash.scope, crash.sessionID);
  await crash.runtime.dispatch(crash.scope, crash.intent, async () => true);
  expect(await eventually(crash)).toMatchObject({ state: "error", reason: "native_error" });
  const failed = await fixture("startup_failure");
  await failed.runtime.ensureSession(failed.scope, failed.sessionID);
  await failed.runtime.dispatch(failed.scope, failed.intent, async () => true);
  const observed = await eventually(failed);
  expect(observed).toMatchObject({ state: "error", reason: "native_startup_failed" });
  expect(await failed.runtime.resultText(failed.scope, observed)).toContain("Not logged in");
});

test("Devin timeline keeps completed execution time when the output log changes", async () => {
  const f = await fixture("complete");
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  const session = { id: f.scope.id, nativeSessionId: f.sessionID, kind: "worker" as const };
  const reader = new DevinSessionReader(join(f.root, "suplex.sqlite"));
  const files = { prompt: join(f.runtimeDirectory, `turn-${f.intent.messageID}.prompt`), log: join(f.runtimeDirectory, `turn-${f.intent.messageID}.jsonl`), exit: join(f.runtimeDirectory, `turn-${f.intent.messageID}.exit`) };
  const first = (await reader.timeline(session)).usage[0];
  expect(first).toBeDefined();
  expect(first?.startedAt).toBeLessThanOrEqual(Math.trunc((await stat(files.prompt)).mtimeMs));
  expect(first?.completedAt).toBe(Math.trunc((await stat(files.exit)).mtimeMs));
  await utimes(files.log, new Date(), new Date(Date.now() + 60_000));
  expect((await reader.timeline(session)).usage[0]).toMatchObject({ startedAt: first?.startedAt, completedAt: first?.completedAt, failed: false });
  await unlink(files.prompt);
  const dispatch = (await readdir(f.runtimeDirectory)).find(name => /^dispatch-.*\.json$/.test(name));
  if (!dispatch) throw new Error("Missing dispatch record");
  const dispatchStat = await stat(join(f.runtimeDirectory, dispatch));
  expect((await reader.timeline(session)).usage[0]?.startedAt).toBe(Math.trunc(dispatchStat.birthtimeMs > 0 ? dispatchStat.birthtimeMs : dispatchStat.mtimeMs));
});

test("Devin timeline identifies the running silent dispatch without turn.json or output ordering", async () => {
  const f = await fixture("silent_hang");
  const completedId = "zzzz-completed";
  await mkdir(f.runtimeDirectory, { recursive: true });
  await writeFile(join(f.runtimeDirectory, `turn-${completedId}.prompt`), "Earlier request");
  await writeFile(join(f.runtimeDirectory, `turn-${completedId}.jsonl`), "Earlier answer");
  await writeFile(join(f.runtimeDirectory, `turn-${completedId}.exit`), "0\n");
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  try {
    const session = { id: f.scope.id, nativeSessionId: f.sessionID, kind: "worker" as const };
    const reader = new DevinSessionReader(join(f.root, "suplex.sqlite"));
    await writeFile(join(f.runtimeDirectory, `turn-${f.intent.messageID}.exit`), "0\n");
    const first = await reader.timeline(session);
    expect(first.liveMessageId).toBe(f.intent.messageID);
    expect(first.usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: completedId, completedAt: expect.any(Number), failed: false }),
      expect.objectContaining({ messageId: f.intent.messageID, completedAt: null, failed: false }),
    ]));
    const startedAt = first.usage.find(turn => turn.messageId === f.intent.messageID)?.startedAt;
    await writeFile(join(f.runtimeDirectory, `turn-${f.intent.messageID}.jsonl`), "New output");
    await unlink(join(f.runtimeDirectory, "turn.json"));
    const afterMissing = await reader.timeline(session);
    expect(afterMissing.liveMessageId).toBe(f.intent.messageID);
    expect(afterMissing.usage.find(turn => turn.messageId === f.intent.messageID)?.startedAt).toBe(startedAt);
    const dispatch = (await readdir(f.runtimeDirectory)).find(name => /^dispatch-.*\.json$/.test(name));
    if (!dispatch) throw new Error("Missing dispatch record");
    await writeFile(join(f.runtimeDirectory, "turn.json"), await readFile(join(f.runtimeDirectory, dispatch)));
    expect((await reader.timeline(session)).liveMessageId).toBe(f.intent.messageID);
  } finally {
    const dispatch = (await readdir(f.runtimeDirectory)).find(name => /^dispatch-.*\.json$/.test(name));
    if (dispatch) await writeFile(join(f.runtimeDirectory, "turn.json"), await readFile(join(f.runtimeDirectory, dispatch)));
    await f.runtime.stop(f.scope, f.sessionID);
  }
});

test("Devin timeline records failures and leaves a turn without exit evidence incomplete", async () => {
  const f = await fixture("crash");
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "error" });
  const session = { id: f.scope.id, nativeSessionId: f.sessionID, kind: "worker" as const };
  const reader = new DevinSessionReader(join(f.root, "suplex.sqlite"));
  expect((await reader.timeline(session)).usage).toEqual([expect.objectContaining({ failed: true, completedAt: expect.any(Number) })]);
  await unlink(join(f.runtimeDirectory, `turn-${f.intent.messageID}.exit`));
  expect((await reader.timeline(session)).usage).toEqual([expect.objectContaining({ failed: false, completedAt: null })]);
});

async function waitForText(read: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (read().includes(text)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${text}`);
}

test("the passive display follows two exclusively locked Devin turns without owning the native session", async () => {
  const f = await fixture("complete");
  process.env.SUPLEX_ROOT_BINDING = "/contaminated/root";
  process.env.SUPLEX_ROOT_TOKEN = "contaminated-root-token";
  process.env.SUPLEX_ADVISOR_BINDING = "/contaminated/advisor";
  process.env.SUPLEX_ADVISOR_TOKEN = "contaminated-advisor-token";
  process.env.SUPLEX_ADVISOR_RESULT = "/contaminated/result";
  const executable = join(f.root, "devin");
  const lockRoot = join(f.root, "locks");
  const invocationLog = join(f.root, "invocations.txt");
  await mkdir(lockRoot);
  await writeFile(executable, `#!/bin/sh
print=false
resume=
prompt_file=
export_file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) print=true ;;
    --resume) shift; resume=$1 ;;
    --prompt-file) shift; prompt_file=$1 ;;
    --export) shift; export_file=$1 ;;
  esac
  shift
done
session=\${resume:-assigned-session}
if ! mkdir "$SUPLEX_TEST_LOCK_ROOT/$session" 2>/dev/null; then
  printf '%s\n' "LOCKED:$session" >&2
  exit 1
fi
cleanup() { rmdir "$SUPLEX_TEST_LOCK_ROOT/$session" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' INT TERM
if [ "$print" != true ]; then
  printf '%s\n' "interactive:$session" >> "$SUPLEX_TEST_INVOCATIONS"
  while :; do sleep 1; done
fi
printf '%s\n' "print:$session" >> "$SUPLEX_TEST_INVOCATIONS"
printf '%s|%s|%s|%s|%s\n' "$SUPLEX_ROOT_BINDING" "$SUPLEX_ROOT_TOKEN" "$SUPLEX_ADVISOR_BINDING" "$SUPLEX_ADVISOR_TOKEN" "$SUPLEX_ADVISOR_RESULT" >> "$SUPLEX_TEST_BRIDGE_ENV"
if grep -q 'Check the change' "$prompt_file"; then label=SECOND; else label=FIRST; fi
printf '%s stdout\n' "$label"
sleep 0.15
printf '%s stderr\n' "$label" >&2
sleep 0.15
printf '%s\n' '{"schema_version":"ATIF-v1.7","session_id":"assigned-session"}' > "$export_file"
`, { mode: 0o700 });
  process.env.SUPLEX_TEST_LOCK_ROOT = lockRoot;
  process.env.SUPLEX_TEST_INVOCATIONS = invocationLog;
  const commands: string[] = [];
  const output = new Map<string, string>();
  const shell = (id: string): PaneProcessInfo => ({ pane_id: id, shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["/bin/zsh"] }] });
  const processes = new Map<string, PaneProcessInfo>([["pane", shell("pane")]]);
  const panes = new Set(["pane"]);
  let nextPane = 1;
  const herdr: Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> = {
    async getPane(id): Promise<Pane | null> { return panes.has(id) ? { paneId: id, cwd: f.scope.directory } : null; },
    async getPaneProcessInfo(id) { return processes.get(id)!; },
    async createWorkspace() {
      const paneId = `replacement-${nextPane++}`;
      panes.add(paneId);
      processes.set(paneId, shell(paneId));
      return { workspace: { workspaceId: "workspace", label: "task" }, tab: { tabId: "tab", label: "task" }, rootPane: { paneId, cwd: f.scope.directory } };
    },
    async splitPane() {
      const paneId = `replacement-${nextPane++}`;
      panes.add(paneId);
      processes.set(paneId, shell(paneId));
      return { paneId, cwd: f.scope.directory };
    },
    async renamePane() {}, async reportPaneMetadata() {},
    async runPaneCommand(id, command) {
      commands.push(command);
      output.set(id, "");
      const child = spawn("/bin/sh", ["-c", `exec ${command}`], { cwd: f.scope.directory, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (!child.pid) throw new Error("Display process did not start");
      displayProcesses.push({ child, processGroup: child.pid });
      child.stdout!.on("data", chunk => output.set(id, `${output.get(id) ?? ""}${String(chunk)}`));
      child.stderr!.on("data", chunk => output.set(id, `${output.get(id) ?? ""}${String(chunk)}`));
      const display = devinDisplayCommand(f.runtimeDirectory);
      processes.set(id, { pane_id: id, shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: child.pid, name: "node", argv: [display.executable, ...display.args] }] });
    },
  };
  const runtime = new DevinTaskRuntime(join(f.root, "suplex.sqlite"), herdr, { executable });
  await runtime.ensureSession(f.scope, f.sessionID);
  const attach = (paneId: string | null) => runtime.attach({ scope: f.scope, nativeSessionId: f.sessionID, paneId, persistPane: () => {} });
  expect(await readFile(invocationLog, "utf8").catch(() => "")).toBe("");
  expect(await attach("pane")).toBe("pane");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("'-u' 'SUPLEX_ROOT_BINDING'");
  expect(commands[0]).toContain("'-u' 'SUPLEX_ADVISOR_RESULT'");
  expect(commands[0]).not.toContain("contaminated");
  expect(await readFile(invocationLog, "utf8").catch(() => "")).toBe("");
  await waitForText(() => output.get("pane") ?? "", "Waiting for Devin output");
  expect(await attach("pane")).toBe("pane");
  expect(commands).toHaveLength(1);
  await runtime.dispatch(f.scope, f.intent, async () => true);
  await waitForText(() => output.get("pane") ?? "", "FIRST stdout");
  panes.delete("pane");
  const replacement = await attach("pane");
  expect(replacement).toBe("replacement-2");
  await waitForText(() => output.get(replacement) ?? "", "FIRST stdout");
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  await waitForText(() => output.get(replacement) ?? "", "FIRST stderr");
  const second = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Check the change", model: { providerID: "devin", modelID: "swe" }, agent: "suplex-worker", variant: "low" });
  await runtime.dispatch(f.scope, second, async () => true);
  expect(await eventually(f, second)).toMatchObject({ state: "completed" });
  await waitForText(() => output.get(replacement) ?? "", "SECOND stderr");
  expect(output.get(replacement)?.match(/FIRST stdout/g)).toHaveLength(1);
  expect(output.get(replacement)?.match(/FIRST stderr/g)).toHaveLength(1);
  expect(output.get(replacement)?.match(/SECOND stdout/g)).toHaveLength(1);
  expect(output.get(replacement)?.match(/SECOND stderr/g)).toHaveLength(1);
  expect((await readFile(invocationLog, "utf8")).trim().split("\n")).toEqual(["print:assigned-session", "print:assigned-session"]);
  expect((await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("\n")).toEqual(["||||", "||||"]);
  const display = devinDisplayCommand(f.runtimeDirectory);
  expect(devinDisplayAttached(f.runtimeDirectory, [display.executable, ...display.args])).toBe(true);
  expect(devinDisplayAttached(join(f.root, "other-runtime"), [display.executable, ...display.args])).toBe(false);
  expect(devinDisplayAttached(f.runtimeDirectory, [executable, "--resume", "assigned-session"])).toBe(false);
});

test("Devin routing is unambiguous and admits an authenticated Coordinator", async () => {
  const f = await fixture("complete");
  expect(profileHarness("devin")).toBe("devin");
  expect(sessionHarness(f.sessionID)).toBe("devin");
  expect(sessionHarness("71618050-0d31-428e-a547-d6c4a2eca88f")).toBe("claude-code");
  expect(sessionHarness("ses_abc")).toBe("opencode");
  await git(f.scope.directory, ["init", "-b", "main", f.scope.directory]);
  const rootScope: TaskScope = { ...f.scope, role: "root", identity: { taskId: "t", sessionId: "s", generation: 1 } };
  await expect(f.runtime.ensureSession(rootScope, null)).resolves.toMatch(/^devin-/);
  const config = JSON.parse(await readFile(join(f.scope.directory, ".devin", "mcp_config.local.json"), "utf8"));
  expect(Object.keys(config.mcpServers)).toEqual(["suplex_root", "suplex_advisor"]);
  expect(devinArguments({ scope: f.scope, resumeSessionId: null, promptFile: "/tmp/prompt" })).not.toContain("--resume");
});

test("root and concurrent Advisor sessions converge on one ignored invariant Devin config", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-devin-linked-worktree-"));
  directories.push(root);
  const fakeGh = join(root, "gh");
  await writeFile(fakeGh, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env.SUPLEX_GH_COMMAND = fakeGh;
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  await git(root, ["init", "-b", "main", repository]);
  await git(root, ["-C", repository, "config", "user.name", "Suplex test"]);
  await git(root, ["-C", repository, "config", "user.email", "suplex@example.invalid"]);
  await git(root, ["-C", repository, "commit", "--allow-empty", "-m", "Initial"]);
  await git(root, ["-C", repository, "worktree", "add", "-b", "task", worktree]);
  await mkdir(join(worktree, ".devin"));
  await writeFile(join(worktree, ".devin", "mcp_config.local.json"), JSON.stringify({ mcpServers: { custom: { command: "/custom" }, suplex_root: { command: "/stale" } }, customSetting: true }));
  const databasePath = join(root, "suplex.sqlite");
  const executable = join(root, "devin");
  await writeFile(executable, `#!/bin/sh
export_path=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --export ]; then shift; export_path=$1; fi
  shift
done
session_id=$(basename "$(dirname "$export_path")")
printf '%s\n' 'Plain completion prose.'
printf '{"schema_version":"ATIF-v1.7","session_id":"%s"}\n' "$session_id" > "$export_path"
`, { mode: 0o700 });
  const runtime = new DevinTaskRuntime(databasePath, {} as never, { executable, artifactRoot: join(root, "artifacts") });
  const profile = { providerID: "devin", modelID: "swe", reasoningEffort: "low", serviceTier: "default" } as const;
  const common = { taskId: "task", directory: worktree, profile, workflow: "competing_plans" as const, evidenceRoot: join(root, "evidence") };
  const rootScope: TaskScope = { ...common, id: "root-session", role: "root", identity: { taskId: "task", sessionId: "root-session", generation: 1 } };
  const advisorA: TaskScope = { ...common, id: "advisor-a", role: "advisor", advisorRole: "planner_a", label: "Plan A" };
  const advisorB: TaskScope = { ...common, id: "advisor-b", role: "advisor", advisorRole: "planner_b", label: "Plan B" };
  await Promise.all([runtime.ensureSession(rootScope, null), runtime.ensureSession(advisorA, null), runtime.ensureSession(advisorB, null)]);
  const rootBindingPath = join(taskSessionRuntimeDirectory(databasePath, rootScope.id), "root.binding.json");
  const firstRootBinding = JSON.parse(await readFile(rootBindingPath, "utf8"));
  await runtime.ensureSession(rootScope, null);
  expect(JSON.parse(await readFile(rootBindingPath, "utf8")).token).toBe(firstRootBinding.token);
  const configPath = join(worktree, ".devin", "mcp_config.local.json");
  const configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText);
  expect(config.customSetting).toBe(true);
  expect(config.mcpServers.custom).toEqual({ command: "/custom" });
  expect(Object.keys(config.mcpServers)).toEqual(["custom", "suplex_root", "suplex_advisor"]);
  expect(config.mcpServers.suplex_root.env).toMatchObject({ SUPLEX_ROOT_BINDING: "${SUPLEX_ROOT_BINDING}", SUPLEX_ROOT_TOKEN: "${SUPLEX_ROOT_TOKEN}", SUPLEX_GH_COMMAND: fakeGh });
  expect(config.mcpServers.suplex_advisor.env).toMatchObject({ SUPLEX_ADVISOR_BINDING: "${SUPLEX_ADVISOR_BINDING}", SUPLEX_ADVISOR_TOKEN: "${SUPLEX_ADVISOR_TOKEN}", SUPLEX_GH_COMMAND: fakeGh });
  expect(config.mcpServers.suplex_root.env.SUPLEX_GH_COMMAND).toBe(config.mcpServers.suplex_advisor.env.SUPLEX_GH_COMMAND);
  expect(configText).not.toContain(firstRootBinding.token);
  expect(JSON.parse(await readFile(join(taskSessionRuntimeDirectory(databasePath, advisorA.id), "advisor.binding.json"), "utf8")).role).toBe("planner_a");
  expect(JSON.parse(await readFile(join(taskSessionRuntimeDirectory(databasePath, advisorB.id), "advisor.binding.json"), "utf8")).role).toBe("planner_b");
  const intentA = createOpenCodePromptIntent({ sessionID: "devin-a", directory: worktree, prompt: "Write plan A", model: { providerID: "devin", modelID: "swe" }, agent: "suplex-advisor", variant: "low" });
  const intentB = createOpenCodePromptIntent({ sessionID: "devin-b", directory: worktree, prompt: "Write plan B", model: { providerID: "devin", modelID: "swe" }, agent: "suplex-advisor", variant: "low" });
  const rootIntent = createOpenCodePromptIntent({ sessionID: "devin-root", directory: worktree, prompt: "Coordinate", model: { providerID: "devin", modelID: "swe" }, agent: "suplex-root", variant: "low" });
  await Promise.all([runtime.dispatch(rootScope, rootIntent, async () => true), runtime.dispatch(advisorA, intentA, async () => true), runtime.dispatch(advisorB, intentB, async () => true)]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [observedRoot, observedA, observedB] = await Promise.all([runtime.observe(rootScope, { ...rootIntent, dispatch: "ambiguous" }), runtime.observe(advisorA, { ...intentA, dispatch: "ambiguous" }), runtime.observe(advisorB, { ...intentB, dispatch: "ambiguous" })]);
    if (observedRoot.state !== "running" && observedA.state !== "running" && observedB.state !== "running") break;
    await delay(50);
  }
  expect(await readDevinSessionId(taskSessionRuntimeDirectory(databasePath, advisorA.id))).toBe("advisor-a");
  expect(await readDevinSessionId(taskSessionRuntimeDirectory(databasePath, advisorB.id))).toBe("advisor-b");
  expect(await readDevinSessionId(taskSessionRuntimeDirectory(databasePath, rootScope.id))).toBe("root-session");
  await unlink(configPath);
  await runtime.ensureSession(advisorA, null);
  expect(Object.keys(JSON.parse(await readFile(configPath, "utf8")).mcpServers)).toEqual(["suplex_root", "suplex_advisor"]);
  const commonDirectory = (await git(worktree, ["rev-parse", "--git-common-dir"])).trim();
  const absoluteCommonDirectory = commonDirectory.startsWith("/") ? commonDirectory : join(worktree, commonDirectory);
  await writeFile(`${configPath}.interrupted.pending`, "partial");
  await writeFile(join(worktree, "unrelated.txt"), "dirty");
  const status = (await git(worktree, ["status", "--short", "--untracked-files=all"])).trim().split("\n");
  expect(status).toEqual(["?? unrelated.txt"]);
  const exclude = await readFile(join(absoluteCommonDirectory, "info", "exclude"), "utf8");
  expect(exclude.split(/\r?\n/).filter(line => line === "/.devin/mcp_config.local.json*")).toHaveLength(1);
});

test("a captured Advisor bridge result completes a Devin turn with non-JSON prose and survives reader recovery", async () => {
  const f = await fixture("complete");
  await git(f.scope.directory, ["init", "-b", "main", f.scope.directory]);
  const scope: TaskScope = { ...f.scope, role: "advisor", advisorRole: "rater", label: "Rater", workflow: "refine_pull_request" };
  await f.runtime.ensureSession(scope, f.sessionID);
  await f.runtime.dispatch(scope, f.intent, async () => true);
  const observation = await eventually(f, f.intent, scope);
  expect(observation).toMatchObject({ state: "completed", native: { mode: "suplex-advisor", agent: "suplex-advisor" } });
  const dispatchEnvironment = (await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("|");
  expect(dispatchEnvironment[0]).toBe("");
  expect(dispatchEnvironment[1]).toBe("");
  expect(dispatchEnvironment[2]).toBe(join(f.runtimeDirectory, "advisor.binding.json"));
  expect(dispatchEnvironment[3]).toMatch(/^[0-9a-f-]{36}$/);
  expect(dispatchEnvironment[4]).toBe(advisorBridgeResultPath(f.runtimeDirectory, f.intent.messageID));
  const server = await writeAdvisorReportBridgeBinding({ runtimeDirectory: f.runtimeDirectory, role: "rater" });
  const resultPath = advisorBridgeResultPath(f.runtimeDirectory, f.intent.messageID);
  const submission = { rating: 10, blockingFindings: [], verification: "passed", verificationSummary: "Focused tests passed", summary: "Ready" };
  await runMcpProcess(server, { ...process.env, ...server.environment, SUPLEX_ADVISOR_RESULT: resultPath }, [
    ...initializeAndList,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit_report", arguments: submission } },
  ]);
  const text = await f.runtime.resultText(scope, observation);
  expect(text).toBe("Reviewed the change.");
  const liveEvidence = await f.runtime.turnEvidence(scope, observation);
  expect(advisorReportFromTurn("rater", liveEvidence.tools, text)).toMatchObject({ result: { role: "rater", rating: 10 } });
  const session = {
    id: scope.id, taskId: scope.taskId, kind: "worker", generation: 1, current: true, paneId: null, nativeSessionId: f.sessionID,
    lifecycle: "live", assignmentHash: null, launchOwner: null, launchOwnerPid: null, launchOwnerStartTime: null,
    stopRequestedAt: null, stoppedAt: null, advisorRole: "rater", workflowInput: null,
  } satisfies TaskSession;
  const retainedEvidence = await new DevinSessionReader(join(f.root, "suplex.sqlite")).turnEvidence(session, f.intent.messageID);
  expect(advisorReportFromTurn("rater", retainedEvidence.tools, text)).toMatchObject({ result: { role: "rater", rating: 10 } });
});
