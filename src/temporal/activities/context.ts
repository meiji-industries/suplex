import { createHash, randomBytes } from "node:crypto";

import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { z } from "zod";

import { ProjectionIntegrityFailure, projectionStateHash, type ForgeDatabase } from "../../database.js";
import type { ForgeConfig } from "../../config.js";
import { ArtifactStore, type StoredArtifact } from "../../artifacts.js";
import { redact } from "../../logging.js";
import { AgentFailure, AgentService, type LeadProcessRunner } from "../../codex-lead.js";
import { DeveloperService } from "../../codex-developer.js";
import { cancelDeveloperExecution, reconcileDeveloperExecutions } from "../../developer-recovery.js";
import { cancelAgentExecution, reconcileAgentExecutions } from "../../agent-recovery.js";
import { DeveloperExecutionLeaseRepository } from "../../developer-execution-leases.js";
import { runDeveloperTurn, type DeveloperTurnRunResult } from "../../developer-turn-runner.js";
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
  type DeveloperSupervisorActivityIdentity,
  type DeveloperTurnActivityOutcome,
  type DeveloperRepairActivityResult,
  type DurableArtifactReference,
  type MergeConflictResolutionActivityResult,
  type SupervisedDeveloperRepairActivityInput,
  type TargetBaseBlockerCode,
  type WorkflowDeveloperExecutionResult,
  type WorkflowDeveloperRepairResult,
} from "../issue-contracts.js";
import { PlanGovernanceConflict, PlanGovernanceRepository } from "../../plan-governance-repository.js";
import { StructuredLogger, activityLogContext } from "../../logging.js";
import { CapacityFailure, CapacityManager } from "../../capacity.js";
import { CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema } from "../../capacity-contracts.js";
import { WorktreeFailure, WorktreeManager } from "../../worktrees.js";
import { startIssueWorkflow } from "../service.js";

export interface ActivityOptions {
  agent?: Omit<Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "planDeliveryRepair" | "planMergeConflict" | "planCiRepair">>, "reviewDelivery"> & { reviewDelivery?: (input: DeliveryReviewServiceInput) => Promise<unknown> };
  developer?: Omit<Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">>, "runRepair"> & { runRepair?: (input: Parameters<DeveloperService["runRepair"]>[0]) => Promise<unknown> };
  githubRelease?: GithubReleaseAdapter;
  ciProvider?: CiProvider;
  logSink?: (line: string) => void;
}

class SupervisedDeveloperTerminalError extends Error {
  constructor(readonly result: DeveloperTurnRunResult) {
    super(`Developer turn ended as ${result.terminal}`);
    this.name = "SupervisedDeveloperTerminalError";
  }
}

export function asNonRetryableApplicationFailure(error: unknown): ApplicationFailure | undefined {
  if (error instanceof ProjectionIntegrityFailure) {
    return ApplicationFailure.nonRetryable(error.message, error.code, { code: error.code, summary: error.message, taskId: error.taskId, revision: error.revision });
  }
  if (error instanceof PlanGovernanceConflict) {
    return ApplicationFailure.nonRetryable(error.message, error.code);
  }
  if (error instanceof Error && error.name === "SqliteError" && /UNIQUE constraint failed/.test(error.message)) {
    return ApplicationFailure.nonRetryable(error.message, "sqlite-unique-constraint");
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
  if (error.code === "invalid-status" || error.code === "stale-owner") {
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
  catch { return LegacyPinnedProjectRevisionSchema.parse(JSON.parse(raw)) as AcceptedProjectRevision; }
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
  const reference = DurableArtifactReferenceSchema.parse({ artifactId: row.artifactId, companyId: row.companyId, kind: row.kind, sha256: row.sha256, byteSize: row.byteSize, mimeType: row.mimeType });
  const bytes = await store.read({ companyId: row.companyId, storagePath: row.storagePath, sha256: row.sha256 });
  if (bytes.byteLength !== reference.byteSize) throw new Error("Scoped artifact size verification failed");
  return reference;
}

async function verifiedArtifactBytes(database: ForgeDatabase, store: ArtifactStore, companyId: string, expected: DurableArtifactReference, kind: DurableArtifactReference["kind"]): Promise<Buffer> {
  const actual = await durableArtifactReference(database, store, companyId, expected.artifactId, kind);
  for (const field of ["artifactId", "companyId", "kind", "sha256", "byteSize", "mimeType"] as const) {
    if (actual[field] !== expected[field]) throw new Error("Scoped artifact metadata verification failed");
  }
  const row = database.authQuery((db) => db.prepare("SELECT storage_path AS storagePath FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = ?").get(actual.artifactId, companyId, kind) as { storagePath: string } | undefined);
  if (!row) throw new Error("Scoped artifact storage is unavailable");
  return store.read({ companyId, storagePath: row.storagePath, sha256: actual.sha256 });
}

function artifactReference(artifact: Pick<StoredArtifact, "id" | "sha256" | "kind">) {
  return ArtifactReferenceSchema.parse({ id: artifact.id, sha256: artifact.sha256, kind: artifact.kind });
}

function registerArtifact(database: ForgeDatabase, artifact: StoredArtifact): void {
  database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
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
  const artifacts = new ArtifactStore(config.artifactRoot);
  const release = new ReleaseService(database, artifacts, githubRelease);
  const ci = new CiService(database, options.ciProvider ?? createGithubCiProvider(), artifacts);
  const acceptance = new AcceptanceService(database, githubRelease, { artifacts });
  const legacyForwardMerge = new ForwardMergeService(database, undefined, artifacts);
  const capacity = new CapacityManager(database, config);
  const activityWorktrees = new Map<string, string>();
  const activityWorktreesByBranch = new Map<string, string>();
  const worktrees = new WorktreeManager();
  capacity.reconcileFromLedgers();
  const agent = options.agent;
  const developer = options.developer ?? defaultDeveloper;
  const putAttentionEvidence = async (input: { companyId: string }, category: AttentionCategory, code: string, summary: string): Promise<{ artifactId: string; sha256: string }> => {
    const safeSummary = normalizeSafeSummary(redact(summary));
    const artifact = await artifacts.put(input.companyId, "attention-evidence", { filename: `attention-${randomBytes(8).toString("hex")}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ code, category, summary: safeSummary }), "utf8") });
    registerArtifact(database, artifact);
    return { artifactId: artifact.id, sha256: artifact.sha256 };
  };
  const attentionFailure = async (input: { companyId: string }, category: AttentionCategory, code: string, summary: string): Promise<never> => {
    const evidence = await putAttentionEvidence(input, category, code, summary);
    const safeSummary = normalizeSafeSummary(redact(summary));
    throw ApplicationFailure.nonRetryable(safeSummary, code, { code, category, summary: safeSummary, evidenceArtifactId: evidence.artifactId, evidenceSha256: evidence.sha256 });
  };
  const artifactSha256 = (companyId: string, artifactId: string | null | undefined): string | undefined => artifactId ? database.authQuery((db) => db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(artifactId, companyId) as { sha256: string } | undefined)?.sha256 : undefined;
  const agentCategory = (error: AgentFailure): AttentionCategory => error.code === "login-expired" ? "provider_authentication" : error.code === "model-unavailable" ? "provider_ambiguity" : error.code === "rate-limited" ? "provider_connectivity_exhausted" : error.code === "malformed-output" || error.code === "invalid-output" ? "agent_contradiction" : "agent_exhausted";
  const invokeAgent = async <T>(input: { companyId: string }, operation: () => Promise<T>): Promise<T> => {
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const activityContext = Context.current();
      heartbeat = setInterval(() => activityContext.heartbeat(), 5_000);
      heartbeat.unref();
    } catch { /* direct unit calls do not have an Activity context */ }
    try {
      return await operation();
    } catch (error) {
      try {
        if (Context.current().cancellationSignal.aborted) throw new CancelledFailure("CANCELLED");
      } catch (cancellationError) {
        if (cancellationError instanceof CancelledFailure) throw cancellationError;
      }
      // A full disk is a host problem, not an agent problem: block visibly with Retry
      // instead of failing later as an unexplained ownership or supervisor error.
      if (error instanceof WorktreeFailure && error.code === "host_capacity") await attentionFailure(input, "capacity_exhausted", error.code, error.message);
      const permanentFailure = asNonRetryableApplicationFailure(error);
      if (permanentFailure) {
        if (error instanceof AgentFailure) await attentionFailure(input, agentCategory(error), error.code, error.message);
        throw permanentFailure;
      }
      const retryableFailure = asRetryableAgentFailure(error);
      if (retryableFailure) throw retryableFailure;
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  };
  const bindCapacityExecution = async <T>(capacityRequestId: string | undefined, owner: { executionKind: "agent" | "developer"; executionId: string; sessionRef?: string | null; worktreePath?: string | null }, result: T): Promise<T> => {
    if (capacityRequestId) capacity.bindExecution(capacityRequestId, owner);
    return result;
  };
  const recoverFinalizedDeveloperResult = async <T>(input: { taskId: string; companyId: string; workflowId: string; planRevision: number } & DeveloperSupervisorActivityIdentity): Promise<{ result: T; resultHash: string } | undefined> => {
    const lease = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot).get(input.developerTurnExecutionId);
    if (!lease?.resultHash) return undefined;
    const row = database.authQuery((db) => db.prepare(`SELECT d.status, d.session_ref AS sessionRef, d.branch_name AS branchName, d.worktree_path AS worktreePath, d.target_base_sha AS targetBaseSha, d.current_step AS currentStep, d.result_commit AS resultCommit, d.result_tree AS resultTree, d.dirty_state AS dirtyState, d.delivery_artifact_id AS deliveryArtifactId, d.evidence_artifact_id AS evidenceArtifactId, a.storage_path AS deliveryStoragePath, a.sha256 AS deliverySha, e.sha256 AS evidenceSha
      FROM forge_developer_executions d
      JOIN forge_artifacts a ON a.id = d.delivery_artifact_id AND a.company_id = d.company_id
      JOIN forge_artifacts e ON e.id = d.evidence_artifact_id AND e.company_id = d.company_id
      WHERE d.id = ? AND d.task_id = ? AND d.company_id = ? AND d.workflow_id = ? AND d.plan_revision = ? AND d.attempt = ? AND d.status IN ('completed', 'blocked')`).get(input.developerTurnExecutionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.developerAttempt) as { status: "completed" | "blocked"; sessionRef: string | null; branchName: string; worktreePath: string; targetBaseSha: string; currentStep: number | null; resultCommit: string | null; resultTree: string | null; dirtyState: "clean" | "dirty" | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null; deliveryStoragePath: string; deliverySha: string; evidenceSha: string } | undefined);
    if (!row?.sessionRef || !row.resultCommit || !row.resultTree || !row.dirtyState || !row.deliveryArtifactId || !row.evidenceArtifactId) return undefined;
    const artifactPayload = z.object({ summary: SafeSummarySchema }).passthrough().parse(JSON.parse((await artifacts.read({ companyId: input.companyId, storagePath: row.deliveryStoragePath, sha256: row.deliverySha })).toString("utf8")));
    let result: unknown;
    if (input.turnKind === "implementation") {
      result = { developerExecutionId: input.developerTurnExecutionId, developerSessionRef: row.sessionRef, branchName: row.branchName, targetBaseSha: row.targetBaseSha, currentStep: row.currentStep, resultCommit: row.resultCommit, resultTree: row.resultTree, dirtyState: row.dirtyState, deliveryArtifactId: row.deliveryArtifactId, evidenceArtifactId: row.evidenceArtifactId, deliverySummary: artifactPayload.summary, outcome: row.status } satisfies WorkflowDeveloperExecutionResult;
    } else if (input.turnKind === "repair") {
      const coordinates = input as typeof input & SupervisedDeveloperRepairActivityInput;
      const prior = database.authQuery((db) => db.prepare("SELECT delivery_artifact_id AS deliveryArtifactId, evidence_artifact_id AS evidenceArtifactId FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(coordinates.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { deliveryArtifactId: string | null; evidenceArtifactId: string | null } | undefined);
      const repair = database.authQuery((db) => db.prepare("SELECT id, review_id AS reviewId, cycle, failure_code AS failureCode FROM forge_delivery_repairs WHERE developer_execution_id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerTurnExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; reviewId: string; cycle: number; failureCode: string | null } | undefined);
      if (!prior?.deliveryArtifactId || !prior.evidenceArtifactId || !repair) return undefined;
      const subject = { planRevision: coordinates.planRevision, targetBaseSha: coordinates.targetBaseSha, subjectCommit: coordinates.subjectCommit, subjectTree: coordinates.subjectTree, developerExecutionId: coordinates.developerExecutionId, deliveryArtifactId: prior.deliveryArtifactId, developerEvidenceArtifactId: prior.evidenceArtifactId, leadSessionRef: coordinates.leadSessionRef, developerSessionRef: coordinates.developerSessionRef };
      result = row.status === "completed"
        ? { outcome: "completed", repairAttemptId: repair.id, cycle: repair.cycle, reviewId: repair.reviewId, subject, developerExecutionId: input.developerTurnExecutionId, developerSessionRef: row.sessionRef, branchName: row.branchName, resultCommit: row.resultCommit, resultTree: row.resultTree, dirtyState: "clean", deliveryArtifactId: row.deliveryArtifactId, evidenceArtifactId: row.evidenceArtifactId, summary: artifactPayload.summary } satisfies WorkflowDeveloperRepairResult
        : { outcome: "blocked", repairAttemptId: repair.id, cycle: repair.cycle, reviewId: repair.reviewId, subject, code: DeliveryOperationBlockCodeSchema.catch("worktree-unsafe").parse(repair.failureCode), summary: artifactPayload.summary, evidenceArtifactId: row.evidenceArtifactId, developerExecutionId: input.developerTurnExecutionId, developerSessionRef: row.sessionRef, branchName: row.branchName, resultCommit: row.resultCommit, resultTree: row.resultTree, dirtyState: row.dirtyState } satisfies WorkflowDeveloperRepairResult;
    } else {
      const delivery = z.object({ verificationArtifactId: z.string().min(1) }).passthrough().parse(artifactPayload);
      const verification = database.authQuery((db) => db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'forward-merge-verification'").get(delivery.verificationArtifactId, input.companyId) as { sha256: string } | undefined);
      if (!verification) return undefined;
      result = { developerExecutionId: input.developerTurnExecutionId, developerSessionRef: row.sessionRef, resultCommit: row.resultCommit, resultTree: row.resultTree, deliveryArtifactId: row.deliveryArtifactId, deliveryArtifactSha256: row.deliverySha, evidenceArtifactId: row.evidenceArtifactId, evidenceArtifactSha256: row.evidenceSha, verificationArtifactId: delivery.verificationArtifactId, verificationArtifactSha256: verification.sha256, summary: artifactPayload.summary } satisfies MergeConflictResolutionActivityResult;
    }
    return { result: result as T, resultHash: lease.resultHash };
  };
  const runSupervised = async <T extends { developerExecutionId: string; evidenceArtifactId: string | null; deliveryArtifactId?: string; verificationArtifact?: { id: string } }>(
    input: { taskId: string; companyId: string; workflowId: string; planRevision: number; capacityRequestId?: string } & DeveloperSupervisorActivityIdentity,
    operation: (service: Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution">) => Promise<T>,
  ): Promise<DeveloperTurnActivityOutcome<T>> => {
    const leases = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot);
    const priorClaim = leases.readClaim(input.developerTurnExecutionId);
    if (priorClaim) {
      return { status: "completed", result: JSON.parse(priorClaim.activityResultJson) as T, resultHash: priorClaim.resultHash };
    }
    let terminal: DeveloperTurnRunResult | undefined;
    const processRunner: LeadProcessRunner = async (invocation) => {
      const env = Object.fromEntries(Object.entries(invocation.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      terminal = await runDeveloperTurn({
        database,
        config,
        executionId: input.developerTurnExecutionId,
        developerAttempt: input.developerAttempt,
        planRevision: input.planRevision,
        turnKind: input.turnKind,
        companyId: input.companyId,
        taskId: input.taskId,
        workflowId: input.workflowId,
        canonicalWorktreePath: invocation.cwd,
        worktreeIdentityHash: createHash("sha256").update(`${input.companyId}\0${input.workflowId}\0${invocation.cwd}`).digest("hex"),
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env,
        onStart: invocation.onStart,
        onLine: invocation.onLine,
      });
      for (const line of terminal.lines) await invocation.onLine(line);
      if (terminal.terminal !== "result") throw new SupervisedDeveloperTerminalError(terminal);
      return { exitCode: terminal.exitCode ?? -1, stderr: terminal.exitSignal ? `Developer process exited with ${terminal.exitSignal}` : "" };
    };
    try {
      const recovered = await recoverFinalizedDeveloperResult<T>(input);
      if (recovered) {
        const deliveryArtifactId = recovered.result.deliveryArtifactId ?? recovered.result.verificationArtifact?.id;
        if (!deliveryArtifactId || !recovered.result.evidenceArtifactId) throw new Error("A supervised Developer result requires durable result and evidence artifacts");
        const claim = leases.claim({ executionId: input.developerTurnExecutionId, resultHash: recovered.resultHash, activityResultJson: JSON.stringify(recovered.result), deliveryArtifactId, evidenceArtifactId: recovered.result.evidenceArtifactId });
        if (claim.conflict) {
          return { status: "ownership_ambiguous", developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-result-claim-conflict", summary: "Forge found conflicting results for the same Developer attempt.", lastHeartbeatAt: leases.get(input.developerTurnExecutionId)?.heartbeatAt ?? null };
        }
        return { status: "completed", result: JSON.parse(claim.claim.activityResultJson) as T, resultHash: claim.claim.resultHash };
      }
      const service = options.developer ? developer as DeveloperService : new DeveloperService(database, config, { github: githubRelease, processRunner });
      const result = await operation(service);
      await bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId }, result);
      if (!terminal) {
        // Explicitly injected Developer ports are test seams and do not launch
        // an external process. They retain their existing direct behavior.
        return { status: "completed", result, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
      }
      const deliveryArtifactId = result.deliveryArtifactId ?? result.verificationArtifact?.id;
      if (!deliveryArtifactId || !result.evidenceArtifactId) throw new Error("A supervised Developer result requires durable result and evidence artifacts");
      const claim = leases.claim({ executionId: input.developerTurnExecutionId, resultHash: terminal.resultHash, activityResultJson: JSON.stringify(result), deliveryArtifactId, evidenceArtifactId: result.evidenceArtifactId });
      if (claim.conflict) {
        return { status: "ownership_ambiguous", developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-result-claim-conflict", summary: "Forge found conflicting results for the same Developer attempt.", lastHeartbeatAt: terminal.lastHeartbeatAt };
      }
      return { status: "completed", result: JSON.parse(claim.claim.activityResultJson) as T, resultHash: claim.claim.resultHash };
    } catch (error) {
      if (error instanceof SupervisedDeveloperTerminalError) {
        const status = error.result.terminal === "interrupted" ? "interrupted" as const : "ownership_ambiguous" as const;
        if (status === "ownership_ambiguous" && input.capacityRequestId) capacity.markOwnershipAmbiguous(input.capacityRequestId, "Developer supervisor ownership could not be confirmed");
        return { status, developerExecutionId: input.developerTurnExecutionId, reasonCode: status === "interrupted" ? "developer-worker-lost" : "developer-ownership-ambiguous", summary: status === "interrupted" ? "The Developer process ended before Forge could claim a result." : "Forge cannot prove ownership of the previous Developer process.", lastHeartbeatAt: error.result.lastHeartbeatAt };
      }
      if (error instanceof AgentFailure) {
        const evidence = database.authQuery((db) => (db.prepare("SELECT evidence_artifact_id AS evidenceArtifactId FROM forge_developer_executions WHERE id = ?").get(input.developerTurnExecutionId) as { evidenceArtifactId: string | null } | undefined)?.evidenceArtifactId ?? null);
        return { status: "failed", developerExecutionId: input.developerTurnExecutionId, reasonCode: error.code, summary: SafeSummarySchema.parse(error.message), evidenceArtifactId: evidence };
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
    ProjectionIntegrityFailure,
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
    DeveloperExecutionLeaseRepository,
    runDeveloperTurn,
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
    putAttentionEvidence,
    attentionFailure,
    artifactSha256,
    agentCategory,
    invokeAgent,
    bindCapacityExecution,
    recoverFinalizedDeveloperResult,
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
    registerArtifact,
    reconcileBlocker,
    asNonRetryableCapacityFailure,
    asNonRetryableApplicationFailure,
    asRetryableAgentFailure,
    DeveloperDeliverySchema,
  };
}

export type ActivityContext = ReturnType<typeof createActivityContext>;
