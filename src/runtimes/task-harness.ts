import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HARNESS_KIND_IDS, type HarnessKind } from "./harness-kind.js";
import type { ProjectMcp } from "./project-mcp.js";
import { StructuredLogger } from "../platform/logging.js";
import { resolveGhExecutable } from "../platform/executable-resolver.js";
import type { OpenCodePromptIntent, OpenCodePromptObservation } from "./opencode/session.js";
import type { RootIdentity } from "../coordination/root-contracts.js";
import type { PromptDispatchAttempt, TaskSession } from "../tasks/control.js";
import type { TaskExecution } from "../tasks/execution/contracts.js";
import type { TaskUsage } from "../tasks/usage.js";
import type { ModelPricingCatalog } from "../profiles/model-pricing.js";
import type { NativeHistoryMessage } from "../tasks/history/contracts.js";
import type { AdvisorRole, WorkflowId } from "../coordination/workflows.js";
import { ADVISOR_BRIDGE_BINDING_ENV, ADVISOR_BRIDGE_TOKEN_ENV, BridgeTokenSchema, ROOT_BRIDGE_BINDING_ENV, ROOT_BRIDGE_TOKEN_ENV, TASK_BRIDGE_ENVIRONMENT_KEYS } from "../coordination/bridge-auth.js";

// The prompt intent and observation vocabulary was designed against OpenCode
// and is shared by every harness. Claude Code maps its own evidence onto it.
export type PromptIntent = OpenCodePromptIntent;
export type PromptObservation = OpenCodePromptObservation;

export interface TaskProfileSelection {
  providerID: string;
  modelID: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier: "default" | "priority";
  instanceHomeDirectory?: string | null;
}

export type TaskScope = {
  id: string;
  taskId: string;
  directory: string;
  profile: TaskProfileSelection;
  workflow: WorkflowId;
  evidenceRoot: string | null;
  projectMcp?: ProjectMcp;
  projectContext?: string;
  projectContextPath?: string;
  projectEnvironment?: Record<string, string>;
  excludedEnvironmentKeys?: string[];
} & ({ role: "root"; identity: RootIdentity } | { role: "worker"; workerMode: "planned" | "direct"; purpose: "implementation" | "verification" } | { role: "advisor"; advisorRole: AdvisorRole; label: string });

export interface TaskHarness {
  ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string>;
  attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; shellPaneId?: string | null; persistPane: (paneId: string) => void; persistShellPane?: (paneId: string) => void }): Promise<string>;
  observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation>;
  dispatch(scope: TaskScope, intent: PromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<PromptObservation>;
  recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation>;
  resultText(scope: TaskScope, observation: PromptObservation): Promise<string>;
  turnEvidence(scope: TaskScope, observation: PromptObservation): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; limit: string | null }>;
  stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void>;
}

export type { HarnessKind };
export const CLAUDE_CODE_PROVIDER = "claude-code";
// ponytail: static alias list; Claude Code has no model listing command.
export const CLAUDE_CODE_MODELS = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];
// Devin's documented aliases resolve current model families; its model listing is account scoped.
export const DEVIN_MODELS = [{ id: "swe", label: "SWE (latest)" }, { id: "swe-2", label: "SWE-2" }, { id: "opus", label: "Opus (latest)" }, { id: "gpt", label: "GPT (latest)" }];
// Fallback when Codex has not written its model cache yet.
export const CODEX_MODELS = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

/** A profile provider is already a harness kind; a snapshot that escaped the migration ran on OpenCode. */
export function profileHarness(providerID: string): HarnessKind {
  return (HARNESS_KIND_IDS as readonly string[]).includes(providerID) ? providerID as HarnessKind : "opencode";
}

export function supportsProviderInstances(providerID: string): boolean {
  return providerID === "claude-code";
}

// Suplex reserves Devin and Codex identities with a prefix, because a Codex
// thread id is itself a UUID. Native IDs otherwise remain backwards-compatible:
// OpenCode uses "ses…" and Claude Code uses UUIDs.
export function sessionHarness(nativeSessionId: string): HarnessKind {
  if (nativeSessionId.startsWith("devin-")) return "devin";
  if (nativeSessionId.startsWith("codex-")) return "codex";
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

export type TaskBridgeServer = { command: string; args: string[]; environment: Record<string, string> };

export function taskBridgeEnvironment(server: TaskBridgeServer | undefined, inherited: NodeJS.ProcessEnv = process.env, additions: Record<string, string> = {}): NodeJS.ProcessEnv {
  const blocked = new Set<string>(TASK_BRIDGE_ENVIRONMENT_KEYS);
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => !blocked.has(key) && value !== undefined));
  return { ...clean, ...server?.environment, ...additions };
}

export function advisorBridgeResultPath(runtimeDirectory: string, turnId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(turnId)) throw new Error("Invalid Advisor turn identity");
  return join(runtimeDirectory, `turn-${turnId}.advisor-report.json`);
}

function bridgeCommand(kind: "root" | "advisor"): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const source = currentFile.endsWith(".ts");
  const script = kind === "root" ? "root-bridge" : "advisor-report-bridge";
  return {
    command: process.execPath,
    args: [
      ...(source ? [join(dirname(currentFile), "..", "..", "node_modules", "tsx", "dist", "cli.mjs")] : []),
      join(dirname(currentFile), "..", "coordination", `${script}.${source ? "ts" : "js"}`),
    ],
  };
}

const bridgeEnvironmentNames = {
  root: { binding: ROOT_BRIDGE_BINDING_ENV, token: ROOT_BRIDGE_TOKEN_ENV },
  advisor: { binding: ADVISOR_BRIDGE_BINDING_ENV, token: ADVISOR_BRIDGE_TOKEN_ENV },
} as const;
const bridgeLogger = new StructuredLogger();
let ghResolutionFailureLogged = false;

/** The bridge command with `${VAR}` placeholders, for hosts that interpolate their MCP environment (Devin's project-local config). */
export function environmentBridgeServer(kind: "root" | "advisor", ghCommand: string | null): TaskBridgeServer {
  const names = bridgeEnvironmentNames[kind];
  return { ...bridgeCommand(kind), environment: { [names.binding]: `\${${names.binding}}`, [names.token]: `\${${names.token}}`, ...(ghCommand ? { SUPLEX_GH_COMMAND: ghCommand } : {}) } };
}

export async function resolvedGhCommand(): Promise<string | null> {
  try { return await resolveGhExecutable(); }
  catch (error) {
    if (!ghResolutionFailureLogged) {
      ghResolutionFailureLogged = true;
      bridgeLogger.warn("GitHub CLI could not be resolved for task bridges", {}, { error: error instanceof Error ? error.message : String(error) });
    }
    return null;
  }
}

// A binding rewrite keeps the existing token so bridges already launched from
// this runtime directory keep authenticating; the identity is rewritten anyway.
async function existingToken(path: string): Promise<string | null> {
  try {
    const parsed = z.object({ token: BridgeTokenSchema }).passthrough().safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data.token : null;
  } catch {
    return null;
  }
}

async function writeBinding(kind: "root" | "advisor", runtimeDirectory: string, identity: object): Promise<TaskBridgeServer> {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  const path = join(runtimeDirectory, `${kind}.binding.json`);
  const token = await existingToken(path) ?? randomUUID();
  const pending = `${path}.${randomUUID()}.pending`;
  await writeFile(pending, JSON.stringify({ ...identity, token }), { mode: 0o600 });
  await rename(pending, path);
  const names = bridgeEnvironmentNames[kind];
  const ghCommand = await resolvedGhCommand();
  return { ...bridgeCommand(kind), environment: { [names.binding]: path, [names.token]: token, ...(ghCommand ? { SUPLEX_GH_COMMAND: ghCommand } : {}) } };
}

/** Writes the Coordinator bridge binding and returns the MCP server command that serves it. */
export async function writeRootBridgeBinding(input: { runtimeDirectory: string; identity: RootIdentity; databasePath: string; artifactRoot: string | undefined }): Promise<TaskBridgeServer> {
  const server = bridgeCommand("root");
  return writeBinding("root", input.runtimeDirectory, { version: 1, root: input.identity, databasePath: input.databasePath, artifactRoot: input.artifactRoot ?? join(dirname(input.databasePath), "artifacts"), server });
}

export async function writeAdvisorReportBridgeBinding(input: { runtimeDirectory: string; role: AdvisorRole }): Promise<TaskBridgeServer> {
  return writeBinding("advisor", input.runtimeDirectory, { version: 1, role: input.role, server: bridgeCommand("advisor") });
}

/** Routes each call to the harness selected by the task profile or the native session identity. */
export class HarnessRouter implements TaskHarness {
  constructor(private readonly harnesses: Partial<Record<HarnessKind, TaskHarness>>) {}
  private forScope(scope: Pick<TaskScope, "profile">): TaskHarness { const harness = this.harnesses[profileHarness(scope.profile.providerID)]; if (!harness) throw new Error(`No task harness for ${scope.profile.providerID}`); return harness; }
  ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> { return this.forScope(scope).ensureSession(scope, nativeSessionId); }
  attach(input: Parameters<TaskHarness["attach"]>[0]): Promise<string> { return this.forScope(input.scope).attach(input); }
  observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> { return this.forScope(scope).observe(scope, intent, attempt); }
  async dispatch(scope: TaskScope, intent: PromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<PromptObservation> {
    const prepared = scope.projectContextPath ? await readFile(scope.projectContextPath, "utf8").catch(() => "Prepared project context is unavailable. Inspect the actual worktree and configured skill sources before continuing.") : "";
    const context = [scope.projectContext, prepared].filter(Boolean).join("\n\n");
    return this.forScope(scope).dispatch(scope, context ? { ...intent, prompt: `${context}\n\n${intent.prompt}` } : intent, claim);
  }
  recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation> { return this.forScope(scope).recoverDispatch(scope, intent, attempt); }
  resultText(scope: TaskScope, observation: PromptObservation): Promise<string> { return this.forScope(scope).resultText(scope, observation); }
  turnEvidence(scope: TaskScope, observation: PromptObservation): ReturnType<TaskHarness["turnEvidence"]> { return this.forScope(scope).turnEvidence(scope, observation); }
  stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    const harness = this.harnesses[nativeSessionId ? sessionHarness(nativeSessionId) : "opencode"];
    if (!harness) throw new Error("No task harness for session");
    return harness.stop(scope, nativeSessionId);
  }
}

/** Read-only observation of a native session for the UI, analytics, diagnostics, and Archive. */
export interface NativeSessionReader {
  /** Reads the authoritative native conversation snapshot without changing session state. */
  history(session: TaskSession): Promise<NativeHistoryMessage[]>;
  execution(session: TaskSession): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; plan: TaskExecution["sessions"][number]["plan"]; limited: boolean }>;
  /** Reads one admitted native turn. Stored completion observations are not required for correlation. */
  turnEvidence(session: TaskSession, turnId: string): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; limitation: string | null }>;
  status(session: TaskSession): Promise<{ status: "busy" | "retry" | "idle"; updatedAt: number }>;
  timeline(session: TaskSession, pricing?: ModelPricingCatalog): Promise<{ usage: TaskUsage[]; liveMessageId: string | null }>;
  /** Refuses while the agent is active; returns the stop action for Archive. */
  archive(session: TaskSession): Promise<{ stop: () => Promise<void> }>;
}
