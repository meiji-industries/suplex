import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeAssistantText, claudeConfigDirectory, claudeExecution, claudeMessageEntries, ClaudeStreamInitSchema, ClaudeStreamResultSchema, claudeUnsettledToolIds, findClaudeTranscript, parseJsonLines, type ClaudeStreamResult } from "./transcript.js";
import { resolveClaudeExecutable } from "../../platform/executable-resolver.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "../../tasks/control.js";
import { instanceEnvironment, taskSessionRuntimeDirectory, writeAdvisorReportBridgeBinding, writeRootBridgeBinding, type PromptIntent, type PromptObservation, type TaskHarness, type TaskScope } from "../task-harness.js";
import { attachTaskDisplay, type TaskPanePort } from "../task-display.js";
import { taskRolePrompt } from "../../tasks/execution/role-prompt.js";
import { createGitCommandGuard, type GitCommandGuard } from "../../coordination/worker-environment.js";
import { dispatchHeadless, headlessObservationPrelude, headlessSessionBusy, headlessTurnFiles, headlessTurnRunning, readHeadlessText, readHeadlessTurnRecord, recoverHeadlessDispatch, stopHeadlessSession, type HeadlessTurnRecord } from "../headless/turn-process.js";
import { claudeDisplayAttached, claudeDisplayCommand } from "./display.js";

// Claude Code has no server. Each prompt runs as one detached headless
// `claude -p --resume` process whose stream-json output is the turn record;
// the transcript Claude Code keeps under its config directory is the session.
// The Herdr display follows those read-only turn records.

export type ClaudeTurnRecord = HeadlessTurnRecord;
export const readClaudeTurnRecord = readHeadlessTurnRecord;
export const claudeTurnRunning = headlessTurnRunning;

/** True while the latest dispatched turn of this session runtime is still executing. */
export async function claudeSessionBusy(runtimeDirectory: string): Promise<boolean> {
  return headlessSessionBusy(runtimeDirectory);
}

const ROOT_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,TodoWrite";

export function claudeArguments(input: { scope: TaskScope; sessionID: string; resume: boolean; print: boolean; runtimeDirectory: string }): string[] {
  const { scope } = input;
  return [
    ...(input.print ? ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompts", "none"] : []),
    input.resume ? "--resume" : "--session-id", input.sessionID,
    "--model", scope.profile.modelID, "--effort", scope.profile.reasoningEffort,
    "--append-system-prompt", taskRolePrompt(scope.role, { workflow: scope.workflow, ...(scope.role === "worker" ? { workerMode: scope.workerMode, purpose: scope.purpose } : {}) }),
    "--strict-mcp-config", "--mcp-config", scope.role !== "worker" ? join(input.runtimeDirectory, "mcp.json") : '{"mcpServers":{}}',
    ...(scope.role !== "worker" && scope.workflow !== "standard" && scope.evidenceRoot ? ["--add-dir", scope.evidenceRoot] : []),
    ...(scope.role !== "worker"
      ? ["--tools", ROOT_TOOLS, "--allowedTools", `${scope.role === "root" ? "mcp__forge_root" : "mcp__forge_advisor__submit_report"},WebFetch,WebSearch`]
      : ["--disallowedTools", "Agent,AskUserQuestion", "--dangerously-skip-permissions"]),
  ];
}

function streamResult(values: readonly unknown[]): ClaudeStreamResult | undefined {
  return values.flatMap(value => { const parsed = ClaudeStreamResultSchema.safeParse(value); return parsed.success ? [parsed.data] : []; }).at(-1);
}


export class ClaudeCodeTaskRuntime implements TaskHarness {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string; artifactRoot?: string; configDirectory?: string } = {}) {}

  private runtimeDirectory(scope: Pick<TaskScope, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, scope.id);
  }

  private executable(): Promise<string> {
    return resolveClaudeExecutable(this.options.executable ? { executable: this.options.executable } : {});
  }

  private transcript(sessionID: string, scope?: TaskScope): Promise<string | null> {
    return findClaudeTranscript(sessionID, scope?.profile.instanceHomeDirectory ?? this.options.configDirectory ?? claudeConfigDirectory());
  }

  private async guard(scope: TaskScope): Promise<GitCommandGuard | undefined> {
    return scope.role === "worker" ? createGitCommandGuard(this.runtimeDirectory(scope), "git-guard") : undefined;
  }

  // Claude Code creates the transcript on the first prompt, so a new session
  // is only a reserved identity until the first dispatch runs.
  async ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    if (scope.role !== "worker" && scope.workflow !== "standard" && scope.evidenceRoot) await mkdir(scope.evidenceRoot, { recursive: true, mode: 0o700 });
    await this.executable();
    if (scope.role !== "worker") {
      const server = scope.role === "root"
        ? await writeRootBridgeBinding({ runtimeDirectory, identity: scope.identity, databasePath: this.databasePath, artifactRoot: this.options.artifactRoot })
        : await writeAdvisorReportBridgeBinding({ runtimeDirectory, role: scope.advisorRole });
      await writeFile(join(runtimeDirectory, "mcp.json"), JSON.stringify({ mcpServers: { [scope.role === "root" ? "forge_root" : "forge_advisor"]: { command: server.command, args: server.args, env: server.environment } } }), { mode: 0o600 });
    }
    return nativeSessionId ?? randomUUID();
  }

  async attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; shellPaneId?: string | null; persistPane: (paneId: string) => void; persistShellPane?: (paneId: string) => void }): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(input.scope);
    const display = claudeDisplayCommand(runtimeDirectory);
    return attachTaskDisplay(this.herdr, { ...input, generation: input.nativeSessionId, isAttached: args => claudeDisplayAttached(runtimeDirectory, args), command: display.command });
  }

  async observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> {
    const prelude = await headlessObservationPrelude({ runtimeDirectory: this.runtimeDirectory(scope), intent, attempt });
    if (prelude.early) return prelude.early;
    const { log, record, base } = prelude;
    const values = parseJsonLines(log ?? "");
    const entries = claudeMessageEntries(values);
    const init = values.map(value => ClaudeStreamInitSchema.safeParse(value)).find(parsed => parsed.success)?.data;
    const result = streamResult(values);
    const assistants = entries.filter(entry => entry.type === "assistant");
    const last = assistants.at(-1);
    const agent = `forge-${scope.role}`;
    const common: PromptObservation = {
      ...base, state: "running", admission: "observed", retry: "forbidden",
      assistantMessageIDs: assistants.map(entry => entry.uuid),
      ...(last ? { assistantMessageID: last.uuid } : {}),
      native: { messageID: last?.uuid ?? intent.messageID, parentID: intent.messageID, providerID: "claude-code", modelID: init?.model ?? scope.profile.modelID, mode: agent, agent, cwd: init?.cwd ?? scope.directory, root: scope.directory, ...(result ? { finish: result.subtype } : {}), ...(result?.is_error ? { error: { name: result.subtype } } : {}) },
      unsettledTools: claudeUnsettledToolIds(entries).length > 0,
    };
    if (result) return { ...common, state: result.is_error || result.subtype !== "success" ? "error" : "completed", ...(result.is_error || result.subtype !== "success" ? { reason: "native_error" } : {}) };
    if (await claudeTurnRunning(record)) return { ...common, reason: "dispatch_process_running" };
    if (!init) return { ...common, state: "error", reason: "native_startup_failed" };
    if (common.unsettledTools) return { ...common, state: "unknown", reason: "tool_execution_after_process_stopped", executionUncertain: { stoppedServerGeneration: record.generation } };
    return { ...common, state: "interrupted", reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: record.generation } };
  }

  async dispatch(scope: TaskScope, intent: PromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<PromptObservation> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const before = await this.observe(scope, intent);
    if (before.retry !== "allowed") throw new Error("Claude Code prompt was not proven absent; replay is blocked");
    const executable = await this.executable();
    const resume = await this.transcript(intent.sessionID, scope) !== null;
    const guard = await this.guard(scope);
    const args = claudeArguments({ scope, sessionID: intent.sessionID, resume, print: true, runtimeDirectory });
    const record = await dispatchHeadless({ runtimeDirectory, scope, intent, executable, args, prompt: intent.prompt, environment: { ...process.env, ...guard?.env, ...instanceEnvironment(scope.profile.providerID, scope.profile.instanceHomeDirectory ?? null) }, claim, label: "Claude Code" });
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
    const values = parseJsonLines(await readHeadlessText(files.log) ?? "");
    const text = streamResult(values)?.result ?? claudeAssistantText(claudeMessageEntries(values));
    return text || (await readHeadlessText(files.stderr) ?? "").trim().slice(-2_000);
  }

  async turnEvidence(scope: TaskScope, observation: PromptObservation): ReturnType<TaskHarness["turnEvidence"]> {
    try {
      const log = await readHeadlessText(headlessTurnFiles(this.runtimeDirectory(scope), observation.messageID).log);
      if (log === null) throw new Error("The native turn log is missing");
      return { tools: claudeExecution(claudeMessageEntries(parseJsonLines(log))).tools, limit: null };
    } catch (error) {
      return { tools: [], limit: `Native tool evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
