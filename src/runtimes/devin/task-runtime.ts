import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveDevinExecutable } from "../../platform/executable-resolver.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "../../tasks/control.js";
import { taskRolePrompt } from "../../tasks/execution/role-prompt.js";
import { dispatchHeadless, headlessObservationPrelude, headlessSessionBusy, headlessTurnFiles, headlessTurnRunning, readHeadlessText, readHeadlessTurnRecord, recoverHeadlessDispatch, stopHeadlessSession } from "../headless/turn-process.js";
import { advisorBridgeResultPath, taskBridgeEnvironment, taskSessionRuntimeDirectory, writeAdvisorReportBridgeBinding, writeRootBridgeBinding, type PromptIntent, type PromptObservation, type TaskBridgeServer, type TaskHarness, type TaskScope } from "../task-harness.js";
import { attachTaskDisplay, type TaskPanePort } from "../task-display.js";
import { devinResultText } from "./transcript.js";
import { ensureDevinMcpConfig } from "./mcp-config.js";
import { readDevinAdvisorEvidence } from "./advisor-evidence.js";
import { devinDisplayAttached, devinDisplayCommand } from "./display.js";

const DevinExportSchema = z.object({ session_id: z.string().trim().min(1) }).passthrough();

export async function readDevinSessionId(runtimeDirectory: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(runtimeDirectory, "session.json"), "utf8"));
    return typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

// A missing or malformed export yields null so observe() reports the turn
// rather than throwing on every poll; the next turn writes a fresh export.
async function readDevinExportSessionId(path: string): Promise<string | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return null; }
  await chmod(path, 0o600);
  const exported = DevinExportSchema.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  return exported.success ? exported.data.session_id : null;
}

async function persistDevinSessionId(runtimeDirectory: string, sessionId: string): Promise<void> {
  const path = join(runtimeDirectory, "session.json");
  const pending = `${path}.${randomUUID()}.pending`;
  await writeFile(pending, JSON.stringify({ sessionId }), { mode: 0o600 });
  await rename(pending, path);
}

async function recoverDevinSessionId(runtimeDirectory: string): Promise<string | null> {
  const stored = await readDevinSessionId(runtimeDirectory);
  if (stored) return stored;
  const turn = await readHeadlessTurnRecord(join(runtimeDirectory, "turn.json"));
  const candidates = [
    ...(turn ? [join(runtimeDirectory, `turn-${turn.turnId}.export.json`)] : []),
    join(runtimeDirectory, "warmup.export.json"),
  ];
  for (const path of candidates) {
    const sessionId = await readDevinExportSessionId(path);
    if (!sessionId) continue;
    await persistDevinSessionId(runtimeDirectory, sessionId);
    return sessionId;
  }
  return null;
}

export async function devinSessionBusy(runtimeDirectory: string): Promise<boolean> {
  return headlessSessionBusy(runtimeDirectory);
}

/** Arguments are restricted to the documented Devin CLI flags. */
export function devinArguments(input: { scope: TaskScope; resumeSessionId: string | null; promptFile: string; exportFile?: string }): string[] {
  return [
    "--print",
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    "--prompt-file", input.promptFile,
    "--export", input.exportFile ?? `${input.promptFile}.export.json`,
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
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string; artifactRoot?: string } = {}) {}

  private runtimeDirectory(scope: Pick<TaskScope, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, scope.id);
  }

  private executable(): Promise<string> {
    return resolveDevinExecutable(this.options.executable ? { executable: this.options.executable } : {});
  }

  private async bridge(scope: TaskScope): Promise<TaskBridgeServer | undefined> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    if (scope.role === "root") return writeRootBridgeBinding({ runtimeDirectory, identity: scope.identity, databasePath: this.databasePath, artifactRoot: this.options.artifactRoot });
    if (scope.role === "advisor") return writeAdvisorReportBridgeBinding({ runtimeDirectory, role: scope.advisorRole });
    return undefined;
  }

  private async prepare(scope: TaskScope): Promise<TaskBridgeServer | undefined> {
    const bridge = await this.bridge(scope);
    if (bridge) await ensureDevinMcpConfig(scope.directory);
    return bridge;
  }

  async ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> {
    await mkdir(this.runtimeDirectory(scope), { recursive: true, mode: 0o700 });
    await this.executable();
    await this.prepare(scope);
    await recoverDevinSessionId(this.runtimeDirectory(scope));
    return nativeSessionId ?? `devin-${randomUUID()}`;
  }

  async attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; persistPane: (paneId: string) => void }): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(input.scope);
    const display = devinDisplayCommand(runtimeDirectory);
    return attachTaskDisplay(this.herdr, { ...input, generation: input.nativeSessionId, isAttached: args => devinDisplayAttached(runtimeDirectory, args), command: display.command });
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
      native: { messageID: intent.messageID, parentID: intent.messageID, providerID: "devin", modelID: scope.profile.modelID, mode: `suplex-${scope.role}`, agent: `suplex-${scope.role}`, cwd: scope.directory, root: scope.directory },
    };
    if (await headlessTurnRunning(record)) return { ...common, state: "running" as const, reason: "dispatch_process_running" };
    const exit = await readHeadlessText(files.exit);
    if (exit === null) return { ...common, state: "interrupted" as const, reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: record.generation } };
    if (!log?.trim()) return { ...common, state: "error" as const, reason: "native_startup_failed" };
    if (exit.trim() !== "0") return { ...common, state: "error" as const, reason: "native_error" };
    if (!await readDevinSessionId(runtimeDirectory)) {
      const sessionId = await readDevinExportSessionId(join(runtimeDirectory, `turn-${intent.messageID}.export.json`));
      if (sessionId) await persistDevinSessionId(runtimeDirectory, sessionId);
    }
    return { ...common, state: "completed" as const, assistantMessageID: intent.messageID };
  }

  async dispatch(scope: TaskScope, intent: PromptIntent, claim: (generation: string) => Promise<boolean>): Promise<PromptObservation> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const before = await this.observe(scope, intent);
    if (before.retry !== "allowed") throw new Error("Devin prompt was not proven absent; replay is blocked");
    const executable = await this.executable();
    const bridge = await this.prepare(scope);
    const files = headlessTurnFiles(runtimeDirectory, intent.messageID);
    const resumeSessionId = await recoverDevinSessionId(runtimeDirectory);
    const additions = scope.role === "advisor" ? { SUPLEX_ADVISOR_RESULT: advisorBridgeResultPath(runtimeDirectory, intent.messageID) } : {};
    const record = await dispatchHeadless({ runtimeDirectory, scope, intent, executable, args: devinArguments({ scope, resumeSessionId, promptFile: files.prompt, exportFile: join(runtimeDirectory, `turn-${intent.messageID}.export.json`) }), prompt: rolePrompt(scope, intent), environment: taskBridgeEnvironment(bridge, process.env, additions), claim, label: "Devin" });
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

  async turnEvidence(scope: TaskScope, observation: PromptObservation): ReturnType<TaskHarness["turnEvidence"]> {
    const evidence = await readDevinAdvisorEvidence(this.runtimeDirectory(scope), observation.messageID);
    return { tools: evidence.tools, limit: evidence.limitation };
  }
}
