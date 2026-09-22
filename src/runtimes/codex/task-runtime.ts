import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveCodexExecutable } from "../../platform/executable-resolver.js";
import { compareProcessIdentity, inspectProcessOnce, stopExecutionProcesses } from "../../platform/process-manager.js";
import { createGitCommandGuard, type GitCommandGuard } from "../../coordination/worker-environment.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "../../tasks/control.js";
import { taskRolePrompt } from "../../tasks/execution/role-prompt.js";
import { dispatchHeadless, headlessObservationPrelude, headlessSessionBusy, headlessTurnFiles, headlessTurnRunning, ownedHeadlessTurn, readHeadlessText, recoverHeadlessDispatch, stopHeadlessSession } from "../headless/turn-process.js";
import { advisorBridgeResultPath, taskBridgeEnvironment, taskSessionRuntimeDirectory, writeAdvisorReportBridgeBinding, writeRootBridgeBinding, type PromptIntent, type PromptObservation, type TaskBridgeServer, type TaskHarness, type TaskScope } from "../task-harness.js";
import { attachTaskDisplay, type TaskPanePort } from "../task-display.js";
import { codexCompletedTurn, codexFailure, codexResultText, codexThreadId, codexTools, codexUnsettledToolIds, parseCodexEvents } from "./transcript.js";
import { codexDisplayAttached, codexDisplayCommand } from "./display.js";

// Codex has no server. Each prompt runs as one detached headless
// `codex exec [resume]` process whose JSONL event stream is the turn record;
// the thread Codex keeps under its own home directory is the session.

const CodexSessionSchema = z.object({ threadId: z.string().trim().min(1) }).passthrough();

// A missing or malformed file yields null so observe() reports the turn rather
// than throwing on every poll; the next turn persists a fresh thread id.
export async function readCodexThreadId(runtimeDirectory: string): Promise<string | null> {
  let text: string;
  try { text = await readFile(join(runtimeDirectory, "session.json"), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  const parsed = CodexSessionSchema.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  return parsed.success ? parsed.data.threadId : null;
}

async function persistCodexThreadId(runtimeDirectory: string, threadId: string): Promise<void> {
  const path = join(runtimeDirectory, "session.json");
  const pending = `${path}.${randomUUID()}.pending`;
  await writeFile(pending, JSON.stringify({ threadId }), { mode: 0o600 });
  await rename(pending, path);
}

// The Codex resume error strings: the thread's rollout was pruned or CODEX_HOME
// moved, so no future turn can resume it.
const CODEX_UNRESUMABLE = /no rollout found|rollout .* is empty|thread .*not found|missing thread|no archived rollout/i;
const unresumablePath = (runtimeDirectory: string) => join(runtimeDirectory, "session.unresumable");

async function deadCodexThreadIds(runtimeDirectory: string): Promise<Set<string>> {
  const text = await readFile(unresumablePath(runtimeDirectory), "utf8").catch(() => "");
  return new Set(text.split("\n").filter(Boolean));
}

/** Drops the persisted thread so the next dispatch starts a fresh one, and records it as dead so recovery cannot resurrect it. */
async function forgetCodexThread(runtimeDirectory: string): Promise<void> {
  const threadId = await readCodexThreadId(runtimeDirectory);
  await rm(join(runtimeDirectory, "session.json"), { force: true });
  if (threadId) await appendFile(unresumablePath(runtimeDirectory), `${threadId}\n`, { mode: 0o600 });
}

/** session.json is the record; a lost or corrupted one is rebuilt from the newest turn log that announced a thread. */
async function recoverCodexThreadId(runtimeDirectory: string): Promise<string | null> {
  const stored = await readCodexThreadId(runtimeDirectory);
  if (stored) return stored;
  const names = await readdir(runtimeDirectory).catch(() => [] as string[]);
  const logs = await Promise.all(names.filter(name => /^turn-.+\.jsonl$/.test(name)).map(async name => {
    const path = join(runtimeDirectory, name);
    return { path, modifiedAt: await stat(path).then(details => details.mtimeMs, () => 0) };
  }));
  const dead = await deadCodexThreadIds(runtimeDirectory);
  for (const log of logs.sort((left, right) => right.modifiedAt - left.modifiedAt)) {
    const threadId = codexThreadId(parseCodexEvents(await readFile(log.path, "utf8").catch(() => "")));
    if (!threadId || dead.has(threadId)) continue;
    await persistCodexThreadId(runtimeDirectory, threadId);
    return threadId;
  }
  return null;
}

export async function codexSessionBusy(runtimeDirectory: string): Promise<boolean> {
  return headlessSessionBusy(runtimeDirectory);
}

function tomlString(value: string): string {
  let quoted = "";
  for (const character of value) {
    if (character === "\\") quoted += "\\\\";
    else if (character === "\"") quoted += "\\\"";
    else if (character === "\n") quoted += "\\n";
    else if (character === "\r") quoted += "\\r";
    else if (character === "\t") quoted += "\\t";
    else if (character < " " || character === "\u007f") quoted += `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else quoted += character;
  }
  return `"${quoted}"`;
}

// `env_vars` names variables Codex forwards from its own environment, so no
// bridge token is ever written to the command line or the turn record.
// `approve` skips the per-tool approval prompt that no one can answer in exec mode.
function mcpServerTable(bridge: TaskBridgeServer): string {
  const names = Object.keys(bridge.environment).map(tomlString).join(",");
  return `{command=${tomlString(bridge.command)},args=[${bridge.args.map(tomlString).join(",")}],env_vars=[${names}],default_tools_approval_mode="approve"}`;
}

export function codexBridgeServerName(role: TaskScope["role"]): string {
  return role === "root" ? "suplex_root" : "suplex_advisor";
}

// `codex exec resume` accepts no `-s`, `-C`, or `--add-dir`, so every policy
// rides on `-c` config overrides, which both invocation forms accept.
export function codexArguments(input: { scope: TaskScope; resumeThreadId: string | null; bridge?: TaskBridgeServer | undefined }): string[] {
  const { scope } = input;
  return [
    "exec",
    ...(input.resumeThreadId ? ["resume", input.resumeThreadId] : []),
    "--json", "--skip-git-repo-check",
    "-m", scope.profile.modelID,
    "-c", `model_reasoning_effort="${scope.profile.reasoningEffort}"`,
    "-c", "approval_policy=\"never\"",
    "-c", `sandbox_mode="${scope.role === "worker" ? "danger-full-access" : "read-only"}"`,
    ...(input.bridge ? ["-c", `mcp_servers.${codexBridgeServerName(scope.role)}=${mcpServerTable(input.bridge)}`] : []),
    "-",
  ];
}

function rolePrompt(scope: TaskScope, intent: PromptIntent): string {
  const worker = scope.role === "worker" ? { workerMode: scope.workerMode, purpose: scope.purpose } : {};
  return `${taskRolePrompt(scope.role, { workflow: scope.workflow, ...worker })}\n\n${intent.prompt}`;
}

export class CodexTaskRuntime implements TaskHarness {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string; artifactRoot?: string } = {}) {}

  private runtimeDirectory(scope: Pick<TaskScope, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, scope.id);
  }

  private executable(): Promise<string> {
    return resolveCodexExecutable(this.options.executable ? { executable: this.options.executable } : {});
  }

  private async bridge(scope: TaskScope): Promise<TaskBridgeServer | undefined> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    if (scope.role === "root") return writeRootBridgeBinding({ runtimeDirectory, identity: scope.identity, databasePath: this.databasePath, artifactRoot: this.options.artifactRoot });
    if (scope.role === "advisor") return writeAdvisorReportBridgeBinding({ runtimeDirectory, role: scope.advisorRole });
    return undefined;
  }

  // Every Codex role has a shell, so every role gets the git guard.
  private async guard(scope: TaskScope): Promise<GitCommandGuard> {
    return createGitCommandGuard(this.runtimeDirectory(scope), "git-guard");
  }

  async ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> {
    await mkdir(this.runtimeDirectory(scope), { recursive: true, mode: 0o700 });
    await this.executable();
    await this.bridge(scope);
    await recoverCodexThreadId(this.runtimeDirectory(scope));
    return nativeSessionId ?? `codex-${randomUUID()}`;
  }

  async attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; shellPaneId?: string | null; persistPane: (paneId: string) => void; persistShellPane?: (paneId: string) => void }): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(input.scope);
    const display = codexDisplayCommand(runtimeDirectory);
    return attachTaskDisplay(this.herdr, { ...input, generation: input.nativeSessionId, isAttached: args => codexDisplayAttached(runtimeDirectory, args), command: display.command });
  }

  async observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const prelude = await headlessObservationPrelude({ runtimeDirectory, intent, attempt });
    if (prelude.early) return prelude.early;
    const { files, log, record, base } = prelude;
    const events = parseCodexEvents(log ?? "");
    const threadId = codexThreadId(events);
    if (threadId && !await readCodexThreadId(runtimeDirectory) && !(await deadCodexThreadIds(runtimeDirectory)).has(threadId)) await persistCodexThreadId(runtimeDirectory, threadId);
    const agent = `suplex-${scope.role}`;
    const common: PromptObservation = {
      ...base, state: "running", admission: "observed", retry: "forbidden",
      native: { messageID: intent.messageID, parentID: intent.messageID, providerID: "codex", modelID: scope.profile.modelID, mode: agent, agent, cwd: scope.directory, root: scope.directory },
      unsettledTools: codexUnsettledToolIds(events).length > 0,
      unsettledToolIds: codexUnsettledToolIds(events).slice(0, 32),
      nativeFinalObserved: codexCompletedTurn(events),
    };
    // Liveness outranks the log: a completed turn event is printed before Codex
    // exits, and reporting `completed` while it runs would dispatch the next
    // turn concurrently against the same thread.
    if (await headlessTurnRunning(record)) return { ...common, processRunning: true, reason: "dispatch_process_running" };
    const exit = await readHeadlessText(files.exit);
    if (common.unsettledTools) {
      if (exit === null) {
        const inspected = await inspectProcessOnce(record.pid);
        if (compareProcessIdentity(ownedHeadlessTurn(record), inspected).kind === "exact_match") return { ...common, reason: "dispatch_process_running" };
        if (!inspected) {
          let absent = false;
          try { process.kill(record.pid, 0); }
          catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") absent = true; else throw error; }
          if (!absent) throw new Error("Codex process liveness is uncertain. Recovery will retry.");
        }
      }
      await stopExecutionProcesses(runtimeDirectory, record.generation, "unsettled tools after agent process exit");
      return { ...common, state: "interrupted", reason: "tool_execution_after_process_stopped", interruptedExecution: { stoppedServerGeneration: record.generation } };
    }
    if (codexCompletedTurn(events)) return { ...common, state: "completed", assistantMessageID: intent.messageID };
    if (codexFailure(events) !== null) return { ...common, state: "error", reason: "native_error" };
    if (exit === null) return { ...common, state: "interrupted", reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: record.generation } };
    if (!threadId) {
      // Only an unresumable thread is dropped. An auth or network failure keeps
      // it, because starting over would silently abandon the conversation.
      if ((record.dispatchArguments ?? record.processIdentity.argv).includes("resume") && CODEX_UNRESUMABLE.test(await readHeadlessText(files.stderr) ?? "")) await forgetCodexThread(runtimeDirectory);
      return { ...common, state: "error", reason: "native_startup_failed" };
    }
    return { ...common, state: "interrupted", reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: record.generation } };
  }

  async dispatch(scope: TaskScope, intent: PromptIntent, claim: (generation: string) => Promise<boolean>): Promise<PromptObservation> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const before = await this.observe(scope, intent);
    if (before.retry !== "allowed") throw new Error("Codex prompt was not proven absent; replay is blocked");
    const executable = await this.executable();
    const bridge = await this.bridge(scope);
    const guard = await this.guard(scope);
    const resumeThreadId = await recoverCodexThreadId(runtimeDirectory);
    const additions = scope.role === "advisor" ? { SUPLEX_ADVISOR_RESULT: advisorBridgeResultPath(runtimeDirectory, intent.messageID) } : {};
    const environment = taskBridgeEnvironment(bridge, { ...process.env, ...guard.env }, additions);
    const record = await dispatchHeadless({ runtimeDirectory, scope, intent, executable, args: codexArguments({ scope, resumeThreadId, bridge }), prompt: rolePrompt(scope, intent), environment, claim, label: "Codex" });
    return this.observe(scope, { ...intent, dispatch: "ambiguous" }, { serverGeneration: record.generation, claimedAt: new Date().toISOString() });
  }

  async recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation> {
    PromptDispatchAttemptSchema.parse(attempt);
    await recoverHeadlessDispatch({ runtimeDirectory: this.runtimeDirectory(scope), attempt });
    return this.observe(scope, { ...intent, dispatch: "not_submitted" }, attempt);
  }

  async stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    await stopHeadlessSession({ runtimeDirectory: this.runtimeDirectory(scope), nativeSessionId });
  }

  async resultText(scope: TaskScope, observation: PromptObservation): Promise<string> {
    const files = headlessTurnFiles(this.runtimeDirectory(scope), observation.messageID);
    const events = parseCodexEvents(await readHeadlessText(files.log) ?? "");
    const result = codexResultText(events) || (await readHeadlessText(files.stderr) ?? "").trim().slice(-2_000);
    if (!observation.interruptedExecution || !observation.unsettledTools) return result;
    const commands = codexTools(events).filter(tool => tool.name === "command_execution" && tool.status === "running");
    const unfinished = commands.map(tool => `Unfinished command ${tool.id}: ${String(tool.input.command)}\n${tool.output ? `Output: ${tool.output}\n` : ""}No exit result.`).join("\n");
    return [result, unfinished].filter(Boolean).join("\n\n");
  }

  async turnEvidence(scope: TaskScope, observation: PromptObservation): ReturnType<TaskHarness["turnEvidence"]> {
    try {
      const log = await readHeadlessText(headlessTurnFiles(this.runtimeDirectory(scope), observation.messageID).log);
      if (log === null) throw new Error("The native turn log is missing");
      return { tools: codexTools(parseCodexEvents(log)), limit: null };
    } catch (error) {
      return { tools: [], limit: `Native tool evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
