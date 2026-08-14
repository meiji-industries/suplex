import type { AgentFailure } from "../agent-failure.js";
import type { ExecutionReceipt } from "../developer-contracts.js";
import type { HealthCheck } from "../health.js";
import type { OwnedProcess, ProcessController, ProcessInspection } from "../process-manager.js";
import type { SessionStore } from "../session-store.js";
import type { CommandRunner } from "../provider-readiness.js";

export type { SessionStore } from "../session-store.js";

export interface LeadInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  durable?: { runtimeRoot: string; executionId: string; pathOverride?: string };
  signal?: AbortSignal;
  onStart: (pid: number, startedAt: string, inspection?: ProcessInspection) => Promise<void>;
  onLine: (line: string) => Promise<void>;
}

export interface LeadProcessResult {
  exitCode: number;
  stderr: string;
}

export type LeadProcessRunner = (invocation: LeadInvocation) => Promise<LeadProcessResult>;

export interface AgentProfileSettings {
  model: string;
  reasoningLevel: string;
  servicePriority: string;
}

export interface AgentTurnRequest {
  prompt: string;
  resumeSessionId?: string | undefined;
  profile?: AgentProfileSettings | undefined;
  networkAccess?: boolean | undefined;
  addDirectories?: string[] | undefined;
  imagePaths?: string[] | undefined;
}

export interface AgentEvent {
  type?: string | undefined;
  threadId?: string | undefined;
  sessionRef?: string | undefined;
  itemText?: string | undefined;
}

export interface AgentTurnWrapperSettings {
  model: string;
  reasoningLevel: "low" | "medium" | "high" | "xhigh";
  servicePriority: "standard" | "priority" | "fast";
}

export interface AgentTurnWrapperRequest extends AgentTurnWrapperSettings {
  command: string;
  cwd: string;
  outputSchemaPath: string;
  promptPath: string;
  repositoryPath: string;
  imagePaths?: string[];
  resumeSessionRef?: string;
  sessionRef?: string;
  sessionStoreRoot: string;
  spoolPath: string;
  statusPath: string;
}

export interface PreparedAgentTurnWrapper {
  command: string;
  args: string[];
  cwd: string;
  wrapperRequestPath: string;
  spoolPath: string;
  statusPath: string;
}

export interface AgentTurnSupervisor {
  sanitizeLine(line: string): string;
  failureSummary(code: string): string;
  assertSessionIdentity(expected: string | undefined, observed: string | undefined): void;
  cancelOwnedProcess(owned: OwnedProcess, observed?: ProcessInspection): Promise<boolean>;
}

export interface AgentTranscriptOptions {
  executionId: string;
  attempt: number;
  worktreePath?: string;
  authorizedStepNumbers?: number[];
  state?: unknown;
}

export interface AgentTranscript {
  receipts: ExecutionReceipt[];
  threadId?: string;
  finalReport?: unknown;
  malformedLines: number;
  parserState?: unknown;
}

export interface AgentReadinessProbe {
  check(): Promise<HealthCheck>;
}

/**
 * The seam between Forge's role services (Lead, Developer, readiness/health)
 * and a concrete agent CLI. Everything provider-specific — command resolution,
 * argv construction, stdout/JSONL event parsing, session-ref extraction,
 * failure classification, supervised-turn wrappers, and readiness probing —
 * lives behind this interface. Prompts and output schemas stay role-owned.
 */
export interface AgentProvider {
  readonly id: string;
  /** Durable/spawning default process runner for this provider's CLI. */
  readonly processRunner: LeadProcessRunner;
  /** Resolve the executable, applying provider env-var and PATH fallbacks. */
  resolveCommand(command?: string, executablePath?: string): string;
  /** Build the CLI argv for one turn (new session or resume). */
  buildTurnArgs(request: AgentTurnRequest): string[];
  /** Parse one stdout line into the neutral event shape. */
  parseEvent(line: string): AgentEvent;
  /** Extract the ordered agent-message texts from raw output lines. */
  agentMessages(lines: string[]): string[];
  /** Redact one raw output line for evidence persistence. */
  sanitizeLine(line: string): string;
  /** Classify a failed invocation into a typed AgentFailure. */
  classifyProcessFailure(result: LeadProcessResult, outputLines?: string[], model?: string): AgentFailure;
  createSessionStore(root: string): SessionStore;
  createTurnSupervisor(controller?: ProcessController): AgentTurnSupervisor;
  /** Prepare the detached supervised-turn wrapper for one execution. */
  prepareTurnWrapper(request: AgentTurnWrapperRequest, executionRoot: string): Promise<PreparedAgentTurnWrapper>;
  /** Verify the installed CLI supports the pinned model/reasoning/tier. */
  assertTurnCompatibility(command: string, settings: AgentProfileSettings): Promise<void>;
  /** Parse a supervised execution transcript into receipts + final report. */
  parseExecutionTranscript(lines: Iterable<string>, options: AgentTranscriptOptions): AgentTranscript;
  /** Version/auth/smoke readiness probe; command defaults from provider env. */
  readinessProbe(command?: string, runner?: CommandRunner): AgentReadinessProbe;
}
