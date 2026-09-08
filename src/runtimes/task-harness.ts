import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodePromptIntent, OpenCodePromptObservation } from "./opencode/session.js";
import type { RootIdentity } from "../coordination/root-contracts.js";
import type { PromptDispatchAttempt, TaskSession } from "../tasks/control.js";
import type { TaskExecution } from "../tasks/execution/contracts.js";
import type { TaskUsage } from "../tasks/usage.js";
import type { ModelPricingCatalog } from "../profiles/model-pricing.js";
import type { AdvisorRole, WorkflowId } from "../coordination/workflows.js";

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
} & ({ role: "root"; identity: RootIdentity } | { role: "worker"; workerMode: "planned" | "direct"; purpose: "implementation" | "verification" } | { role: "advisor"; advisorRole: AdvisorRole; label: string });

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
      ...(source ? [join(dirname(currentFile), "..", "..", "node_modules", "tsx", "dist", "cli.mjs")] : []),
      join(dirname(currentFile), "..", "coordination", source ? "root-bridge.ts" : "root-bridge.js"), "--binding", bindingPath,
    ],
  };
  await writeFile(bindingPath, JSON.stringify({ version: 1, root: input.identity, databasePath: input.databasePath, artifactRoot: input.artifactRoot ?? join(dirname(input.databasePath), "artifacts"), server }), { mode: 0o600 });
  await chmod(bindingPath, 0o600);
  return server;
}

export async function writeAdvisorReportBridgeBinding(input: { runtimeDirectory: string; role: AdvisorRole }): Promise<{ command: string; args: string[] }> {
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const currentFile = fileURLToPath(import.meta.url);
  const source = currentFile.endsWith(".ts");
  const bindingPath = join(input.runtimeDirectory, "advisor.binding.json");
  const server = {
    command: process.execPath,
    args: [
      ...(source ? [join(dirname(currentFile), "..", "..", "node_modules", "tsx", "dist", "cli.mjs")] : []),
      join(dirname(currentFile), "..", "coordination", source ? "advisor-report-bridge.ts" : "advisor-report-bridge.js"), "--binding", bindingPath,
    ],
  };
  await writeFile(bindingPath, JSON.stringify({ version: 1, role: input.role }), { mode: 0o600 });
  await chmod(bindingPath, 0o600);
  return server;
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
  /** Reads one admitted native turn. Stored completion observations are not required for correlation. */
  turnEvidence(session: TaskSession, turnId: string): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; limitation: string | null }>;
  status(session: TaskSession): Promise<{ status: "busy" | "retry" | "idle"; updatedAt: number }>;
  timeline(session: TaskSession, pricing?: ModelPricingCatalog): Promise<{ usage: TaskUsage[]; liveMessageId: string | null }>;
  /** Refuses while the agent is active; returns the stop action for Archive. */
  archive(session: TaskSession): Promise<{ stop: () => Promise<void> }>;
}
