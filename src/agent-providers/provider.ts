import type { HealthCheck } from "../health.js";
import type { CommandRunner } from "../provider-readiness.js";
import type { z } from "zod";
export { AGENT_PROVIDER_KINDS, PROVIDER_HARNESSES, type AgentProviderKind, type HerdrAgentKind } from "./kinds.js";
import type { AgentProviderKind } from "./kinds.js";

export interface AgentProfileSettings {
  provider: AgentProviderKind;
  model: string;
  reasoningLevel: string;
  servicePriority: string;
}

export interface AgentReadinessProbe {
  check(): Promise<HealthCheck>;
}

/** A role-owned result schema and the durable coordinates for one TUI turn. */
export interface InteractiveTurnRequest<T = unknown> {
  task: { taskId: string; projectId: string; projectSlug: string; issueKey?: string; worktreePath: string; runtimeRoot: string };
  sessionRole: "lead" | "developer" | "reviewer";
  executionRole: "planner" | "reviewer" | "builder" | "integrator";
  ledger: "agent" | "developer";
  executionId: string;
  promptKind: string;
  prompt: string;
  profile: AgentProfileSettings;
  resultSchema: z.ZodType<T>;
  schemaPath: string;
  companyId: string;
  workflowId: string;
  revision: number;
}

export interface InteractiveTurnResult<T = unknown> { turnId: string; sessionId: string; result: T; resultHash: string; }

/**
 * The seam between Forge's role services (Lead, Developer, readiness/health)
 * and a concrete interactive CLI. Prompts and result schemas stay role-owned.
 */
export interface AgentProvider {
  readonly id: string;
  /** Version/auth/smoke readiness probe; command defaults from provider env. */
  readinessProbe(command?: string, runner?: CommandRunner): AgentReadinessProbe;
  runTurn<T>(request: InteractiveTurnRequest<T>): Promise<InteractiveTurnResult<T>>;
  forward(taskId: string, role: "lead" | "developer", text: string): Promise<void>;
  interrupt(taskId: string, role: "lead" | "developer"): Promise<void>;
}
