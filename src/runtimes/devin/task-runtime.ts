import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../../platform/command-runner.js";
import { resolveDevinExecutable } from "../../platform/executable-resolver.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "../../tasks/control.js";
import { taskRolePrompt } from "../../tasks/execution/role-prompt.js";
import { dispatchHeadless, headlessObservationPrelude, headlessSessionBusy, headlessTurnFiles, headlessTurnRunning, readHeadlessText, recoverHeadlessDispatch, stopHeadlessSession } from "../headless/turn-process.js";
import { shellQuote, taskSessionRuntimeDirectory, type PromptIntent, type PromptObservation, type TaskHarness, type TaskScope } from "../task-harness.js";
import { attachTaskDisplay, type TaskPanePort } from "../task-display.js";
import { devinResultText } from "./transcript.js";

type DevinSessionList = { id?: unknown; session_id?: unknown }[];

export async function readDevinSessionId(runtimeDirectory: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(runtimeDirectory, "session.json"), "utf8"));
    return typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

// docs.devin.ai/cli/reference/commands documents `devin list --format json` as
// the machine-readable listing for sessions in the current directory.
async function discoverDevinSessionId(executable: string, directory: string): Promise<string | null> {
  const result = await runCommand({ taskId: null, stepId: null, command: executable, args: ["list", "--format", "json"], cwd: directory, expectNonZero: true });
  if (result.exitCode !== 0) return null;
  try {
    const sessions = JSON.parse(result.stdout) as DevinSessionList;
    const newest = sessions.at(-1);
    const id = newest?.id ?? newest?.session_id;
    return typeof id === "string" && id ? id : null;
  } catch { return null; }
}

export async function devinSessionBusy(runtimeDirectory: string): Promise<boolean> {
  return headlessSessionBusy(runtimeDirectory);
}

export function devinDisplayAttached(executable: string, sessionID: string | null, args: readonly string[]): boolean {
  return args[0] === executable && args[args.indexOf("--resume") + 1] === sessionID;
}

/** Arguments are restricted to the documented Devin CLI flags. A null promptFile builds the interactive display invocation. */
export function devinArguments(input: { scope: TaskScope; resumeSessionId: string | null; promptFile: string | null }): string[] {
  return [
    ...(input.promptFile === null ? [] : ["--print"]),
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(input.promptFile === null ? [] : ["--prompt-file", input.promptFile]),
    "--model", input.scope.profile.modelID,
    "--permission-mode", "dangerous",
    "--respect-workspace-trust", "false",
  ];
}

function rolePrompt(scope: TaskScope, intent: PromptIntent): string {
  const worker = scope.role === "worker" ? { workerMode: scope.workerMode, purpose: scope.purpose } : {};
  return `${taskRolePrompt(scope.role, { workflow: scope.workflow, ...worker })}\n\n${intent.prompt}`;
}

export class DevinTaskRuntime implements TaskHarness {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string } = {}) {}

  private runtimeDirectory(scope: Pick<TaskScope, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, scope.id);
  }

  private executable(): Promise<string> {
    return resolveDevinExecutable(this.options.executable ? { executable: this.options.executable } : {});
  }

  private supported(scope: TaskScope): void {
    if (scope.role !== "worker") throw new Error("Devin CLI cannot run Forge Coordinator or Advisor roles: its documented CLI has no per-invocation MCP configuration.");
  }

  async ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> {
    this.supported(scope);
    await mkdir(this.runtimeDirectory(scope), { recursive: true, mode: 0o700 });
    await this.executable();
    return nativeSessionId ?? `devin-${randomUUID()}`;
  }

  // Devin assigns its own session id, which observe() only persists after the
  // first completed turn, so the display cannot attach before then.
  async attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; persistPane: (paneId: string) => void }): Promise<string> {
    const sessionId = await readDevinSessionId(this.runtimeDirectory(input.scope));
    if (!sessionId) throw new Error("Devin session has not started; the display attaches after its first turn");
    const executable = await this.executable();
    const command = [executable, ...devinArguments({ scope: input.scope, resumeSessionId: sessionId, promptFile: null })].map(shellQuote).join(" ");
    return attachTaskDisplay(this.herdr, { ...input, generation: sessionId, isAttached: args => devinDisplayAttached(executable, sessionId, args), command });
  }

  async observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const prelude = await headlessObservationPrelude({ runtimeDirectory, intent, attempt });
    if (prelude.early) return prelude.early;
    const { files, log, record, base } = prelude;
    const common = {
      ...base,
      admission: "observed" as const,
      retry: "forbidden" as const,
      native: { messageID: intent.messageID, parentID: intent.messageID, providerID: "devin", modelID: scope.profile.modelID, mode: "forge-worker", agent: "forge-worker", cwd: scope.directory, root: scope.directory },
    };
    if (await headlessTurnRunning(record)) return { ...common, state: "running" as const, reason: "dispatch_process_running" };
    const exit = await readHeadlessText(files.exit);
    if (exit === null) return { ...common, state: "interrupted" as const, reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: record.generation } };
    if (!log?.trim()) return { ...common, state: "error" as const, reason: "native_startup_failed" };
    if (exit.trim() !== "0") return { ...common, state: "error" as const, reason: "native_error" };
    if (!await readDevinSessionId(runtimeDirectory)) {
      const sessionId = await discoverDevinSessionId(await this.executable(), scope.directory);
      if (sessionId) await writeFile(join(runtimeDirectory, "session.json"), JSON.stringify({ sessionId }), { mode: 0o600 });
    }
    return { ...common, state: "completed" as const, assistantMessageID: intent.messageID };
  }

  async dispatch(scope: TaskScope, intent: PromptIntent, claim: (generation: string) => Promise<boolean>): Promise<PromptObservation> {
    this.supported(scope);
    const runtimeDirectory = this.runtimeDirectory(scope);
    const before = await this.observe(scope, intent);
    if (before.retry !== "allowed") throw new Error("Devin prompt was not proven absent; replay is blocked");
    const executable = await this.executable();
    const files = headlessTurnFiles(runtimeDirectory, intent.messageID);
    const resumeSessionId = await readDevinSessionId(runtimeDirectory);
    const record = await dispatchHeadless({ runtimeDirectory, scope, intent, executable, args: devinArguments({ scope, resumeSessionId, promptFile: files.prompt }), prompt: rolePrompt(scope, intent), claim, label: "Devin" });
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
    return devinResultText(await readHeadlessText(files.log) ?? "") || (await readHeadlessText(files.stderr) ?? "").trim().slice(-2_000);
  }

  async turnEvidence(): Promise<{ tools: []; limit: string }> {
    return { tools: [], limit: "Devin CLI --print does not document machine-readable tool evidence." };
  }
}
