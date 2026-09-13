import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import type { HerdrClient, Pane, PaneProcessInfo } from "../src/integrations/herdr/client.js";
import { DevinTaskRuntime, devinArguments, devinDisplayAttached, devinSessionBusy, readDevinSessionId } from "../src/runtimes/devin/task-runtime.js";
import { createOpenCodePromptIntent } from "../src/runtimes/opencode/session.js";
import { DEVIN_PROVIDER, advisorBridgeResultPath, profileHarness, sessionHarness, taskSessionRuntimeDirectory, writeAdvisorReportBridgeBinding, type TaskScope } from "../src/runtimes/task-harness.js";
import { advisorReportFromTurn } from "../src/coordination/advisor-report.js";
import { initializeAndList, runMcpProcess } from "./helpers/mcp-process.js";
import { DevinSessionReader } from "../src/runtimes/devin/session-reader.js";
import type { TaskSession } from "../src/tasks/control.js";
import { runCommand } from "../src/platform/command-runner.js";

const directories: string[] = [];
async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommand({ taskId: null, stepId: null, command: "git", args, cwd })).stdout;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  for (const key of ["FORGE_ROOT_BINDING", "FORGE_ROOT_TOKEN", "FORGE_ADVISOR_BINDING", "FORGE_ADVISOR_TOKEN", "FORGE_ADVISOR_RESULT"]) delete process.env[key];
});

async function fixture(behaviour: "complete" | "hang" | "crash" | "startup_failure") {
  const root = await mkdtemp(join(tmpdir(), "forge-devin-runtime-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const executable = join(root, "devin");
  const script = { complete: ["echo 'Reviewed the change.'"], hang: ["echo 'Working'", "sleep 30"], crash: ["echo 'Working'", "exit 1"], startup_failure: ["echo 'Error: Not logged in' >&2", "exit 1"] }[behaviour];
  await writeFile(executable, `#!/bin/sh
if [ "$1" = list ]; then echo '[{"id":"assigned-session"}]'; exit 0; fi
printf '%s\n' '--TURN--' "$@" >> "$FORGE_TEST_ARGS"
printf '%s\n' "$MISE_TRUSTED_CONFIG_PATHS" > "$FORGE_TEST_MISE"
printf '%s|%s|%s|%s|%s\n' "$FORGE_ROOT_BINDING" "$FORGE_ROOT_TOKEN" "$FORGE_ADVISOR_BINDING" "$FORGE_ADVISOR_TOKEN" "$FORGE_ADVISOR_RESULT" >> "$FORGE_TEST_BRIDGE_ENV"
${script.join("\n")}
while [ "$#" -gt 0 ]; do
  if [ "$1" = --export ]; then shift; printf '%s\n' '{"schema_version":"ATIF-v1.7","session_id":"assigned-session"}' > "$1"; fi
  shift
done
`, { mode: 0o700 });
  process.env.FORGE_TEST_ARGS = join(root, "args.txt");
  process.env.FORGE_TEST_MISE = join(root, "mise.txt");
  process.env.FORGE_TEST_BRIDGE_ENV = join(root, "bridge-env.txt");
  const scope: TaskScope = { id: "session-devin", taskId: "task-devin", directory: worktree, role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile: { providerID: DEVIN_PROVIDER, modelID: "swe", reasoningEffort: "low", serviceTier: "default" } };
  const sessionID = "devin-71618050-0d31-428e-a547-d6c4a2eca88f";
  const runtime = new DevinTaskRuntime(join(root, "forge.sqlite"), {} as never, { executable });
  const intent = createOpenCodePromptIntent({ sessionID, directory: worktree, prompt: "Implement the change", model: { providerID: DEVIN_PROVIDER, modelID: "swe" }, agent: "forge-worker", variant: "low" });
  return { root, scope, runtime, intent, sessionID, runtimeDirectory: taskSessionRuntimeDirectory(join(root, "forge.sqlite"), scope.id) };
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
  const second = createOpenCodePromptIntent({ sessionID: f.sessionID, directory: f.scope.directory, prompt: "Check the change", model: { providerID: DEVIN_PROVIDER, modelID: "swe" }, agent: "forge-worker", variant: "low" });
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

test("the display attaches after a no-op warm-up materializes the Devin session", async () => {
  const f = await fixture("complete");
  process.env.FORGE_ROOT_BINDING = "/contaminated/root";
  process.env.FORGE_ROOT_TOKEN = "contaminated-root-token";
  process.env.FORGE_ADVISOR_BINDING = "/contaminated/advisor";
  process.env.FORGE_ADVISOR_TOKEN = "contaminated-advisor-token";
  process.env.FORGE_ADVISOR_RESULT = "/contaminated/result";
  const executable = join(f.root, "devin");
  const commands: string[] = [];
  const shell = (id: string): PaneProcessInfo => ({ pane_id: id, shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["/bin/zsh"] }] });
  const processes = new Map<string, PaneProcessInfo>([["pane", shell("pane")]]);
  const displayArgv = [executable, "--resume", "assigned-session", "--model", "swe", "--permission-mode", "dangerous", "--respect-workspace-trust", "false"];
  const herdr: Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> = {
    async getPane(id): Promise<Pane> { return { paneId: id, cwd: f.scope.directory, tokens: { forge_binding_id: f.scope.id } }; },
    async getPaneProcessInfo(id) { return processes.get(id)!; },
    async createWorkspace() { throw new Error("No workspace expected"); }, async splitPane() { throw new Error("No split expected"); },
    async renamePane() {}, async reportPaneMetadata() {},
    async runPaneCommand(id, command) { commands.push(command); processes.set(id, { pane_id: id, shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: 11, name: "devin", argv: displayArgv }] }); },
  };
  const runtime = new DevinTaskRuntime(join(f.root, "forge.sqlite"), herdr, { executable });
  await runtime.ensureSession(f.scope, f.sessionID);
  const attach = () => runtime.attach({ scope: f.scope, nativeSessionId: f.sessionID, paneId: "pane", persistPane: () => {} });
  expect(await attach()).toBe("pane");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("'--resume' 'assigned-session'");
  expect(commands[0]).toContain("'--model' 'swe'");
  expect(commands[0]).not.toContain("'--print'");
  expect(commands[0]).not.toContain("'--prompt-file'");
  expect(commands[0]).not.toContain("contaminated");
  expect(commands[0]).toContain("'-u' 'FORGE_ADVISOR_RESULT'");
  const turns = () => readFile(join(f.root, "args.txt"), "utf8").then(content => content.split("--TURN--\n").filter(Boolean).map(turn => turn.trim().split("\n")));
  expect(await turns()).toEqual([expect.arrayContaining(["--print", "--prompt-file", join(f.runtimeDirectory, "warmup.prompt")])]);
  expect(await attach()).toBe("pane");
  expect(await turns()).toHaveLength(1);
  await unlink(join(f.runtimeDirectory, "session.json"));
  expect(await attach()).toBe("pane");
  expect(await readDevinSessionId(f.runtimeDirectory)).toBe("assigned-session");
  expect(await turns()).toHaveLength(1);
  await runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  expect((await turns())[1]).toEqual(expect.arrayContaining(["--resume", "assigned-session"]));
  expect((await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("\n")).toEqual(["||||", "||||"]);
  expect(await attach()).toBe("pane");
  expect(commands).toHaveLength(1);
  expect((await readdir(f.runtimeDirectory)).filter(name => name.endsWith(".advisor-report.json"))).toEqual([]);
  expect(devinDisplayAttached(executable, "assigned-session", displayArgv)).toBe(true);
  expect(devinDisplayAttached(executable, "assigned-session", ["/other/devin", "--resume", "assigned-session"])).toBe(false);
  expect(devinDisplayAttached(executable, "assigned-session", [executable, "--resume", "other-session"])).toBe(false);
  expect(devinDisplayAttached(executable, "assigned-session", [executable, "--print", "--resume", "assigned-session"])).toBe(true);
});

test("a failed warm-up is not retried and the real turn still runs", async () => {
  const f = await fixture("crash");
  const runtime = new DevinTaskRuntime(join(f.root, "forge.sqlite"), {} as never, { executable: join(f.root, "devin") });
  await runtime.ensureSession(f.scope, f.sessionID);
  const attach = () => runtime.attach({ scope: f.scope, nativeSessionId: f.sessionID, paneId: null, persistPane: () => {} });
  await expect(attach()).rejects.toThrow("warm-up");
  await expect(attach()).rejects.toThrow("has not started");
  const turns = (await readFile(join(f.root, "args.txt"), "utf8")).split("--TURN--\n").filter(Boolean);
  expect(turns).toHaveLength(1);
  await runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "error", reason: "native_error" });
});

test("Devin routing is unambiguous and admits an authenticated Coordinator", async () => {
  const f = await fixture("complete");
  expect(profileHarness(DEVIN_PROVIDER)).toBe("devin");
  expect(sessionHarness(f.sessionID)).toBe("devin");
  expect(sessionHarness("71618050-0d31-428e-a547-d6c4a2eca88f")).toBe("claude-code");
  expect(sessionHarness("ses_abc")).toBe("opencode");
  await git(f.scope.directory, ["init", "-b", "main", f.scope.directory]);
  const rootScope: TaskScope = { ...f.scope, role: "root", identity: { taskId: "t", sessionId: "s", generation: 1 } };
  await expect(f.runtime.ensureSession(rootScope, null)).resolves.toMatch(/^devin-/);
  const config = JSON.parse(await readFile(join(f.scope.directory, ".devin", "mcp_config.local.json"), "utf8"));
  expect(Object.keys(config.mcpServers)).toEqual(["forge_root", "forge_advisor"]);
  expect(devinArguments({ scope: f.scope, resumeSessionId: null, promptFile: "/tmp/prompt" })).not.toContain("--resume");
});

test("root and concurrent Advisor sessions converge on one ignored invariant Devin config", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-devin-linked-worktree-"));
  directories.push(root);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  await git(root, ["init", "-b", "main", repository]);
  await git(root, ["-C", repository, "config", "user.name", "Forge test"]);
  await git(root, ["-C", repository, "config", "user.email", "forge@example.invalid"]);
  await git(root, ["-C", repository, "commit", "--allow-empty", "-m", "Initial"]);
  await git(root, ["-C", repository, "worktree", "add", "-b", "task", worktree]);
  await mkdir(join(worktree, ".devin"));
  await writeFile(join(worktree, ".devin", "mcp_config.local.json"), JSON.stringify({ mcpServers: { custom: { command: "/custom" }, forge_root: { command: "/stale" } }, customSetting: true }));
  const databasePath = join(root, "forge.sqlite");
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
  const profile = { providerID: DEVIN_PROVIDER, modelID: "swe", reasoningEffort: "low", serviceTier: "default" } as const;
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
  expect(Object.keys(config.mcpServers)).toEqual(["custom", "forge_root", "forge_advisor"]);
  expect(config.mcpServers.forge_root.env).toEqual({ FORGE_ROOT_BINDING: "${FORGE_ROOT_BINDING}", FORGE_ROOT_TOKEN: "${FORGE_ROOT_TOKEN}" });
  expect(config.mcpServers.forge_advisor.env).toEqual({ FORGE_ADVISOR_BINDING: "${FORGE_ADVISOR_BINDING}", FORGE_ADVISOR_TOKEN: "${FORGE_ADVISOR_TOKEN}" });
  expect(configText).not.toContain(firstRootBinding.token);
  expect(JSON.parse(await readFile(join(taskSessionRuntimeDirectory(databasePath, advisorA.id), "advisor.binding.json"), "utf8")).role).toBe("planner_a");
  expect(JSON.parse(await readFile(join(taskSessionRuntimeDirectory(databasePath, advisorB.id), "advisor.binding.json"), "utf8")).role).toBe("planner_b");
  const intentA = createOpenCodePromptIntent({ sessionID: "devin-a", directory: worktree, prompt: "Write plan A", model: { providerID: DEVIN_PROVIDER, modelID: "swe" }, agent: "forge-advisor", variant: "low" });
  const intentB = createOpenCodePromptIntent({ sessionID: "devin-b", directory: worktree, prompt: "Write plan B", model: { providerID: DEVIN_PROVIDER, modelID: "swe" }, agent: "forge-advisor", variant: "low" });
  const rootIntent = createOpenCodePromptIntent({ sessionID: "devin-root", directory: worktree, prompt: "Coordinate", model: { providerID: DEVIN_PROVIDER, modelID: "swe" }, agent: "forge-root", variant: "low" });
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
  expect(Object.keys(JSON.parse(await readFile(configPath, "utf8")).mcpServers)).toEqual(["forge_root", "forge_advisor"]);
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
  expect(observation).toMatchObject({ state: "completed", native: { mode: "forge-advisor", agent: "forge-advisor" } });
  const dispatchEnvironment = (await readFile(join(f.root, "bridge-env.txt"), "utf8")).trim().split("|");
  expect(dispatchEnvironment[0]).toBe("");
  expect(dispatchEnvironment[1]).toBe("");
  expect(dispatchEnvironment[2]).toBe(join(f.runtimeDirectory, "advisor.binding.json"));
  expect(dispatchEnvironment[3]).toMatch(/^[0-9a-f-]{36}$/);
  expect(dispatchEnvironment[4]).toBe(advisorBridgeResultPath(f.runtimeDirectory, f.intent.messageID));
  const server = await writeAdvisorReportBridgeBinding({ runtimeDirectory: f.runtimeDirectory, role: "rater" });
  const resultPath = advisorBridgeResultPath(f.runtimeDirectory, f.intent.messageID);
  const submission = { rating: 10, blockingFindings: [], verification: "passed", verificationSummary: "Focused tests passed", summary: "Ready" };
  await runMcpProcess(server, { ...process.env, ...server.environment, FORGE_ADVISOR_RESULT: resultPath }, [
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
  const retainedEvidence = await new DevinSessionReader(join(f.root, "forge.sqlite")).turnEvidence(session, f.intent.messageID);
  expect(advisorReportFromTurn("rater", retainedEvidence.tools, text)).toMatchObject({ result: { role: "rater", rating: 10 } });
});
