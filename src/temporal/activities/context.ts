import { createHash, randomBytes } from "node:crypto";

import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { z } from "zod";

import { projectionStateHash, type ForgeDatabase } from "../../database.js";
import type { ForgeConfig } from "../../config.js";
import { ArtifactStore, type StoredArtifact } from "../../artifacts.js";
import { redact } from "../../logging.js";
import { AgentFailure, AgentService } from "../../codex-lead.js";
import { DeveloperService } from "../../codex-developer.js";
import { cancelDeveloperExecution, reconcileDeveloperExecutions } from "../../developer-recovery.js";
import { cancelAgentExecution, reconcileAgentExecutions } from "../../agent-recovery.js";
import { AcceptanceFailure, AcceptanceService } from "../../acceptance.js";
import { CiFailure, CiProviderFailure, CiService, createGithubCiProvider, type CiProvider } from "../../ci.js";
import { createGithubReleasePort, GithubReleaseFailure, ReleaseService, type GithubReleaseAdapter } from "../../github-release.js";
import { ForwardMergeFailure, ForwardMergeService } from "../../forward-merge.js";
import { parseAcceptedProjectRevision, type AcceptedProjectRevision } from "../../projects.js";
import { runPinnedVerification } from "../../verification.js";
import { createGitCommandGuard } from "../../worktrees.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema } from "../contracts.js";
import {
  ArtifactReferenceSchema,
  CreateSuccessorActivityInputSchema,
  DeliveryDecisionActivityInputSchema,
  DeliveryReviewActivityInputSchema,
  DeliveryReviewActivityResultSchema,
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
import { CapacityFailure, CapacityManager } from "../../capacity.js";
import { CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema } from "../../capacity-contracts.js";
import { WorktreeFailure, WorktreeManager } from "../../worktrees.js";
import { readEnvironmentSettings } from "../../environment-settings.js";
import { startIssueWorkflow } from "../service.js";
import { jsonRequired } from "../../task-utils.js";
import { claimOperation, operationKey, settleOperation } from "../../operation-claims.js";

export interface ActivityOptions {
  agent?: Omit<Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "planDeliveryRepair" | "planMergeConflict" | "planCiRepair">>, "reviewDelivery"> & { reviewDelivery?: (input: DeliveryReviewServiceInput) => Promise<unknown> };
  developer?: Omit<Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">>, "runRepair"> & { runRepair?: (input: Parameters<DeveloperService["runRepair"]>[0]) => Promise<unknown> };
  githubRelease?: GithubReleaseAdapter;
  ciProvider?: CiProvider;
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
  const capacity = new CapacityManager(database, config);
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
  const providerForLead = (input: { roleProfiles?: { planner?: string | undefined } | undefined }): string => {
    const profileId = input.roleProfiles?.planner;
    if (!profileId) return "codex";
    return (database.authQuery((db) => db.prepare("SELECT provider FROM forge_profiles WHERE id = ?").get(profileId) as { provider?: string } | undefined)?.provider) ?? "codex";
  };
  const invokeAgent = async <T>(input: { companyId: string; roleProfiles?: { planner?: string | undefined } | undefined }, operation: () => Promise<T>, provider?: string): Promise<T> => {
    let heartbeat: ((details?: unknown) => void) | undefined;
    let interval: NodeJS.Timeout | undefined;
    let queueHint: NodeJS.Timeout | undefined;
    try {
      const activityContext = Context.current();
      heartbeat = (details?: unknown) => {
        activityContext.heartbeat(details);
        if (!queueHint && details && typeof details === "object" && (details as { queued?: unknown }).queued === true && "taskId" in input) {
          queueHint = setTimeout(() => {
            // This is projection-only feedback. A stale/missing projection must
            // never turn a queued activity into a failed one.
            try {
              const waiting = details as { provider: string; position: number; activeCount: number };
              database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET pending_action = ?, updated_at = ? WHERE task_id = ?").run(`Waiting for a ${waiting.provider} agent slot (${waiting.activeCount} active, position ${waiting.position})`, new Date().toISOString(), (input as { taskId: string }).taskId));
            } catch { /* queued hint is best-effort */ }
          }, 10_000);
          queueHint.unref();
        }
      };
      interval = setInterval(heartbeat, 5_000);
      interval.unref();
    } catch { /* direct unit calls do not have an Activity context */ }
    try {
      return await capacity.run(operation, provider ?? providerForLead(input), heartbeat, cancellationSignal());
    } catch (error) {
      try {
        if (Context.current().cancellationSignal.aborted) throw new CancelledFailure("CANCELLED");
      } catch (cancellationError) {
        if (cancellationError instanceof CancelledFailure) throw cancellationError;
      }
      // Worktree failures are deterministic until a person changes the local state.
      // Surface them as a Retry blocker instead of allowing Temporal to retry them.
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
    }
  };
  const bindCapacityExecution = async <T>(_capacityRequestId: string | undefined, _owner: { executionKind: "agent" | "developer"; executionId: string; sessionRef?: string | null; worktreePath?: string | null }, result: T): Promise<T> => result;
  const runSupervised = async <T extends { developerExecutionId: string; evidenceArtifactId: string | null; deliveryArtifactId?: string; verificationArtifact?: { id: string } }>(
    input: { taskId: string; companyId: string; workflowId: string; planRevision: number; capacityRequestId?: string; developerTurnExecutionId: string },
    operation: (service: Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">) => Promise<T>,
  ): Promise<DeveloperTurnActivityOutcome<T>> => {
    const key = operationKey(["turn", input.taskId, input.developerTurnExecutionId]);
    const claim = claimOperation(database, { key, taskId: input.taskId, kind: "turn" });
    if (!claim.claimed && claim.status === "settled" && claim.result !== null) return claim.result as DeveloperTurnActivityOutcome<T>;
    if (!claim.claimed && claim.status === "failed" && (claim.result as { reasonCode?: unknown } | null)?.reasonCode === "cancelled") {
      return claim.result as DeveloperTurnActivityOutcome<T>;
    }
    try {
      const result = await operation(developer as DeveloperService);
      await bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId }, result);
      const outcome: DeveloperTurnActivityOutcome<T> = {
        status: "completed",
        result,
        resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      };
      settleOperation(database, key, "settled", outcome);
      return outcome;
    } catch (error) {
      if (error instanceof AgentFailure) {
        const evidence = database.authQuery((db) => (db.prepare("SELECT evidence_artifact_id AS evidenceArtifactId FROM forge_developer_executions WHERE id = ?").get(input.developerTurnExecutionId) as { evidenceArtifactId: string | null } | undefined)?.evidenceArtifactId ?? null);
        const outcome: DeveloperTurnActivityOutcome<T> = { status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: error.code, summary: SafeSummarySchema.parse(error.message), evidenceArtifactId: evidence };
        settleOperation(database, key, "failed", outcome);
        return outcome;
      }
      throw error;
    }
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
    ProbeWorkflowInputSchema,
    ProbeWorkflowStateSchema,
    ArtifactReferenceSchema,
    CreateSuccessorActivityInputSchema,
    DeliveryDecisionActivityInputSchema,
    DeliveryReviewActivityInputSchema,
    DeliveryReviewActivityResultSchema,
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
