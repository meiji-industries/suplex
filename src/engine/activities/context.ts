import { createHash, randomBytes } from "node:crypto";

import { Context } from "../activity-context.js";
import { ApplicationFailure, CancelledFailure } from "../failures.js";
import { z } from "zod";

import { projectionStateHash, type ForgeDatabase } from "../../database.js";
import type { ForgeConfig } from "../../config.js";
import { ArtifactStore, type StoredArtifact } from "../../artifacts.js";
import { redact } from "../../logging.js";
import { AgentFailure, AgentService } from "../../codex-lead.js";
import { DeveloperService } from "../../codex-developer.js";
import { cancelDeveloperExecution, reconcileDeveloperExecutions } from "../../developer-recovery.js";
import { HerdrCodexProvider } from "../../agent-providers/herdr-codex.js";
import { CliHerdrClient } from "../../herdr-client.js";
import { observeHerdrSessions } from "../../herdr-recovery.js";
import { AcceptanceFailure, AcceptanceService } from "../../acceptance.js";
import { CiFailure, CiProviderFailure, CiService, createGithubCiProvider, type CiProvider } from "../../ci.js";
import { createGithubReleasePort, GithubReleaseFailure, ReleaseService, type GithubReleaseAdapter } from "../../github-release.js";
import { ForwardMergeFailure, ForwardMergeService } from "../../forward-merge.js";
import { parseAcceptedProjectRevision, type AcceptedProjectRevision, type ProjectRole } from "../../projects.js";
import { runPinnedVerification } from "../../verification.js";
import { createGitCommandGuard } from "../../worktrees.js";
import {
  ArtifactReferenceSchema,
  CreateSuccessorActivityInputSchema,
  DeliveryDecisionActivityInputSchema,
  CompletedDeliveryReviewLookupInputSchema,
  DeliveryReviewActivityInputSchema,
  DeliveryReviewActivityResultSchema,
  ReviewArbitrationActivityResultSchema,
  DeliveryReviewSchema,
  DeliveryOperationBlockCodeSchema,
  DeveloperRepairActivityInputSchema,
  DeveloperRepairActivityResultSchema,
  DurableArtifactReferenceSchema,
  IssueProjectionEventSchema,
  IssueWorkflowStateSchema,
  PreparePlanRevisionActivityInputSchema,
  PublishReleaseActivityResultSchema,
  ReconcileTargetBaseActivityInputSchema,
  RevisedExecutionCoordinatesSchema,
  SafeSummarySchema,
  createInitialIssueWorkflowState,
  normalizeSafeSummary,
  type AttentionCategory,
  type DeliveryReviewActivityResult,
  type DeliveryReviewServiceInput,
  type DeveloperTurnActivityOutcome,
  type DeveloperRepairActivityResult,
  type DurableArtifactReference,
  type TargetBaseBlockerCode,
} from "../issue-contracts.js";
import { PlanGovernanceConflict, PlanGovernanceRepository } from "../../plan-governance-repository.js";
import { StructuredLogger, activityLogContext } from "../../logging.js";
import { CapacityFailure, CapacityManager, type CapacityProfileIdentity } from "../../capacity.js";
import { CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema } from "../../capacity-contracts.js";
import { WorktreeFailure, WorktreeManager } from "../../worktrees.js";
import { readEnvironmentSettings } from "../../environment-settings.js";
import { startIssueWorkflow } from "../service.js";
import { jsonRequired } from "../../task-utils.js";
type OperationExecution = { signal?: AbortSignal | undefined };

async function reconcileAgentExecutions(database: ForgeDatabase, herdr = new CliHerdrClient()): Promise<Array<{ roleSessionId: string; status: "active" | "recoverable" | "unverifiable" | "failed" }>> {
  return (await observeHerdrSessions(database, herdr)).map((observation) => ({
    roleSessionId: observation.sessionId,
    status: observation.classification === "failed" ? "failed" : observation.classification === "active" ? "active" : observation.classification === "unverifiable" ? "unverifiable" : "recoverable",
  }));
}

async function cancelAgentExecution(database: ForgeDatabase, executionId: string): Promise<{ status: "cancelled"; reason?: string }> {
  const execution = database.authQuery((db) => db.prepare("SELECT task_id AS taskId FROM forge_agent_executions WHERE id = ? AND status IN ('starting', 'running')").get(executionId) as { taskId: string } | undefined);
  if (!execution) return { status: "cancelled", reason: "execution-not-active" };
  await new HerdrCodexProvider(database, new CliHerdrClient()).interrupt(execution.taskId, "lead");
  return { status: "cancelled" };
}

export interface ActivityOptions {
  agent?: Omit<Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "arbitrateReview" | "planDeliveryRepair" | "planMergeConflict" | "planCiRepair">>, "reviewDelivery"> & { reviewDelivery?: (input: DeliveryReviewServiceInput) => Promise<unknown> };
  developer?: Omit<Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">>, "runRepair"> & { runRepair?: (input: Parameters<DeveloperService["runRepair"]>[0]) => Promise<unknown> };
  githubRelease?: GithubReleaseAdapter;
  ciProvider?: CiProvider;
  capacity?: CapacityManager;
  logSink?: (line: string) => void;
}
export function asNonRetryableApplicationFailure(error: unknown): ApplicationFailure | undefined {
  if (error instanceof WorktreeFailure) {
    return ApplicationFailure.nonRetryable(error.message, error.code, { code: error.code, summary: error.message });
  }
  if (error instanceof PlanGovernanceConflict) {
    return ApplicationFailure.nonRetryable(error.message, error.code);
  }
  if (error instanceof Error && error.name === "SqliteError") {
    const code = /UNIQUE constraint failed/.test(error.message) ? "sqlite-unique-constraint" : "sqlite-error";
    return ApplicationFailure.nonRetryable(error.message, code, { code, summary: error.message });
  }
  if (!(error instanceof AgentFailure) || !error.nonRetryable) return undefined;
  return ApplicationFailure.nonRetryable(error.message, error.code, { code: error.code, summary: error.message });
}
export function asRetryableAgentFailure(error: unknown): ApplicationFailure | undefined {
  if (!(error instanceof AgentFailure) || error.code !== "rate-limited") return undefined;
  const retryAt = error.retryAt ?? (error.retryAfterMs !== undefined ? new Date(Date.now() + error.retryAfterMs).toISOString() : undefined);
  return ApplicationFailure.retryable(error.message, error.code, { ...(retryAt ? { retryAt } : {}), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) });
}
export function asNonRetryableCapacityFailure(error: unknown): ApplicationFailure | undefined {
  if (!(error instanceof CapacityFailure)) return undefined;
  if (error.code === "invalid-status") {
    const summary = "The previous Developer turn was interrupted and its capacity request cannot be reused — retry development.";
    return ApplicationFailure.nonRetryable(summary, error.code, { code: error.code, summary });
  }
  return ApplicationFailure.nonRetryable(error.message, error.code, { code: error.code, summary: error.message });
}
const LegacyPinnedProjectRevisionSchema = z.object({
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  repository: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/),
  baseBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  requiredChecks: z.array(z.string()),
  setupCommand: z.string().min(1),
  verificationCommand: z.string().min(1),
});
const DeveloperDeliverySchema = z.object({ steps: z.array(z.object({ filesChanged: z.array(z.string()).optional(), commandsRun: z.array(z.string()).optional(), testResults: z.array(z.string()).optional() }).passthrough()).default([]) }).passthrough();
function pinnedProjectRevision(raw: string): AcceptedProjectRevision {
  try { return parseAcceptedProjectRevision(raw); }
  catch { return LegacyPinnedProjectRevisionSchema.parse(jsonRequired(raw)) as AcceptedProjectRevision; }
}
function normalizeReviewResult(raw: unknown, rawInput: unknown): DeliveryReviewActivityResult {
  const input = DeliveryReviewActivityInputSchema.parse(rawInput);
  const result = DeliveryReviewActivityResultSchema.safeParse(raw);
  if (result.success) return result.data;
  const legacy = z.object({ reviewId: z.string(), leadExecutionId: z.string(), leadSessionRef: z.string(), opinionArtifactId: z.string(), evidenceArtifactId: z.string(), outcome: z.enum(["approved", "blocking"]), summary: z.string(), repairPlan: z.string().nullable().optional(), findings: z.array(z.unknown()).optional() }).safeParse(raw);
  if (legacy.success) return DeliveryReviewActivityResultSchema.parse({
    outcome: "completed",
    attemptId: `delivery_review_${legacy.data.reviewId}`.slice(0, 256),
    correctionAttempts: 0,
    subject: input.subject,
    review: { ...legacy.data, opinion: legacy.data.outcome, findings: legacy.data.findings ?? [], supersedesReviewId: input.supersedesReviewId },
  });
  throw result.error;
}
function normalizeRepairResult(raw: unknown, rawInput: unknown): DeveloperRepairActivityResult {
  DeveloperRepairActivityInputSchema.parse(rawInput);
  const result = DeveloperRepairActivityResultSchema.safeParse(raw);
  if (result.success) return result.data;
  throw result.error;
}
async function durableArtifactReference(database: ForgeDatabase, store: ArtifactStore, companyId: string, artifactId: string, kind?: DurableArtifactReference["kind"]): Promise<DurableArtifactReference> {
  const row = database.authQuery((db) => db.prepare("SELECT id AS artifactId, company_id AS companyId, kind, sha256, byte_size AS byteSize, mime_type AS mimeType, storage_path AS storagePath FROM forge_artifacts WHERE id = ? AND company_id = ?").get(artifactId, companyId) as ({ artifactId: string; companyId: string; kind: string; sha256: string; byteSize: number; mimeType: string; storagePath: string } | undefined));
  if (!row || (kind && row.kind !== kind)) throw new Error("Scoped artifact reference is unavailable");
  const reference = DurableArtifactReferenceSchema.parse({ artifactId: row.artifactId, companyId: row.companyId, kind: row.kind, byteSize: row.byteSize, mimeType: row.mimeType });
  const bytes = await store.getArtifact({ companyId: row.companyId, storagePath: row.storagePath, sha256: row.sha256 });
  if (bytes.byteLength !== reference.byteSize) throw new Error("Scoped artifact size verification failed");
  return reference;
}
async function verifiedArtifactBytes(database: ForgeDatabase, store: ArtifactStore, companyId: string, expected: DurableArtifactReference, kind: DurableArtifactReference["kind"]): Promise<Buffer> {
  const actual = await durableArtifactReference(database, store, companyId, expected.artifactId, kind);
  for (const field of ["artifactId", "companyId", "kind", "byteSize", "mimeType"] as const) {
    if (actual[field] !== expected[field]) throw new Error("Scoped artifact metadata verification failed");
  }
  const row = database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = ?").get(actual.artifactId, companyId, kind) as { storagePath: string } | undefined);
  if (!row) throw new Error("Scoped artifact storage is unavailable");
  const stored = database.authQuery((db) => db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(actual.artifactId, companyId) as { sha256: string } | undefined);
  if (!stored) throw new Error("Scoped artifact storage is unavailable");
  return store.getArtifact({ companyId, storagePath: row.storagePath, sha256: stored.sha256 });
}
function artifactReference(artifact: Pick<StoredArtifact, "id" | "kind">) {
  return ArtifactReferenceSchema.parse({ id: artifact.id, kind: artifact.kind });
}
function reconcileBlocker(error: unknown): { code: TargetBaseBlockerCode; owner: "human" | "provider" | "lead"; retryable: boolean; summary: string } {
  const code = error instanceof ForwardMergeFailure ? error.code : "provider-unavailable";
  const mapped: Record<string, { code: TargetBaseBlockerCode; owner: "human" | "provider" | "lead"; retryable: boolean; summary: string }> = {
    "authentication-required": { code: "authentication_required", owner: "provider", retryable: false, summary: "Provider authentication is required before the target base can be reconciled" },
    "provider-unavailable": { code: "provider_unavailable", owner: "provider", retryable: true, summary: "The target-base provider could not be observed; retry reconciliation" },
    "remote-identity-mismatch": { code: "remote_identity_mismatch", owner: "human", retryable: false, summary: "The local repository remote does not match the accepted project identity" },
    "base-advanced-again": { code: "base_advanced_again", owner: "provider", retryable: true, summary: "The target base advanced during reconciliation; retry the same checkpoint" },
    "not-ancestor": { code: "base_rewritten", owner: "human", retryable: false, summary: "The observed target base is not a descendant of the accepted base" },
    "worktree-ownership-mismatch": { code: "worktree_ownership_mismatch", owner: "human", retryable: false, summary: "The recorded Developer worktree no longer matches the accepted delivery" },
    "worktree-dirty": { code: "worktree_dirty", owner: "human", retryable: false, summary: "The owned issue worktree is not clean" },
    "merge-state-ownership-mismatch": { code: "merge_state_ownership_mismatch", owner: "human", retryable: false, summary: "The local merge state does not match the recorded reconciliation" },
    "unsafe-command": { code: "merge_failed", owner: "human", retryable: false, summary: "The requested reconciliation command was rejected as unsafe" },
    git: { code: "merge_failed", owner: "lead", retryable: true, summary: "The target-base forward merge could not be completed" },
  };
  return mapped[code] ?? { code: "provider_unavailable", owner: "provider", retryable: true, summary: "Target-base reconciliation could not be completed" };
}

/**
 * Projection-only feedback for a queued agent turn. Writes the queue hint into
 * forge_issue_projections and returns a restore function that puts the previous
 * pending action back. The restore is guarded on the hint text so a newer
 * projection write (the normal pipeline) is never clobbered. Both directions
 * are best effort: a stale or missing projection must never fail the activity.
 */
export function applyQueueHintProjection(database: ForgeDatabase, taskId: string, waiting: { provider: string; position: number; activeCount: number }): () => void {
  const hint = `Waiting for a ${waiting.provider} agent slot (${waiting.activeCount} active, position ${waiting.position})`;
  let previous: string | null = null;
  try {
    const now = new Date().toISOString();
    const row = database.authQuery((db) => db.prepare("SELECT pending_action FROM forge_issue_projections WHERE task_id = ?").get(taskId));
    if (row && typeof row === "object" && "pending_action" in row && (row.pending_action === null || typeof row.pending_action === "string")) previous = row.pending_action;
    database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET pending_action = ?, updated_at = ? WHERE task_id = ?").run(hint, now, taskId));
  } catch { /* queued hint is best-effort */ }
  return () => {
    try {
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET pending_action = ?, updated_at = ? WHERE task_id = ? AND pending_action = ?").run(previous, new Date().toISOString(), taskId, hint));
    } catch { /* queued hint is best-effort */ }
  };
}

export function createActivityContext(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}) {
  const logger = new StructuredLogger(options.logSink);
  const defaultAgent = new AgentService(database, config);
  const githubRelease = options.githubRelease ?? createGithubReleasePort();
  const defaultDeveloper = new DeveloperService(database, config, { github: githubRelease });
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  const release = new ReleaseService(database, artifacts, githubRelease);
  const ci = new CiService(database, options.ciProvider ?? createGithubCiProvider(), artifacts);
  const acceptance = new AcceptanceService(database, githubRelease, { artifacts });
  const legacyForwardMerge = new ForwardMergeService(database, undefined, artifacts);
  const capacity = options.capacity ?? new CapacityManager(database, config);
  const activityWorktrees = new Map<string, string>();
  const activityWorktreesByBranch = new Map<string, string>();
  const worktrees = new WorktreeManager(undefined, () => readEnvironmentSettings(database).minFreeDiskGb);
  capacity.reconcileFromLedgers();
  const agent = options.agent;
  const developer = options.developer ?? defaultDeveloper;
  const attentionFailure = async (_input: { companyId: string }, category: AttentionCategory, code: string, summary: string, evidenceArtifactId?: string): Promise<never> => {
    const safeSummary = normalizeSafeSummary(redact(summary));
    throw ApplicationFailure.nonRetryable(safeSummary, code, { code, category, summary: safeSummary, ...(evidenceArtifactId ? { evidenceArtifactId } : {}) });
  };
  const agentCategory = (error: AgentFailure): AttentionCategory => error.code === "login-expired" ? "provider_authentication" : error.code === "model-unavailable" ? "provider_ambiguity" : error.code === "rate-limited" ? "provider_connectivity_exhausted" : error.code === "malformed-output" || error.code === "invalid-output" ? "agent_contradiction" : "agent_exhausted";
  type CapacityInput = {
    companyId: string;
    taskId?: string;
    projectId?: string;
    roleProfiles?: Partial<Record<ProjectRole, string | undefined>>;
  };
  const profileForRole = (input: CapacityInput, role: ProjectRole): CapacityProfileIdentity | "codex" => database.authQuery((db) => {
    const task = input.taskId
      ? db.prepare("SELECT project_id AS projectId, role_agents_json AS roleAgentsJson FROM forge_tasks WHERE id = ? AND company_id = ?").get(input.taskId, input.companyId) as { projectId: string; roleAgentsJson: string } | undefined
      : undefined;
    const projectId = task?.projectId ?? input.projectId;
    const project = projectId
      ? db.prepare("SELECT role_defaults_json AS roleDefaultsJson FROM forge_projects WHERE id = ? AND company_id = ?").get(projectId, input.companyId) as { roleDefaultsJson: string } | undefined
      : undefined;
    const taskAgents = task ? jsonRequired(task.roleAgentsJson) as Partial<Record<ProjectRole, string>> : {};
    const projectAgents = project ? jsonRequired(project.roleDefaultsJson) as Partial<Record<ProjectRole, string>> : {};
    const agentId = taskAgents[role] ?? projectAgents[role];
    const agent = agentId
      ? db.prepare("SELECT name, profile_id AS profileId FROM forge_agents WHERE id = ? AND role = ?").get(agentId, role) as { name: string; profileId: string } | undefined
      : undefined;
    const profileId = input.roleProfiles?.[role] ?? agent?.profileId;
    if (!profileId) return "codex";
    const profile = profileId
      ? db.prepare("SELECT id, name, provider FROM forge_profiles WHERE id = ?").get(profileId) as Omit<CapacityProfileIdentity, "agentName"> | undefined
      : undefined;
    if (!profile) throw new CapacityFailure("profile-unavailable");
    return { ...profile, ...(agent?.profileId === profile.id ? { agentName: agent.name } : {}) };
  });
  const invokeAgent = async <T>(input: CapacityInput, operation: () => Promise<T>, role: ProjectRole = "planner"): Promise<T> => {
    let heartbeat: ((details?: unknown) => void) | undefined;
    let interval: NodeJS.Timeout | undefined;
    let queueHint: NodeJS.Timeout | undefined;
    let restoreQueueHint: (() => void) | undefined;
    try {
      const activityContext = Context.current();
      heartbeat = (details?: unknown) => {
        activityContext.heartbeat(details);
        if (!queueHint && details && typeof details === "object" && "queued" in details && details.queued === true && input.taskId) {
          const taskId = input.taskId;
          queueHint = setTimeout(() => {
            // This is projection-only feedback. A stale/missing projection must
            // never turn a queued activity into a failed one.
            try {
              if ("provider" in details && typeof details.provider === "string"
                && "position" in details && typeof details.position === "number"
                && "activeCount" in details && typeof details.activeCount === "number") {
                restoreQueueHint = applyQueueHintProjection(database, taskId, { provider: details.provider, position: details.position, activeCount: details.activeCount });
              }
            } catch { /* queued hint is best-effort */ }
          }, 10_000);
          queueHint.unref();
        }
      };
      interval = setInterval(heartbeat, 5_000);
      interval.unref();
    } catch { /* direct unit calls do not have an Activity context */ }
    try {
      const profile = profileForRole(input, role);
      return await capacity.run(async () => {
        // The slot is acquired: stop the wait and put the previous pending
        // action back so the queue hint cannot outlive the wait.
        if (queueHint) { clearTimeout(queueHint); queueHint = undefined; }
        restoreQueueHint?.();
        return await operation();
      }, profile, heartbeat, cancellationSignal());
    } catch (error) {
      try {
        if (Context.current().cancellationSignal.aborted) throw new CancelledFailure("CANCELLED");
      } catch (cancellationError) {
        if (cancellationError instanceof CancelledFailure) throw cancellationError;
      }
      // Worktree failures are deterministic until a person changes the local state.
      // Surface them as a Retry blocker instead of allowing Engine to retry them.
      if (error instanceof WorktreeFailure) {
        const taskId = "taskId" in input && typeof input.taskId === "string" ? input.taskId : undefined;
        const evidence = taskId ? await artifacts.putArtifact(input.companyId, "attention-evidence", { taskId, filename: `${taskId}-${error.code}.txt`, mimeType: "text/plain", bytes: Buffer.from(error.message, "utf8") }).catch(() => undefined) : undefined;
        await attentionFailure(input, error.code === "host_capacity" ? "capacity_exhausted" : "unsafe_recovery", error.code, error.message, evidence?.id);
      }
      const permanentFailure = asNonRetryableApplicationFailure(error) ?? asNonRetryableCapacityFailure(error);
      if (permanentFailure) {
        if (error instanceof AgentFailure) await attentionFailure(input, agentCategory(error), error.code, error.message);
        throw permanentFailure;
      }
      const retryableFailure = asRetryableAgentFailure(error);
      if (retryableFailure) throw retryableFailure;
      throw error;
    } finally {
      clearInterval(interval);
      clearTimeout(queueHint);
      restoreQueueHint?.();
    }
  };
  const bindCapacityExecution = async <T>(_capacityRequestId: string | undefined, _owner: { executionKind: "agent" | "developer"; executionId: string; sessionRef?: string | null; worktreePath?: string | null }, result: T): Promise<T> => result;
  const runSupervised = async <T extends { developerExecutionId: string; evidenceArtifactId: string | null; deliveryArtifactId?: string; verificationArtifact?: { id: string } }>(
    input: { taskId: string; companyId: string; workflowId: string; planRevision: number; capacityRequestId?: string; developerTurnExecutionId: string },
    _promptKind: "implementation" | "delivery-repair" | "merge-conflict-resolution" | "ci-repair",
    operation: (service: Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">, execution: OperationExecution) => Promise<T>,
  ): Promise<DeveloperTurnActivityOutcome<T>> => {
    const signal = cancellationSignal();
    const result = await operation(developer as DeveloperService, signal ? { signal } : {});
    await bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId }, result);
    return { status: "completed", result, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
  };
  const latestWorktree = (input: { taskId: string; companyId: string; workflowId: string; branchName?: string }, executionId?: string): string => {
    const inMemory = executionId ? activityWorktrees.get(executionId) : input.branchName ? activityWorktreesByBranch.get(`${input.workflowId}:${input.branchName}`) : undefined;
    if (inMemory) return inMemory;
    const row = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND (? IS NULL OR branch_name = ?) ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.branchName ?? null, input.branchName ?? null) as { worktreePath: string } | undefined);
    if (!row?.worktreePath) throw new Error("Developer worktree context is unavailable");
    return row.worktreePath;
  };
  const cancellationSignal = (): AbortSignal | undefined => {
    try { return Context.current().cancellationSignal; } catch { return undefined; }
  };
  const agentRuntime = (): { signal?: AbortSignal } => {
    const signal = cancellationSignal();
    return signal ? { signal } : {};
  };
  return {
    database,
    config,
    options,
    createHash,
    randomBytes,
    ApplicationFailure,
    CancelledFailure,
    Context,
    z,
    projectionStateHash,
    ArtifactStore,
    redact,
    AgentFailure,
    AgentService,
    DeveloperService,
    cancelDeveloperExecution,
    reconcileDeveloperExecutions,
    cancelAgentExecution,
    reconcileAgentExecutions,
    AcceptanceFailure,
    AcceptanceService,
    CiFailure,
    CiProviderFailure,
    CiService,
    createGithubCiProvider,
    createGithubReleasePort,
    GithubReleaseFailure,
    ReleaseService,
    ForwardMergeFailure,
    ForwardMergeService,
    parseAcceptedProjectRevision,
    runPinnedVerification,
    createGitCommandGuard,
    ArtifactReferenceSchema,
    CreateSuccessorActivityInputSchema,
    DeliveryDecisionActivityInputSchema,
    CompletedDeliveryReviewLookupInputSchema,
    DeliveryReviewActivityInputSchema,
    DeliveryReviewActivityResultSchema,
    ReviewArbitrationActivityResultSchema,
    DeliveryReviewSchema,
    DeliveryOperationBlockCodeSchema,
    DeveloperRepairActivityInputSchema,
    DeveloperRepairActivityResultSchema,
    DurableArtifactReferenceSchema,
    IssueProjectionEventSchema,
    IssueWorkflowStateSchema,
    PreparePlanRevisionActivityInputSchema,
    PublishReleaseActivityResultSchema,
    ReconcileTargetBaseActivityInputSchema,
    RevisedExecutionCoordinatesSchema,
    SafeSummarySchema,
    createInitialIssueWorkflowState,
    normalizeSafeSummary,
    PlanGovernanceConflict,
    PlanGovernanceRepository,
    StructuredLogger,
    activityLogContext,
    CapacityFailure,
    CapacityManager,
    CapacityAdmissionResultSchema,
    CapacityRequestInputSchema,
    CapacityRequestSnapshotSchema,
    WorktreeFailure,
    WorktreeManager,
    startIssueWorkflow,
    logger,
    defaultAgent,
    githubRelease,
    defaultDeveloper,
    artifacts,
    release,
    ci,
    acceptance,
    legacyForwardMerge,
    capacity,
    activityWorktrees,
    activityWorktreesByBranch,
    worktrees,
    agent,
    developer,
    attentionFailure,
    agentCategory,
    invokeAgent,
    profileForRole,
    bindCapacityExecution,
    runSupervised,
    latestWorktree,
    cancellationSignal,
    agentRuntime,
    pinnedProjectRevision,
    normalizeReviewResult,
    normalizeRepairResult,
    durableArtifactReference,
    verifiedArtifactBytes,
    artifactReference,
    registerArtifact: undefined,
    reconcileBlocker,
    asNonRetryableCapacityFailure,
    asNonRetryableApplicationFailure,
    asRetryableAgentFailure,
    DeveloperDeliverySchema,
  };
}
export type ActivityContext = ReturnType<typeof createActivityContext>;
