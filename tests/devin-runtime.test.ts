import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import type { HerdrClient, Pane, PaneProcessInfo } from "../src/integrations/herdr/client.js";
import { DevinTaskRuntime, devinArguments, devinDisplayAttached, devinSessionBusy, readDevinSessionId } from "../src/runtimes/devin/task-runtime.js";
import { createOpenCodePromptIntent } from "../src/runtimes/opencode/session.js";
import { DEVIN_PROVIDER, profileHarness, sessionHarness, taskSessionRuntimeDirectory, type TaskScope } from "../src/runtimes/task-harness.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

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
${script.join("\n")}
`, { mode: 0o700 });
  process.env.FORGE_TEST_ARGS = join(root, "args.txt");
  process.env.FORGE_TEST_MISE = join(root, "mise.txt");
  const scope: TaskScope = { id: "session-devin", taskId: "task-devin", directory: worktree, role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile: { providerID: DEVIN_PROVIDER, modelID: "swe", reasoningEffort: "low", serviceTier: "default" } };
  const sessionID = "devin-71618050-0d31-428e-a547-d6c4a2eca88f";
  const runtime = new DevinTaskRuntime(join(root, "forge.sqlite"), {} as never, { executable });
  const intent = createOpenCodePromptIntent({ sessionID, directory: worktree, prompt: "Implement the change", model: { providerID: DEVIN_PROVIDER, modelID: "swe" }, agent: "forge-worker", variant: "low" });
  return { root, scope, runtime, intent, sessionID, runtimeDirectory: taskSessionRuntimeDirectory(join(root, "forge.sqlite"), scope.id) };
}

async function eventually(f: Awaited<ReturnType<typeof fixture>>, intent = f.intent) {
  let observed = await f.runtime.observe(f.scope, { ...intent, dispatch: "ambiguous" });
  for (let attempt = 0; attempt < 50 && observed.state === "running"; attempt += 1) {
    await delay(100);
    observed = await f.runtime.observe(f.scope, { ...intent, dispatch: "ambiguous" });
  }
  return observed;
}

test("Devin starts without resume, persists its assigned id, then resumes", async () => {
  const f = await fixture("complete");
  await f.runtime.ensureSession(f.scope, f.sessionID);
  await f.runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed", native: { providerID: "devin" } });
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

test("the display resumes the persisted Devin session in a Herdr pane only after the first turn", async () => {
  const f = await fixture("complete");
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
  await expect(attach()).rejects.toThrow("has not started");
  await runtime.dispatch(f.scope, f.intent, async () => true);
  expect(await eventually(f)).toMatchObject({ state: "completed" });
  expect(await attach()).toBe("pane");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("'--resume' 'assigned-session'");
  expect(commands[0]).toContain("'--model' 'swe'");
  expect(commands[0]).not.toContain("'--print'");
  expect(commands[0]).not.toContain("'--prompt-file'");
  expect(await attach()).toBe("pane");
  expect(commands).toHaveLength(1);
  expect(devinDisplayAttached(executable, "assigned-session", displayArgv)).toBe(true);
  expect(devinDisplayAttached(executable, "assigned-session", ["/other/devin", "--resume", "assigned-session"])).toBe(false);
  expect(devinDisplayAttached(executable, "assigned-session", [executable, "--resume", "other-session"])).toBe(false);
  expect(devinDisplayAttached(executable, "assigned-session", [executable, "--print", "--resume", "assigned-session"])).toBe(true);
});

test("Devin routing is unambiguous and worker-only", async () => {
  const f = await fixture("complete");
  expect(profileHarness(DEVIN_PROVIDER)).toBe("devin");
  expect(sessionHarness(f.sessionID)).toBe("devin");
  expect(sessionHarness("71618050-0d31-428e-a547-d6c4a2eca88f")).toBe("claude-code");
  expect(sessionHarness("ses_abc")).toBe("opencode");
  await expect(f.runtime.ensureSession({ ...f.scope, role: "root", identity: { taskId: "t", sessionId: "s", generation: 1 } }, null)).rejects.toThrow("MCP");
  expect(devinArguments({ scope: f.scope, resumeSessionId: null, promptFile: "/tmp/prompt" })).not.toContain("--resume");
});
