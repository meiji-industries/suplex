import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { HerdrClient, PaneProcessInfo } from "./herdr-client.js";
import type { OpenCodePromptIntent, OpenCodePromptObservation } from "./opencode-session.js";
import type { RootIdentity } from "./root-contracts.js";
import type { PromptDispatchAttempt, TaskSession } from "./task-control.js";
import type { TaskExecution } from "./task-execution-contracts.js";
import type { TaskUsage } from "./task-usage.js";
import { splitBalancedPaneRow } from "./task-pane-layout.js";
import type { WorkflowId } from "./workflows.js";

// The prompt intent and observation vocabulary was designed against OpenCode
// and is shared by every harness. Claude Code maps its own evidence onto it.
export type PromptIntent = OpenCodePromptIntent;
export type PromptObservation = OpenCodePromptObservation;

export interface TaskProfileSelection {
  providerID: string;
  modelID: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier: "default" | "priority";
}

export type TaskScope = {
  id: string;
  taskId: string;
  directory: string;
  profile: TaskProfileSelection;
  workflow: WorkflowId;
  evidenceRoot: string | null;
} & ({ role: "root"; identity: RootIdentity } | { role: "worker"; workerMode: "planned" | "direct"; purpose: "implementation" | "verification" } | { role: "advisor"; label: string });

export interface TaskHarness {
  ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string>;
  attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; persistPane: (paneId: string) => void }): Promise<string>;
  observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation>;
  dispatch(scope: TaskScope, intent: PromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<PromptObservation>;
  recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation>;
  resultText(scope: TaskScope, observation: PromptObservation): Promise<string>;
  turnEvidence(scope: TaskScope, observation: PromptObservation): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; limit: string | null }>;
  stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void>;
}

export type HarnessKind = "opencode" | "claude-code";
export const CLAUDE_CODE_PROVIDER = "claude-code";
// ponytail: static alias list; Claude Code has no model listing command.
export const CLAUDE_CODE_MODELS = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export function profileHarness(providerID: string): HarnessKind {
  return providerID === CLAUDE_CODE_PROVIDER ? "claude-code" : "opencode";
}

// ponytail: native ids are shaped differently (OpenCode "ses…", Claude Code a
// UUID), so sessions carry no harness column. Add one if a third harness appears.
export function sessionHarness(nativeSessionId: string): HarnessKind {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeSessionId) ? "claude-code" : "opencode";
}

export function taskSessionRuntimeDirectory(databasePath: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) throw new Error("Invalid task session identity");
  return join(dirname(databasePath), "runtime", "task-sessions", sessionId);
}

export function taskSessionTitle(scope: TaskScope): string {
  return `${scope.taskId} ${taskSessionRole(scope)}`;
}

export function taskSessionRole(scope: TaskScope): string {
  return scope.role === "root" ? "Coordinator" : scope.role === "advisor" ? scope.label : "Worker";
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Writes the Coordinator bridge binding and returns the MCP server command that serves it. */
export async function writeRootBridgeBinding(input: { runtimeDirectory: string; identity: RootIdentity; databasePath: string; artifactRoot: string | undefined }): Promise<{ command: string; args: string[] }> {
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const currentFile = fileURLToPath(import.meta.url);
  const source = currentFile.endsWith(".ts");
  const bindingPath = join(input.runtimeDirectory, "root.binding.json");
  const server = {
    command: process.execPath,
    args: [
      ...(source ? [join(dirname(currentFile), "..", "node_modules", "tsx", "dist", "cli.mjs")] : []),
      join(dirname(currentFile), source ? "root-bridge.ts" : "root-bridge.js"), "--binding", bindingPath,
    ],
  };
  await writeFile(bindingPath, JSON.stringify({ version: 1, root: input.identity, databasePath: input.databasePath, artifactRoot: input.artifactRoot ?? join(dirname(input.databasePath), "artifacts"), server }), { mode: 0o600 });
  await chmod(bindingPath, 0o600);
  return server;
}

export type TaskPanePort = Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> & Partial<Pick<HerdrClient, "getPaneLayout" | "resizePane">>;

const shells = ["zsh", "bash", "sh", "fish", "nu", "pwsh"];

export function isShellProcess(process: { pid: number; name: string }, shellPid: number | undefined): boolean {
  return process.pid === shellPid && shells.includes(basename(process.name));
}

export function isInteractiveShell(info: PaneProcessInfo): boolean {
  const foreground = info.foreground_processes[0];
  return info.foreground_processes.length === 1 && foreground !== undefined && info.foreground_process_group_id === info.shell_pid && isShellProcess(foreground, info.shell_pid);
}

/**
 * Attaches a Herdr pane to a native session. The pane is only a display: a
 * missing or replaced pane never proves anything about the native work.
 */
export async function attachTaskDisplay(herdr: TaskPanePort, input: {
  scope: TaskScope;
  nativeSessionId: string;
  paneId: string | null;
  rootPaneId?: string | null;
  persistPane: (paneId: string) => void;
  generation: string;
  isAttached: (argv: readonly string[]) => boolean;
  command: string;
}): Promise<string> {
  const { scope } = input;
  const title = taskSessionTitle(scope);
  const metadata = (paneId: string) => ({
    paneId,
    source: "forge",
    title,
    tokens: {
      forge_binding_id: scope.id,
      forge_task_id: scope.taskId,
      forge_native_session_id: input.nativeSessionId,
      forge_server_generation: input.generation,
      forge_task: scope.taskId,
      forge_role: taskSessionRole(scope),
      forge_model: scope.profile.modelID,
      forge_provider: scope.profile.providerID,
    },
  });
  const publishMetadata = async (paneId: string): Promise<void> => {
    await Promise.allSettled([
      Promise.resolve().then(() => herdr.renamePane(paneId, title)),
      Promise.resolve().then(() => herdr.reportPaneMetadata(metadata(paneId))),
    ]);
  };
  let pane = input.paneId ? await herdr.getPane(input.paneId) : null;
  if (pane) {
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    if (info.foreground_processes.some(process => process.argv !== undefined && input.isAttached(process.argv))) {
      input.persistPane(pane.paneId);
      await publishMetadata(pane.paneId);
      return pane.paneId;
    }
    const owned = pane.tokens?.forge_binding_id === scope.id || !pane.tokens?.forge_binding_id && pane.cwd === scope.directory;
    if (owned && info.foreground_processes.length === 0) throw new Error("The task display process could not be inspected");
    if (!owned || !isInteractiveShell(info)) pane = null;
  }
  pane ??= input.rootPaneId && await herdr.getPane(input.rootPaneId)
    ? await splitBalancedPaneRow(herdr, { paneId: input.rootPaneId, cwd: scope.directory })
    : (await herdr.createWorkspace({ label: `forge-${scope.taskId}`, cwd: scope.directory, focus: false })).rootPane;
  input.persistPane(pane.paneId);
  await publishMetadata(pane.paneId);
  const deadline = Date.now() + 2_000;
  for (;;) {
    const info = await herdr.getPaneProcessInfo(pane.paneId);
    if (isInteractiveShell(info)) break;
    if (Date.now() >= deadline) throw new Error("The task display is not at an interactive shell");
    await delay(100);
  }
  await herdr.runPaneCommand(pane.paneId, input.command);
  return pane.paneId;
}

/** Routes each call to the harness selected by the task profile or the native session identity. */
export class HarnessRouter implements TaskHarness {
  constructor(private readonly harnesses: Record<HarnessKind, TaskHarness>) {}
  private forScope(scope: Pick<TaskScope, "profile">): TaskHarness { return this.harnesses[profileHarness(scope.profile.providerID)]; }
  ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> { return this.forScope(scope).ensureSession(scope, nativeSessionId); }
  attach(input: Parameters<TaskHarness["attach"]>[0]): Promise<string> { return this.forScope(input.scope).attach(input); }
  observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> { return this.forScope(scope).observe(scope, intent, attempt); }
  dispatch(scope: TaskScope, intent: PromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<PromptObservation> { return this.forScope(scope).dispatch(scope, intent, claim); }
  recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation> { return this.forScope(scope).recoverDispatch(scope, intent, attempt); }
  resultText(scope: TaskScope, observation: PromptObservation): Promise<string> { return this.forScope(scope).resultText(scope, observation); }
  turnEvidence(scope: TaskScope, observation: PromptObservation): ReturnType<TaskHarness["turnEvidence"]> { return this.forScope(scope).turnEvidence(scope, observation); }
  stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    return this.harnesses[nativeSessionId ? sessionHarness(nativeSessionId) : "opencode"].stop(scope, nativeSessionId);
  }
}

/** Read-only observation of a native session for the UI, analytics, diagnostics, and Archive. */
export interface NativeSessionReader {
  execution(session: TaskSession): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; plan: TaskExecution["sessions"][number]["plan"]; limited: boolean }>;
  status(session: TaskSession): Promise<{ status: "busy" | "retry" | "idle"; updatedAt: number }>;
  timeline(session: TaskSession): Promise<{ usage: TaskUsage[]; liveMessageId: string | null }>;
  /** Refuses while the agent is active; returns the display matcher and the stop action for Archive. */
  archive(session: TaskSession): Promise<{ display: ((argv: readonly string[]) => boolean) | null; stop: () => Promise<void> }>;
}
