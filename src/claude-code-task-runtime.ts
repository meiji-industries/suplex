import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { claudeAssistantText, claudeConfigDirectory, claudeExecution, claudeMessageEntries, ClaudeStreamInitSchema, ClaudeStreamResultSchema, claudeUnsettledToolIds, findClaudeTranscript, parseJsonLines, type ClaudeStreamResult } from "./claude-code-transcript.js";
import { resolveClaudeExecutable } from "./executable-resolver.js";
import { compareProcessIdentity, inspectProcessOnce, stopOwnedProcesses, type OwnedProcess } from "./process-manager.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "./task-control.js";
import { attachTaskDisplay, shellQuote, taskSessionRuntimeDirectory, writeRootBridgeBinding, type PromptIntent, type PromptObservation, type TaskHarness, type TaskPanePort, type TaskScope } from "./task-harness.js";
import { taskRolePrompt } from "./task-role-prompt.js";
import { createGitCommandGuard, withWorktreeMiseTrust, type GitCommandGuard } from "./worker-environment.js";

// Claude Code has no server. Each prompt runs as one detached headless
// `claude -p --resume` process whose stream-json output is the turn record;
// the transcript Claude Code keeps under its config directory is the session.
// The Herdr display is `claude --resume` on that same transcript.

export const ClaudeTurnRecordSchema = z.object({
  generation: z.string().uuid(),
  turnId: z.string().min(1),
  sessionID: z.string().min(1),
  pid: z.number().int().positive(),
  processIdentity: z.object({
    command: z.string().min(1),
    executable: z.string().min(1),
    argv: z.array(z.string()),
    processGroup: z.number().int().positive(),
    startTime: z.string().min(1),
    ownerUid: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type ClaudeTurnRecord = z.infer<typeof ClaudeTurnRecordSchema>;

function ownedTurn(record: ClaudeTurnRecord): OwnedProcess {
  return { ...record.processIdentity, pid: record.pid, name: `claude-${record.generation}`, startedAt: record.processIdentity.startTime };
}

async function readJsonFile<T>(path: string, schema: { parse(input: unknown): T }): Promise<T | null> {
  try { return schema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

async function readTextFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

export async function readClaudeTurnRecord(path: string): Promise<ClaudeTurnRecord | null> {
  return readJsonFile(path, ClaudeTurnRecordSchema);
}

export async function claudeTurnRunning(record: ClaudeTurnRecord): Promise<boolean> {
  return compareProcessIdentity(ownedTurn(record), await inspectProcessOnce(record.pid)).kind === "exact_match";
}

/** True while the latest dispatched turn of this session runtime is still executing. */
export async function claudeSessionBusy(runtimeDirectory: string): Promise<boolean> {
  const record = await readClaudeTurnRecord(join(runtimeDirectory, "turn.json"));
  return record !== null && await claudeTurnRunning(record);
}

export function claudeDisplayAttached(executable: string, sessionID: string | null, args: readonly string[]): boolean {
  return args[0] === executable && args[args.indexOf("--resume") + 1] === sessionID;
}

const ROOT_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,TodoWrite";

export function claudeArguments(input: { scope: TaskScope; sessionID: string; resume: boolean; print: boolean; runtimeDirectory: string }): string[] {
  const { scope } = input;
  return [
    ...(input.print ? ["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"] : []),
    input.resume ? "--resume" : "--session-id", input.sessionID,
    "--model", scope.profile.modelID, "--effort", scope.profile.reasoningEffort,
    "--append-system-prompt", taskRolePrompt(scope.role, { workflow: scope.workflow, ...(scope.role === "worker" ? { workerMode: scope.workerMode, purpose: scope.purpose } : {}) }),
    "--strict-mcp-config", "--mcp-config", scope.role === "root" ? join(input.runtimeDirectory, "mcp.json") : '{"mcpServers":{}}',
    ...(scope.role !== "worker" && scope.workflow !== "standard" && scope.evidenceRoot ? ["--add-dir", scope.evidenceRoot] : []),
    ...(scope.role !== "worker"
      ? ["--tools", ROOT_TOOLS, ...(scope.role === "root" ? ["--allowedTools", "mcp__forge_root"] : [])]
      : ["--disallowedTools", "Agent,AskUserQuestion", "--dangerously-skip-permissions"]),
  ];
}

function streamResult(values: readonly unknown[]): ClaudeStreamResult | undefined {
  return values.flatMap(value => { const parsed = ClaudeStreamResultSchema.safeParse(value); return parsed.success ? [parsed.data] : []; }).at(-1);
}

function turnFiles(runtimeDirectory: string, turnId: string) {
  return { prompt: join(runtimeDirectory, `turn-${turnId}.prompt`), log: join(runtimeDirectory, `turn-${turnId}.jsonl`), stderr: join(runtimeDirectory, `turn-${turnId}.stderr.log`) };
}

async function waitForIdentity(pid: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspection = await inspectProcessOnce(pid);
    if (inspection) return inspection;
    await delay(50);
  }
  return undefined;
}

export class ClaudeCodeTaskRuntime implements TaskHarness {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string; artifactRoot?: string; configDirectory?: string } = {}) {}

  private runtimeDirectory(scope: Pick<TaskScope, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, scope.id);
  }

  private executable(): Promise<string> {
    return resolveClaudeExecutable(this.options.executable ? { executable: this.options.executable } : {});
  }

  private transcript(sessionID: string): Promise<string | null> {
    return findClaudeTranscript(sessionID, this.options.configDirectory ?? claudeConfigDirectory());
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
    if (scope.role === "root") {
      const server = await writeRootBridgeBinding({ runtimeDirectory, identity: scope.identity, databasePath: this.databasePath, artifactRoot: this.options.artifactRoot });
      await writeFile(join(runtimeDirectory, "mcp.json"), JSON.stringify({ mcpServers: { forge_root: server } }), { mode: 0o600 });
    }
    return nativeSessionId ?? randomUUID();
  }

  async attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; persistPane: (paneId: string) => void }): Promise<string> {
    if (!await this.transcript(input.nativeSessionId)) throw new Error("Claude Code session has not started; the display attaches after its first turn");
    const executable = await this.executable();
    const guard = await this.guard(input.scope);
    // ponytail: the interactive display resumes the same transcript but does not
    // refresh while a headless turn appends to it; reopen the pane to catch up.
    const environment = guard ? `PATH=${shellQuote(guard.directory)}:"$PATH" FORGE_GIT_REAL_BIN=${shellQuote(guard.env.FORGE_GIT_REAL_BIN ?? "")} FORGE_GH_REAL_BIN=${shellQuote(guard.env.FORGE_GH_REAL_BIN ?? "")} ` : "";
    const command = environment + [executable, ...claudeArguments({ scope: input.scope, sessionID: input.nativeSessionId, resume: true, print: false, runtimeDirectory: this.runtimeDirectory(input.scope) })].map(shellQuote).join(" ");
    return attachTaskDisplay(this.herdr, { ...input, generation: input.nativeSessionId, isAttached: args => claudeDisplayAttached(executable, input.nativeSessionId, args), command });
  }

  private async record(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<ClaudeTurnRecord | null> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const fenced = attempt ? await readClaudeTurnRecord(join(runtimeDirectory, `dispatch-${attempt.serverGeneration}.json`)) : null;
    const latest = fenced ?? await readClaudeTurnRecord(join(runtimeDirectory, "turn.json"));
    return latest?.turnId === intent.messageID ? latest : null;
  }

  async observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> {
    const files = turnFiles(this.runtimeDirectory(scope), intent.messageID);
    const record = await this.record(scope, intent, attempt);
    const log = await readTextFile(files.log);
    const base = { sessionID: intent.sessionID, messageID: intent.messageID, assistantMessageIDs: [] as string[] };
    if (!record) {
      const replayable = intent.dispatch === "not_submitted" || intent.dispatch === "rejected";
      if (log === null) return { ...base, state: "unknown", admission: "not_observed", retry: replayable ? "allowed" : "forbidden", reason: replayable ? "message_not_observed" : "admission_ambiguous" };
      return { ...base, state: "unknown", admission: "unknown", retry: "forbidden", reason: "dispatch_identity_missing", executionUncertain: { stoppedServerGeneration: attempt?.serverGeneration ?? "unknown" } };
    }
    if (record.sessionID !== intent.sessionID) return { ...base, state: "unknown", admission: "unknown", retry: "forbidden", reason: "session_identity_conflict" };
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
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const before = await this.observe(scope, intent);
    if (before.retry !== "allowed") throw new Error("Claude Code prompt was not proven absent; replay is blocked");
    const executable = await this.executable();
    const resume = await this.transcript(intent.sessionID) !== null;
    const guard = await this.guard(scope);
    const generation = randomUUID();
    if (!await claim(generation)) throw new Error("Claude Code prompt replay claim was not acquired");
    const files = turnFiles(runtimeDirectory, intent.messageID);
    await writeFile(files.prompt, intent.prompt, { mode: 0o600 });
    const [promptFile, log, stderr] = await Promise.all([open(files.prompt, "r"), open(files.log, "a", 0o600), open(files.stderr, "a", 0o600)]);
    const args = claudeArguments({ scope, sessionID: intent.sessionID, resume, print: true, runtimeDirectory });
    let exited = false;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { cwd: scope.directory, env: withWorktreeMiseTrust(guard?.env ?? process.env, scope.directory), detached: true, stdio: [promptFile.fd, log.fd, stderr.fd] });
      child.once("exit", () => { exited = true; });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    } finally { await Promise.all([promptFile.close(), log.close(), stderr.close()]); }
    if (!child.pid) throw new Error("Claude Code did not start");
    child.unref();
    const inspection = exited ? undefined : await waitForIdentity(child.pid);
    if (inspection && (inspection.ownerUid === undefined || inspection.processGroup !== child.pid)) throw new Error("Claude Code process identity could not be established");
    // A process that exited before inspection keeps a synthetic identity that no live pid can match.
    const processIdentity = inspection
      ? { command: inspection.command, executable: inspection.executable, argv: inspection.argv, processGroup: inspection.processGroup, startTime: inspection.startTime, ownerUid: inspection.ownerUid! }
      : { command: executable, executable, argv: [executable, ...args], processGroup: child.pid, startTime: "exited-before-inspection", ownerUid: process.getuid?.() ?? 0 };
    const record: ClaudeTurnRecord = { generation, turnId: intent.messageID, sessionID: intent.sessionID, pid: child.pid, processIdentity };
    const pending = join(runtimeDirectory, `dispatch-${generation}.json.pending`);
    await writeFile(pending, JSON.stringify(record), { mode: 0o600 });
    await rename(pending, join(runtimeDirectory, `dispatch-${generation}.json`));
    await writeFile(join(runtimeDirectory, "turn.json"), JSON.stringify(record), { mode: 0o600 });
    return this.observe(scope, { ...intent, dispatch: "ambiguous" }, { serverGeneration: generation, claimedAt: new Date().toISOString() });
  }

  async recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation> {
    PromptDispatchAttemptSchema.parse(attempt);
    const record = await readClaudeTurnRecord(join(this.runtimeDirectory(scope), `dispatch-${attempt.serverGeneration}.json`));
    if (record && await claudeTurnRunning(record)) await stopOwnedProcesses({ version: 1, processes: [ownedTurn(record)] });
    return this.observe(scope, { ...intent, dispatch: "not_submitted" }, attempt);
  }

  async stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    const record = await readClaudeTurnRecord(join(this.runtimeDirectory(scope), "turn.json"));
    if (!record || nativeSessionId !== null && record.sessionID !== nativeSessionId) return;
    if (await claudeTurnRunning(record)) await stopOwnedProcesses({ version: 1, processes: [ownedTurn(record)] });
  }

  async resultText(scope: TaskScope, observation: PromptObservation): Promise<string> {
    const files = turnFiles(this.runtimeDirectory(scope), observation.messageID);
    const values = parseJsonLines(await readTextFile(files.log) ?? "");
    const text = streamResult(values)?.result ?? claudeAssistantText(claudeMessageEntries(values));
    return text || (await readTextFile(files.stderr) ?? "").trim().slice(-2_000);
  }

  async turnEvidence(scope: TaskScope, observation: PromptObservation): ReturnType<TaskHarness["turnEvidence"]> {
    try {
      const log = await readTextFile(turnFiles(this.runtimeDirectory(scope), observation.messageID).log);
      if (log === null) throw new Error("The native turn log is missing");
      return { tools: claudeExecution(claudeMessageEntries(parseJsonLines(log))).tools, limit: null };
    } catch (error) {
      return { tools: [], limit: `Native tool evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
