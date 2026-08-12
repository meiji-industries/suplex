import { createHash, randomBytes } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";

import { ProjectionIntegrityFailure, projectionStateHash, type ForgeDatabase } from "../database.js";
import type { ForgeConfig } from "../config.js";
import { ArtifactStore, type StoredArtifact } from "../artifacts.js";
import { redact } from "../logging.js";
import { AgentFailure, AgentService } from "../codex-lead.js";
import { DeveloperService } from "../codex-developer.js";
import { cancelDeveloperExecution } from "../developer-recovery.js";
import { AcceptanceService } from "../acceptance.js";
import { CiService, createGithubCiProvider, type CiProvider } from "../ci.js";
import { createGithubReleasePort, GithubReleaseFailure, ReleaseService, type GithubReleaseAdapter } from "../github-release.js";
import { ForwardMergeFailure, ForwardMergeService } from "../forward-merge.js";
import { parseAcceptedProjectRevision, type AcceptedProjectRevision } from "../projects.js";
import { runPinnedVerification } from "../verification.js";
import { createGitCommandGuard } from "../worktrees.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import {
  ArtifactReferenceSchema,
  CreateSuccessorActivityInputSchema,
  DeliveryDecisionActivityInputSchema,
  DeliveryReviewActivityInputSchema,
  DeliveryReviewActivityResultSchema,
  DeliveryReviewSchema,
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
  type AcceptDeliveryActivityInput,
  type DeliveryBlockerActivities,
  type DeliveryBlockerActivityInput,
  type DeliveryBlockerActivityResult,
  type DeliveryReviewActivityResult,
  type DeliveryReviewServiceInput,
  type DeveloperRepairActivityResult,
  type DurableArtifactReference,
  type IssueActivities,
  type IssueProjectionEvent,
  type IssueWorkflowState,
  type MergeConflictPlanActivityInput,
  type MergeConflictResolutionActivityInput,
  type PublishReleaseActivityInput,
  type ReconcileAcceptanceActivityInput,
  type ReconcileCiActivityInput,
  type ReconcileMergeActivityInput,
  type ReconcileTargetBaseActivityInput,
  type ReconcileTargetBaseActivityResult,
  type RevisedExecutionCoordinates,
  type TargetBaseBlockerCode,
  type WorkflowCiRepairActivityInput,
  type WorkflowDeliveryReviewActivityInput,
  type WorkflowDeveloperRepairActivityInput,
  type WorkflowFinalReviewActivityInput,
  type WorkflowMergeConflictPlanActivityInput,
  type WorkflowMergeConflictResolutionActivityInput,
} from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";
import { CapacityManager } from "../capacity.js";
import { WorktreeFailure, WorktreeManager } from "../worktrees.js";
import { startIssueWorkflow } from "./service.js";

export interface ActivityOptions {
  agent?: Omit<Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "planDeliveryRepair" | "planMergeConflict" | "planCiRepair">>, "reviewDelivery"> & { reviewDelivery?: (input: DeliveryReviewServiceInput) => Promise<unknown> };
  developer?: Omit<Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">>, "runRepair"> & { runRepair?: (input: Parameters<DeveloperService["runRepair"]>[0]) => Promise<unknown> };
  githubRelease?: GithubReleaseAdapter;
  ciProvider?: CiProvider;
}

export class CapacityWaitError extends Error {
  constructor(readonly requestId: string, readonly position: number) {
    super(`Forge capacity is unavailable; retry request ${requestId} at queue position ${position}`);
    this.name = "CapacityWaitError";
  }
}

export function asNonRetryableApplicationFailure(error: unknown): ApplicationFailure | undefined {
  if (error instanceof AgentFailure && error.nonRetryable) return ApplicationFailure.nonRetryable(error.message, error.code, { code: error.code, summary: error.message });
  if (error instanceof ProjectionIntegrityFailure) return ApplicationFailure.nonRetryable(error.message, "projection_integrity_failure", { code: error.code, summary: error.message, taskId: error.taskId, revision: error.revision });
  return undefined;
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

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities & DeliveryBlockerActivities {
  const logger = new StructuredLogger();
  const defaultAgent = new AgentService(database, config);
  const githubRelease = options.githubRelease ?? createGithubReleasePort();
  const defaultDeveloper = new DeveloperService(database, config, { github: githubRelease });
  const artifacts = new ArtifactStore(config.artifactRoot);
  const release = new ReleaseService(database, artifacts, githubRelease);
  const ci = new CiService(database, options.ciProvider ?? createGithubCiProvider(), artifacts);
  const acceptance = new AcceptanceService(database, githubRelease, { artifacts });
  const legacyForwardMerge = new ForwardMergeService(database);
  const capacity = new CapacityManager(database, config);
  const activityWorktrees = new Map<string, string>();
  const activityWorktreesByBranch = new Map<string, string>();
  const worktrees = new WorktreeManager();
  capacity.reconcileFromLedgers();
  const agent = options.agent;
  const developer = options.developer ?? defaultDeveloper;
  const withCapacity = async <T>(input: { taskId: string; companyId: string; workflowId: string }, turnKind: "lead" | "developer" | "review", operation: () => Promise<T>): Promise<T> => {
    const request = capacity.request({ ...input, turnKind });
    const admitted = capacity.tryAcquire(request.id);
    if (!admitted.acquired) throw new CapacityWaitError(request.id, capacity.position(request.id) ?? 1);
    let releaseReason = "turn-completed";
    try {
      return await operation();
    } catch (error) {
      releaseReason = "turn-failed";
      const permanentFailure = asNonRetryableApplicationFailure(error);
      if (permanentFailure) throw permanentFailure;
      throw error;
    } finally {
      capacity.release(request.id, releaseReason);
    }
  };
  const latestWorktree = (input: { taskId: string; companyId: string; workflowId: string; branchName?: string }, executionId?: string): string => {
    const inMemory = executionId ? activityWorktrees.get(executionId) : input.branchName ? activityWorktreesByBranch.get(`${input.workflowId}:${input.branchName}`) : undefined;
    if (inMemory) return inMemory;
    const row = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND (? IS NULL OR branch_name = ?) ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.branchName ?? null, input.branchName ?? null) as { worktreePath: string } | undefined);
    if (!row?.worktreePath) throw new Error("Developer worktree context is unavailable");
    return row.worktreePath;
  };
  return {
    async recordProbeStarted(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
      const validatedInput = ProbeWorkflowInputSchema.parse(input);
      logger.child(activityLogContext()).info("Probe activity started", {
        companyId: validatedInput.companyId,
      });
      database.recordProbe({
        workflowId: validatedInput.workflowId,
        probeId: validatedInput.probeId,
        companyId: validatedInput.companyId,
        status: "running",
      });
      return ProbeWorkflowStateSchema.parse({
        ...validatedInput,
        status: "running",
      });
    },
    async projectIssueState(input: IssueProjectionEvent): Promise<IssueWorkflowState> {
      const event = IssueProjectionEventSchema.parse(input);
      try {
        database.observeIssueProjection(event);
        database.projectIssueEvent(event);
      } catch (error) {
        const permanentFailure = asNonRetryableApplicationFailure(error);
        if (permanentFailure) throw permanentFailure;
        throw error;
      }
      return IssueWorkflowStateSchema.parse(event.state);
    },
    async recordDeliveryBlocker(input: DeliveryBlockerActivityInput): Promise<DeliveryBlockerActivityResult> {
      const summary = input.operation === "review" ? "The delivery review infrastructure did not complete; retry the review." : "The delivery repair infrastructure did not complete; retry the repair.";
      const artifact = await artifacts.put(input.companyId, "delivery-blocker", { filename: `${input.workflowId}-${input.operation}-blocker.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ type: "forge.delivery-blocker", operation: input.operation, summary }), "utf8") });
      database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
      return { artifactId: artifact.id };
    },
    async findActiveDeveloperExecution(input) {
      return database.authQuery((db) => db.prepare("SELECT id AS executionId, session_ref AS sessionRef FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND status IN ('starting', 'running', 'cancelling') ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId) as { executionId: string; sessionRef: string } | undefined) ?? null;
    },
    async preparePlanRevision(rawInput) {
      const input = PreparePlanRevisionActivityInputSchema.parse(rawInput);
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      const scoped = actor?.status === "active" && database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT t.id, r.normalized_json AS normalizedJson FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ? AND t.project_revision_id = ?").get(input.taskId, input.companyId, input.workflowId, input.projectId, input.projectRevisionId)
        : db.prepare("SELECT t.id, r.normalized_json AS normalizedJson FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' JOIN forge_memberships m ON m.company_id = t.company_id AND m.user_id = ? AND m.status = 'active' WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ? AND t.project_revision_id = ?").get(input.actorUserId, input.taskId, input.companyId, input.workflowId, input.projectId, input.projectRevisionId)) as { id: string; normalizedJson: string } | undefined;
      if (!scoped) throw new AgentFailure("revision-scope-unavailable", "Plan revision is unavailable for this issue", { nonRetryable: true });
      const requestId = `revision_${createHash("sha256").update(`${input.workflowId}:${input.requestRevision}`).digest("hex").slice(0, 32)}`;
      const reason = (redact(input.reason.trim()) as string).trim();
      const reasonHash = createHash("sha256").update(reason).digest("hex");
      const reasonArtifactId = `artifact_plan_revision_${createHash("sha256").update(`${input.workflowId}:${input.requestRevision}`).digest("hex").slice(0, 48)}`;
      const existing = database.authQuery((db) => db.prepare("SELECT id, actor_user_id AS actorUserId, reason_artifact_id AS reasonArtifactId, disposition, status, blocker_code AS blockerCode, developer_execution_id AS developerExecutionId, worktree_path AS worktreePath, branch_name AS branchName, base_sha AS baseSha, head_sha AS headSha, tree_sha AS treeSha, dirty_state AS dirtyState, exact_base_sha AS exactBaseSha, authorized_plan_revision AS authorizedPlanRevision FROM forge_plan_revision_requests WHERE workflow_id = ? AND request_revision = ?").get(input.workflowId, input.requestRevision) as { id: string; actorUserId: string; reasonArtifactId: string; disposition: "reuse" | "new"; status: "accepted" | "blocked" | "authorized"; blockerCode: string | null; developerExecutionId: string | null; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; dirtyState: "clean" | "dirty" | null; exactBaseSha: string | null; authorizedPlanRevision: number | null } | undefined);
      if (existing && (existing.actorUserId !== input.actorUserId || existing.reasonArtifactId !== reasonArtifactId || existing.disposition !== input.worktreeDisposition || existing.exactBaseSha !== (input.exactBaseSha ?? null))) throw new AgentFailure("revision-identity-conflict", "The plan revision request identity conflicts with an existing request", { nonRetryable: true });
      const existingArtifact = database.authQuery((db) => db.prepare("SELECT id, company_id AS companyId, kind, sha256, storage_path AS storagePath FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { id: string; companyId: string; kind: string; sha256: string; storagePath: string } | undefined);
      if (existingArtifact && (existingArtifact.companyId !== input.companyId || existingArtifact.kind !== "plan-revision-reason" || existingArtifact.sha256 !== reasonHash)) throw new AgentFailure("revision-identity-conflict", "The plan revision artifact identity conflicts with an existing artifact", { nonRetryable: true });
      if (existing?.status === "blocked") return { status: "blocked", revisionRequestId: existing.id, blockerCode: existing.blockerCode ?? "revision-blocked" };
      if (existing?.status === "accepted" || existing?.status === "authorized") {
        const coordinates = existing.disposition === "reuse"
          ? RevisedExecutionCoordinatesSchema.safeParse({ disposition: "reuse", revisionRequestId: existing.id, developerExecutionId: existing.developerExecutionId, branchName: existing.branchName, baseSha: existing.baseSha, headSha: existing.headSha, treeSha: existing.treeSha, dirtyState: existing.dirtyState })
          : RevisedExecutionCoordinatesSchema.safeParse({ disposition: "new", revisionRequestId: existing.id, exactBaseSha: existing.exactBaseSha });
        if (coordinates.success) return { status: "accepted", revisionRequestId: existing.id, coordinates: coordinates.data };
      }
      const reasonArtifact = existingArtifact ? undefined : await artifacts.putWithId(input.companyId, reasonArtifactId, "plan-revision-reason", { filename: `plan-revision-${input.requestRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(reason, "utf8") });
      let status: "accepted" | "blocked" = "accepted";
      let blockerCode: string | null = null;
      let coordinates: RevisedExecutionCoordinates;
      if (input.worktreeDisposition === "reuse") {
        const execution = input.developerExecutionId ? database.authQuery((db) => db.prepare("SELECT id, status, worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS baseSha, result_commit AS headSha, result_tree AS treeSha FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; worktreePath: string; branchName: string; baseSha: string; headSha: string | null; treeSha: string | null } | undefined) : undefined;
        if (!execution || !["cancelled", "interrupted", "blocked", "completed"].includes(execution.status) || !execution.headSha || !execution.treeSha) { status = "blocked"; blockerCode = "missing-preserved-execution"; }
        else {
          try {
            const pinned = pinnedProjectRevision(scoped.normalizedJson);
            const inspected = await worktrees.inspectForPlanRevision({ repositoryPath: pinned.repositoryPath, worktreeRoot: pinned.worktreeRoot, worktreePath: execution.worktreePath, branchName: execution.branchName, baseSha: execution.baseSha, resultCommit: execution.headSha, resultTree: execution.treeSha });
            coordinates = { disposition: "reuse", revisionRequestId: requestId, developerExecutionId: execution.id, branchName: inspected.branchName, baseSha: inspected.baseSha, headSha: inspected.headSha, treeSha: inspected.treeSha, dirtyState: inspected.dirtyState };
          } catch (error) { status = "blocked"; blockerCode = error instanceof WorktreeFailure ? error.code : "worktree-inspection-failed"; }
        }
      } else {
        try { const pinned = pinnedProjectRevision(scoped.normalizedJson); await worktrees.validateExactBase({ repositoryPath: pinned.repositoryPath, candidateSha: input.exactBaseSha!, acceptedTargetSha: pinned.targetSha }); coordinates = { disposition: "new", revisionRequestId: requestId, exactBaseSha: input.exactBaseSha! }; }
        catch (error) { status = "blocked"; blockerCode = error instanceof WorktreeFailure ? error.code : "invalid-base-commit"; }
      }
      try {
        const now = new Date().toISOString();
        database.authTransaction((db) => {
          if (reasonArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
          db.prepare("INSERT INTO forge_plan_revision_requests (id, task_id, company_id, workflow_id, request_revision, actor_user_id, reason_artifact_id, disposition, status, blocker_code, developer_execution_id, worktree_path, branch_name, base_sha, head_sha, tree_sha, dirty_state, exact_base_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(requestId, input.taskId, input.companyId, input.workflowId, input.requestRevision, input.actorUserId, reasonArtifactId, input.worktreeDisposition, status, blockerCode, coordinates?.disposition === "reuse" ? coordinates.developerExecutionId : null, coordinates?.disposition === "reuse" ? database.authQuery((inner) => inner.prepare("SELECT worktree_path FROM forge_developer_executions WHERE id = ?").get(coordinates.developerExecutionId) as { worktree_path: string } | undefined)?.worktree_path ?? null : null, coordinates?.disposition === "reuse" ? coordinates.branchName : null, coordinates?.disposition === "reuse" ? coordinates.baseSha : null, coordinates?.disposition === "reuse" ? coordinates.headSha : null, coordinates?.disposition === "reuse" ? coordinates.treeSha : null, coordinates?.disposition === "reuse" ? "clean" : null, coordinates?.disposition === "new" ? coordinates.exactBaseSha : null, now, now);
        });
      } catch (error) {
        const persisted = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { companyId: string; storagePath: string; sha256: string } | undefined);
        if (reasonArtifact && (!persisted || persisted.companyId !== input.companyId || persisted.sha256 !== reasonArtifact.sha256)) await artifacts.remove(reasonArtifact);
        throw error;
      }
      if (status === "blocked") return { status, revisionRequestId: requestId, blockerCode: blockerCode ?? "revision-blocked" };
      return { status, revisionRequestId: requestId, coordinates: coordinates! };
    },
    async authorizePlanRevision(input) {
      database.authTransaction((db) => {
        const result = db.prepare("UPDATE forge_plan_revision_requests SET status = 'authorized', authorized_plan_revision = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'accepted'").run(input.planRevision, new Date().toISOString(), input.revisionRequestId, input.taskId, input.companyId, input.workflowId);
        if (result.changes !== 1) {
          const row = db.prepare("SELECT status, authorized_plan_revision FROM forge_plan_revision_requests WHERE id = ?").get(input.revisionRequestId) as { status: string; authorized_plan_revision: number | null } | undefined;
          if (!row || !["authorized", "accepted"].includes(row.status) || (row.status === "authorized" && row.authorized_plan_revision !== input.planRevision)) throw new Error("Plan revision authorization identity is unavailable");
        }
      });
    },
    async createSuccessor(rawInput) {
      const input = CreateSuccessorActivityInputSchema.parse(rawInput);
      const allowed = database.authQuery((db) => db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_users u ON u.id = ? AND u.status = 'active' LEFT JOIN forge_memberships m ON m.company_id = t.company_id AND m.user_id = u.id AND m.status = 'active' WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND (u.role = 'admin' OR m.user_id IS NOT NULL)").get(input.actorUserId, input.predecessorTaskId, input.companyId, input.predecessorWorkflowId) as { id: string } | undefined);
      if (!allowed) throw new AgentFailure("successor-scope-unavailable", "Continuation is unavailable for this issue", { nonRetryable: true });
      const existing = database.authQuery((db) => db.prepare("SELECT id, successor_task_id AS successorTaskId, successor_workflow_id AS successorWorkflowId, project_revision_id AS projectRevisionId, accepted_revision AS acceptedRevision, actor_user_id AS actorUserId, reason_artifact_id AS reasonArtifactId, state FROM forge_successor_intents WHERE predecessor_workflow_id = ?").get(input.predecessorWorkflowId) as { id: string; successorTaskId: string; successorWorkflowId: string; projectRevisionId: string; acceptedRevision: number; actorUserId: string; reasonArtifactId: string; state: string } | undefined);
      const reason = (redact(input.reason.trim()) as string).trim();
      const reasonHash = createHash("sha256").update(reason).digest("hex");
      const reasonArtifactId = `artifact_continuation_${input.intentId.replace(/^intent_/, "")}`;
      const storedReason = database.authQuery((db) => db.prepare("SELECT id, company_id AS companyId, kind, sha256, storage_path AS storagePath FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { id: string; companyId: string; kind: string; sha256: string; storagePath: string } | undefined);
      const sameRequest = existing?.actorUserId === input.actorUserId && existing.reasonArtifactId === reasonArtifactId && storedReason?.companyId === input.companyId && storedReason.kind === "continuation-reason" && storedReason.sha256 === reasonHash;
      if (existing?.state === "linked") {
        if (!sameRequest) throw new AgentFailure("successor-identity-conflict", "Continuation identity conflicts with an existing request", { nonRetryable: true });
        return { successorTaskId: existing.successorTaskId, successorWorkflowId: existing.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: existing.projectRevisionId, creationRevision: existing.acceptedRevision };
      }
      if (existing && (!sameRequest || existing.id !== input.intentId || existing.successorTaskId !== input.successorTaskId || existing.successorWorkflowId !== input.successorWorkflowId || existing.acceptedRevision !== input.acceptedRevision)) throw new AgentFailure("successor-identity-conflict", "Continuation identity conflicts with an existing request", { nonRetryable: true });
      const current = database.authQuery((db) => db.prepare("SELECT t.title, t.brief_artifact_id AS briefArtifactId, t.image_artifact_ids_json AS imageIdsJson, p.role_defaults_json AS roleDefaultsJson, p.allowed_profiles_json AS allowedProfilesJson, p.active_revision_id AS projectRevisionId, r.normalized_json AS normalizedJson, b.sha256 AS briefSha256 FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_project_revisions r ON r.id = p.active_revision_id AND r.state = 'accepted' JOIN forge_artifacts b ON b.id = t.brief_artifact_id WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ?").get(input.predecessorTaskId, input.companyId, input.projectId, input.predecessorWorkflowId) as { title: string; briefArtifactId: string; imageIdsJson: string; roleDefaultsJson: string; allowedProfilesJson: string; projectRevisionId: string; normalizedJson: string; briefSha256: string } | undefined);
      if (!current) throw new AgentFailure("successor-project-unavailable", "The currently accepted project revision is unavailable", { nonRetryable: true });
      if (storedReason && (storedReason.companyId !== input.companyId || storedReason.kind !== "continuation-reason" || storedReason.sha256 !== reasonHash)) throw new AgentFailure("successor-identity-conflict", "Continuation identity conflicts with an existing artifact", { nonRetryable: true });
      const reasonArtifact = storedReason ? undefined : await artifacts.putWithId(input.companyId, reasonArtifactId, "continuation-reason", { filename: `${input.intentId}.md`, mimeType: "text/markdown", bytes: Buffer.from(reason, "utf8") });
      const now = new Date().toISOString();
      const roles = JSON.parse(current.roleDefaultsJson) as Record<string, string>;
      const allowedProfiles = JSON.parse(current.allowedProfilesJson) as string[];
      const profileIds = Object.values(roles).filter((profileId): profileId is string => typeof profileId === "string" && profileId.length > 0);
      const availableProfiles = database.authQuery((db) => profileIds.length === 0 ? [] : db.prepare(`SELECT id FROM forge_profiles WHERE status = 'active' AND provider = 'codex' AND id IN (${profileIds.map(() => "?").join(",")})`).all(...profileIds) as Array<{ id: string }>);
      if (profileIds.some((profileId) => !allowedProfiles.includes(profileId) || !availableProfiles.some((profile) => profile.id === profileId))) throw new AgentFailure("successor-profile-unavailable", "The currently accepted project revision has unavailable role profiles", { nonRetryable: true });
      const imageIds = JSON.parse(current.imageIdsJson) as string[];
      const artifactIds = [current.briefArtifactId, ...imageIds, reasonArtifactId];
      const placeholders = artifactIds.map(() => "?").join(",");
      const artifactManifest = database.authQuery((db) => db.prepare(`SELECT id, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath FROM forge_artifacts WHERE company_id = ? AND id IN (${placeholders})`).all(input.companyId, ...artifactIds) as Array<{ id: string; kind: string; filename: string; mimeType: string; byteSize: number; sha256: string; storagePath: string }>);
      if (reasonArtifact) artifactManifest.push({ id: reasonArtifact.id, kind: reasonArtifact.kind, filename: reasonArtifact.filename, mimeType: reasonArtifact.mimeType, byteSize: reasonArtifact.byteSize, sha256: reasonArtifact.sha256, storagePath: reasonArtifact.storagePath });
      const requestHash = createHash("sha256").update(JSON.stringify({ predecessor: input.predecessorTaskId, successor: input.successorTaskId, reasonArtifactId, projectRevisionId: current.projectRevisionId })).digest("hex");
      try {
        database.authTransaction((db) => {
          if (existing) return;
          if (reasonArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
          db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, predecessor_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)").run(input.successorTaskId, input.companyId, input.projectId, `Continue: ${current.title}`.slice(0, 160), current.briefArtifactId, JSON.stringify(imageIds), JSON.stringify(roles), input.successorWorkflowId, current.projectRevisionId, `continue_${input.intentId}`, requestHash, input.predecessorTaskId, now, now);
          const initialState = IssueWorkflowStateSchema.parse({ ...createInitialIssueWorkflowState({ workflowId: input.successorWorkflowId, companyId: input.companyId, projectId: input.projectId, issueId: input.successorTaskId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: current.projectRevisionId, briefArtifactId: current.briefArtifactId, briefSha256: current.briefSha256, imageArtifactIds: imageIds, requestHash, roleProfiles: roles, supplementalReview: false, repairCycleLimit: config.deliveryRepairCycleLimit }), predecessorTaskId: input.predecessorTaskId });
          const hash = projectionStateHash(initialState);
          db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, projected_at) VALUES (?, ?, ?, ?, 0, 'backlog', 'human', ?, ?, ?, ?, ?, 0, ?)").run(input.successorTaskId, input.companyId, input.projectId, input.successorWorkflowId, JSON.stringify(initialState.allowedCommands), initialState.pendingAction, now, initialState.lastEventId, hash, now);
          db.prepare("INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, 0, 'task_created', ?, ?, ?)").run(`${input.successorWorkflowId}:0`, input.successorTaskId, input.companyId, input.successorWorkflowId, JSON.stringify({ revision: 0, stateHash: hash }), now, hash);
          db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(input.successorTaskId, input.companyId, input.successorWorkflowId, JSON.stringify(initialState), now);
          db.prepare("INSERT INTO forge_task_creation_intents (id, company_id, project_id, task_id, workflow_id, idempotency_key, request_hash, project_revision_id, artifact_ids_json, artifact_manifest_json, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workflow_starting', 1, ?, ?)").run(`creation_${input.intentId}`, input.companyId, input.projectId, input.successorTaskId, input.successorWorkflowId, `continue_${input.intentId}`, requestHash, current.projectRevisionId, JSON.stringify(artifactIds), JSON.stringify(artifactManifest), now, now);
          db.prepare("INSERT INTO forge_successor_intents (id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, reason_artifact_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workflow_starting', ?, ?)").run(input.intentId, input.predecessorTaskId, input.predecessorWorkflowId, input.acceptedRevision, input.successorTaskId, input.successorWorkflowId, input.companyId, input.projectId, current.projectRevisionId, input.actorUserId, reasonArtifactId, now, now);
        });
      } catch (error) {
        const persisted = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, sha256 FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { companyId: string; sha256: string } | undefined);
        if (reasonArtifact && (!persisted || persisted.companyId !== input.companyId || persisted.sha256 !== reasonArtifact.sha256)) await artifacts.remove(reasonArtifact);
        throw error;
      }
      if (existing && reasonArtifact) {
        const persisted = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, sha256 FROM forge_artifacts WHERE id = ?").get(reasonArtifact.id) as { companyId: string; sha256: string } | undefined);
        if (!persisted) await artifacts.remove(reasonArtifact);
      }
      await startIssueWorkflow(config, { workflowId: input.successorWorkflowId, companyId: input.companyId, projectId: input.projectId, issueId: input.successorTaskId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: current.projectRevisionId, briefArtifactId: current.briefArtifactId, briefSha256: current.briefSha256, imageArtifactIds: imageIds, requestHash, roleProfiles: roles, supplementalReview: false, repairCycleLimit: config.deliveryRepairCycleLimit });
      database.authTransaction((db) => {
        db.prepare("UPDATE forge_successor_intents SET state = 'linked', updated_at = ? WHERE id = ? AND state IN ('prepared', 'workflow_starting', 'started')").run(now, input.intentId);
        db.prepare("UPDATE forge_tasks SET successor_task_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(input.successorTaskId, now, input.predecessorTaskId, input.companyId);
        db.prepare("UPDATE forge_task_creation_intents SET state = 'started', updated_at = ? WHERE id = ? AND state = 'workflow_starting'").run(now, `creation_${input.intentId}`);
        db.prepare("INSERT OR IGNORE INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'successor_linked', ?, ?, ?)").run(`audit_successor_link_${input.intentId}`, input.actorUserId, input.companyId, JSON.stringify({ intentId: input.intentId, predecessorTaskId: input.predecessorTaskId, successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId }), now);
      });
      return { successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: current.projectRevisionId, creationRevision: input.acceptedRevision };
    },
    async runLeadPlanning(input) {
      const result = await withCapacity(input, "lead", () => (agent?.runLeadPlanning ?? defaultAgent.runLeadPlanning.bind(defaultAgent))(input));
      return { ...result, leadSummary: SafeSummarySchema.parse(result.leadSummary) };
    },
    async runSupplementalReview(input) {
      return withCapacity(input, "review", () => (agent?.runSupplementalReview ?? defaultAgent.runSupplementalReview.bind(defaultAgent))(input));
    },
    async consolidateLeadPlan(input) {
      const result = await withCapacity(input, "lead", () => (agent?.consolidateLeadPlan ?? defaultAgent.consolidateLeadPlan.bind(defaultAgent))(input));
      return { ...result, leadSummary: SafeSummarySchema.parse(result.leadSummary) };
    },
    async reviewDelivery(input: WorkflowDeliveryReviewActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.subject.developerExecutionId);
      const serviceInput = { ...input, worktreePath };
      const result = await withCapacity(input, "review", async () => normalizeReviewResult(await (agent?.reviewDelivery ?? defaultAgent.reviewDelivery.bind(defaultAgent))(serviceInput), serviceInput));
      if (result.outcome === "blocked") return result;
      const reviewArtifact = await durableArtifactReference(database, artifacts, input.companyId, result.review.opinionArtifactId, "delivery-review");
      return DeliveryReviewActivityResultSchema.parse({ ...result, review: { ...result.review, summary: SafeSummarySchema.parse(result.review.summary), reviewArtifact } });
    },
    async planDeliveryRepair(input) {
      return withCapacity(input, "lead", () => (agent?.planDeliveryRepair ?? defaultAgent.planDeliveryRepair.bind(defaultAgent))(input));
    },
    async publishRelease(input: PublishReleaseActivityInput) {
      let identity = { repository: "", branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree };
      try {
        const context = database.authQuery((db) => db.prepare(`SELECT pr.id AS projectRevisionId, pr.normalized_json AS normalizedJson, d.id AS developerExecutionId, d.worktree_path AS worktreePath, d.branch_name AS branchName, r2.base_sha AS targetBaseSha, r2.subject_commit AS subjectCommit, r2.subject_tree AS subjectTree, d.delivery_artifact_id AS deliveryArtifactId, da.storage_path AS deliveryStoragePath, da.sha256 AS deliverySha, r2.id AS reviewId, t.title
          FROM forge_tasks t
          JOIN forge_project_revisions pr ON pr.id = t.project_revision_id AND pr.project_id = t.project_id AND pr.state = 'accepted'
          JOIN forge_developer_executions d ON d.id = ? AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id AND d.status = 'completed'
          JOIN forge_delivery_reviews r2 ON r2.id = ? AND r2.task_id = t.id AND r2.company_id = t.company_id AND r2.workflow_id = t.workflow_id AND r2.outcome = 'approved' AND ((r2.base_sha = d.target_base_sha AND r2.subject_commit = d.result_commit AND r2.subject_tree = d.result_tree) OR EXISTS (SELECT 1 FROM forge_forward_merges fm WHERE fm.task_id = t.id AND fm.company_id = t.company_id AND fm.status = 'merged' AND fm.prior_head = d.result_commit AND fm.current_base_sha = r2.base_sha AND fm.merge_commit = r2.subject_commit AND fm.tree = r2.subject_tree))
          JOIN forge_artifacts da ON da.id = d.delivery_artifact_id AND da.company_id = d.company_id AND da.kind = 'developer-delivery'
          WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?
            AND NOT EXISTS (SELECT 1 FROM forge_delivery_reviews newer WHERE newer.task_id = t.id AND newer.company_id = t.company_id AND newer.workflow_id = t.workflow_id AND newer.created_at > r2.created_at AND (newer.subject_commit <> r2.subject_commit OR newer.subject_tree <> r2.subject_tree OR newer.base_sha <> r2.base_sha))`).get(input.developerExecutionId, input.reviewId, input.taskId, input.companyId, input.workflowId) as { projectRevisionId: string; normalizedJson: string; developerExecutionId: string; worktreePath: string; branchName: string; targetBaseSha: string; subjectCommit: string; subjectTree: string; deliveryArtifactId: string; deliveryStoragePath: string; deliverySha: string; reviewId: string; title: string } | undefined);
        if (!context) throw new GithubReleaseFailure("stale-reviewed-revision", "The exact approved Developer revision is unavailable");
        identity = { repository: "", branchName: context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree };
        if (input.branchName !== context.branchName || input.targetBaseSha.toLowerCase() !== context.targetBaseSha.toLowerCase() || input.subjectCommit.toLowerCase() !== context.subjectCommit.toLowerCase() || input.subjectTree.toLowerCase() !== context.subjectTree.toLowerCase()) throw new GithubReleaseFailure("stale-reviewed-revision", "Workflow release identity does not match the approved Developer revision");
        let pinned: ReturnType<typeof pinnedProjectRevision>;
        try { pinned = pinnedProjectRevision(context.normalizedJson); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The accepted project revision is incomplete"); }
        identity.repository = pinned.repository;
        let acceptedRevision = true;
        try { parseAcceptedProjectRevision(context.normalizedJson); } catch { acceptedRevision = false; }
        if (!acceptedRevision) {
          await githubRelease.checkAuthentication();
          const currentBaseSha = await githubRelease.getBranchHead({ repository: pinned.repository, branch: pinned.baseBranch });
          if (currentBaseSha === null) throw new GithubReleaseFailure("target-base-drift", "Target base branch is unavailable");
          if (currentBaseSha.toLowerCase() !== context.targetBaseSha.toLowerCase()) {
            const merged = await legacyForwardMerge.reconcile({ worktreePath: context.worktreePath, repositoryPath: pinned.repositoryPath, branchName: context.branchName, expectedBaseSha: context.targetBaseSha, currentBaseSha, taskId: input.taskId, companyId: input.companyId });
          if (merged.status === "conflict") {
            const evidence = await artifacts.put(input.companyId, "merge-conflict-evidence", { filename: `${input.taskId}-${merged.forwardMergeId ?? "forward-merge"}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, priorHead: merged.priorHead, targetBaseSha: currentBaseSha, conflictFiles: merged.conflictFiles, combinedDiff: merged.conflictDiff ?? "" }), "utf8") });
            database.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt));
            const reference = await durableArtifactReference(database, artifacts, input.companyId, evidence.id, "merge-conflict-evidence");
            return PublishReleaseActivityResultSchema.parse({ outcome: "base-drift-conflict", releaseId: null, repository: pinned.repository, branchName: context.branchName, baseBranch: pinned.baseBranch, headSha: context.subjectCommit, headTree: context.subjectTree, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, reused: false, attempt: 1, baseDriftConflict: true, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), priorHead: merged.priorHead, mergeConflictEvidence: reference, targetBaseSha: currentBaseSha });
          }
            const headSha = merged.mergeCommit ?? context.subjectCommit;
            const headTree = merged.tree ?? context.subjectTree;
            return PublishReleaseActivityResultSchema.parse({ outcome: "base-drift-merged", releaseId: null, repository: pinned.repository, branchName: context.branchName, baseBranch: pinned.baseBranch, headSha, headTree, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, reused: false, attempt: 1, baseDriftMerged: true, targetBaseSha: currentBaseSha, priorHead: merged.priorHead, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), ...(merged.mergeCommit ? { mergeCommit: merged.mergeCommit } : {}), ...(merged.tree ? { tree: merged.tree } : {}) });
          }
        }
        let parsed: z.infer<typeof DeveloperDeliverySchema>;
        try { parsed = DeveloperDeliverySchema.parse(JSON.parse(artifacts.readSync({ companyId: input.companyId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha }).toString("utf8"))); }
        catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "Completed delivery artifact is unavailable"); }
        const delivery = { filesChanged: parsed.steps.flatMap((step) => step.filesChanged ?? []), commandsRun: parsed.steps.flatMap((step) => step.commandsRun ?? []), testResults: parsed.steps.flatMap((step) => step.testResults ?? []) };
        const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), coordinates: { projectRevisionId: context.projectRevisionId, repositoryPath: pinned.repositoryPath, worktreePath: context.worktreePath, repository: pinned.repository, owner: pinned.repository.split("/")[0]!, headBranch: context.branchName, baseBranch: pinned.baseBranch, expectedBaseSha: context.targetBaseSha }, reviewedRevision: { reviewId: context.reviewId, developerExecutionId: context.developerExecutionId, commitSha: context.subjectCommit, treeSha: context.subjectTree }, taskTitle: context.title, delivery });
        return PublishReleaseActivityResultSchema.parse({ outcome: "completed", releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, baseBranch: result.baseBranch, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: result.pullRequest.isDraft, reused: result.reused, attempt: result.attempt, targetBaseSha: context.targetBaseSha });
      } catch (error) {
        const failure = error instanceof GithubReleaseFailure ? error : new GithubReleaseFailure("provider-unavailable", "Release context or provider state is unavailable");
        const operation = database.authQuery((db) => db.prepare("SELECT MAX(COALESCE(attempt, 0)) AS attempt FROM forge_provider_operations WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND kind IN ('push', 'create-draft-pr')").get(input.taskId, input.companyId, input.workflowId) as { attempt: number | null });
        return PublishReleaseActivityResultSchema.parse({ outcome: "blocked", releaseId: null, ...identity, pullRequestNumber: null, pullRequestUrl: null, isDraft: true, reused: false, code: failure.code, summary: failure.summary, retryAt: failure.retryAt, attempt: operation.attempt ?? 0, evidenceArtifactId: null });
      }
    },
    async reconcileTargetBase(rawInput: ReconcileTargetBaseActivityInput): Promise<ReconcileTargetBaseActivityResult> {
      const input = ReconcileTargetBaseActivityInputSchema.parse(rawInput);
      const checkId = `target_base_${randomBytes(12).toString("hex")}`;
      const context = database.authQuery((db) => db.prepare(`SELECT t.project_revision_id AS projectRevisionId, r.normalized_json AS normalizedJson,
          d.id AS developerExecutionId, d.status AS developerStatus, d.session_ref AS developerSessionRef,
          d.branch_name AS branchName, d.worktree_path AS worktreePath, d.target_base_sha AS targetBaseSha,
          d.result_commit AS resultCommit, d.result_tree AS resultTree, d.plan_revision AS planRevision,
          d.delivery_artifact_id AS deliveryArtifactId, d.evidence_artifact_id AS evidenceArtifactId
        FROM forge_tasks t
        JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
        JOIN forge_developer_executions d ON d.id = ? AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id
        WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_revision_id = ?`).get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId) as { projectRevisionId: string; normalizedJson: string; developerExecutionId: string; developerStatus: string; developerSessionRef: string | null; branchName: string; worktreePath: string; targetBaseSha: string; resultCommit: string | null; resultTree: string | null; planRevision: number; deliveryArtifactId: string | null; evidenceArtifactId: string | null } | undefined);
      const blocked = (code: TargetBaseBlockerCode, owner: "human" | "provider" | "lead", retryable: boolean, summary: string, evidenceArtifact?: ReturnType<typeof artifactReference>, coordinates?: { observedBaseSha?: string; priorHead?: string; priorTree?: string; resultHead?: string; resultTree?: string }, operationId = input.forwardMergeId ?? checkId): ReconcileTargetBaseActivityResult => ({ outcome: "blocked", checkId: operationId, checkpoint: input.checkpoint, code, owner, retryable, summary, ...(evidenceArtifact ? { evidenceArtifact } : {}), ...(coordinates ?? {}) });
      const retryingRecordedMerge = input.verificationOnly === true && input.forwardMergeId !== undefined;
      if (!context || context.projectRevisionId !== input.projectRevisionId || !["completed", "blocked"].includes(context.developerStatus) || !context.resultCommit || !context.resultTree || (!retryingRecordedMerge && (context.targetBaseSha.toLowerCase() !== input.expectedBaseSha.toLowerCase() || context.resultCommit.toLowerCase() !== input.expectedHeadSha.toLowerCase() || context.resultTree.toLowerCase() !== input.expectedHeadTree.toLowerCase()))) {
        return blocked("merge_state_ownership_mismatch", "human", false, "The exact Developer delivery no longer matches the reconciliation coordinates");
      }
      let pinned: ReturnType<typeof parseAcceptedProjectRevision>;
      try { pinned = parseAcceptedProjectRevision(context.normalizedJson); } catch { return blocked("artifact_unavailable", "human", false, "The accepted project revision is unavailable or incomplete"); }
      const artifacts = new ArtifactStore(config.artifactRoot);
      const service = new ForwardMergeService(database, githubRelease, artifacts);
      let merge;
      try {
        if (input.verificationOnly) {
          if (!input.forwardMergeId) return blocked("merge_state_ownership_mismatch", "human", false, "The recorded forward-merge identity is unavailable");
          merge = await service.revalidateMergedOperation({ forwardMergeId: input.forwardMergeId, worktreePath: context.worktreePath, repositoryPath: pinned.repositoryPath, branchName: context.branchName, expectedBaseSha: input.expectedBaseSha, expectedHeadSha: input.expectedHeadSha, expectedHeadTree: input.expectedHeadTree, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: input.projectRevisionId, checkpoint: input.checkpoint, developerExecutionId: input.developerExecutionId });
        } else {
          merge = await service.reconcile({ worktreePath: context.worktreePath, repositoryPath: pinned.repositoryPath, branchName: context.branchName, expectedBaseSha: input.expectedBaseSha, expectedHeadSha: input.expectedHeadSha, expectedHeadTree: input.expectedHeadTree, repository: pinned.repository, baseBranch: pinned.baseBranch, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: input.projectRevisionId, checkpoint: input.checkpoint, developerExecutionId: input.developerExecutionId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), ...(input.deliveryReviewId ? { deliveryReviewId: input.deliveryReviewId } : {}), ...(input.ciRunId ? { ciRunId: input.ciRunId } : {}), ...(input.finalReviewId ? { finalReviewId: input.finalReviewId } : {}), ...(input.acceptanceId ? { acceptanceId: input.acceptanceId } : {}) });
        }
      } catch (error) {
        const failure = reconcileBlocker(error);
        return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
      }
      if (merge.status === "no_drift") return { outcome: "no_drift", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree };
      if (merge.status === "conflict") {
        if (merge.conflictEvidenceTooLarge || !merge.conflictArtifact) return blocked("conflict_evidence_too_large", "lead", false, "Conflict evidence exceeded the safe artifact limit", undefined, { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree }, merge.forwardMergeId ?? checkId);
        return { outcome: "conflict", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, conflictFileCount: merge.conflictFiles.length, conflictArtifact: artifactReference(merge.conflictArtifact) };
      }
      const storedDelivery = merge.forwardMergeId ? database.authQuery((db) => db.prepare(`SELECT developer_execution_id AS developerExecutionId, result_head AS resultHead, result_tree AS resultTree, verification_artifact_id AS verificationArtifactId, verification_artifact_sha256 AS verificationArtifactSha256, delivery_artifact_id AS deliveryArtifactId, delivery_artifact_sha256 AS deliveryArtifactSha256 FROM forge_forward_merges WHERE id = ? AND task_id = ? AND company_id = ?`).get(merge.forwardMergeId, input.taskId, input.companyId) as { developerExecutionId: string | null; resultHead: string | null; resultTree: string | null; verificationArtifactId: string | null; verificationArtifactSha256: string | null; deliveryArtifactId: string | null; deliveryArtifactSha256: string | null } | undefined) : undefined;
      const storedArtifacts = storedDelivery && storedDelivery.developerExecutionId && storedDelivery.resultHead && storedDelivery.resultTree && storedDelivery.verificationArtifactId && storedDelivery.verificationArtifactSha256 && storedDelivery.deliveryArtifactId && storedDelivery.deliveryArtifactSha256
        ? database.authQuery((db) => db.prepare("SELECT id, sha256, kind FROM forge_artifacts WHERE company_id = ? AND (id = ? OR id = ?) ORDER BY id").all(input.companyId, storedDelivery.verificationArtifactId, storedDelivery.deliveryArtifactId) as Array<{ id: string; sha256: string; kind: string }>)
        : [];
      if (storedDelivery && storedArtifacts.length === 2 && storedDelivery.developerExecutionId && storedDelivery.resultHead && storedDelivery.resultTree) {
        const verificationArtifact = storedArtifacts.find((artifact) => artifact.id === storedDelivery.verificationArtifactId && artifact.sha256 === storedDelivery.verificationArtifactSha256 && artifact.kind === "forward-merge-verification");
        const deliveryArtifact = storedArtifacts.find((artifact) => artifact.id === storedDelivery.deliveryArtifactId && artifact.sha256 === storedDelivery.deliveryArtifactSha256 && artifact.kind === "forward-merge-delivery");
        if (verificationArtifact && deliveryArtifact) return { outcome: "revalidated", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, headSha: storedDelivery.resultHead, headTree: storedDelivery.resultTree, developerExecutionId: storedDelivery.developerExecutionId, deliveryArtifact: artifactReference({ id: deliveryArtifact.id, sha256: deliveryArtifact.sha256, kind: "forward-merge-delivery" }), verificationArtifact: artifactReference({ id: verificationArtifact.id, sha256: verificationArtifact.sha256, kind: "forward-merge-verification" }) };
      }
      const guard = await createGitCommandGuard(config.runtimeRoot);
      try {
        const verification = await runPinnedVerification({ worktreePath: context.worktreePath, setupCommand: pinned.setupCommand, verificationCommand: pinned.verificationCommand, runtimeRoot: config.runtimeRoot }, { guard });
        const verificationArtifact = await artifacts.put(input.companyId, "forward-merge-verification", { filename: `${merge.forwardMergeId ?? checkId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verification), "utf8") });
        registerArtifact(database, verificationArtifact);
        const recordVerification = (code: string, summary: string): void => {
          database.authTransaction((db) => db.prepare("UPDATE forge_forward_merges SET result_head = ?, result_tree = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, failure_code = ?, failure_summary = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(merge.mergeCommit, merge.tree, verificationArtifact.id, verificationArtifact.sha256, code, summary, new Date().toISOString(), merge.forwardMergeId ?? "", input.taskId, input.companyId));
        };
        if (verification.outcome !== "passed") {
          try {
            await service.assertMergedOwnership({ worktreePath: context.worktreePath, branchName: context.branchName, priorHead: merge.priorHead, targetBaseSha: merge.targetBaseSha, mergeCommit: merge.mergeCommit!, tree: merge.tree! });
          } catch {
            const summary = "Pinned verification changed the forward-merge delivery";
            recordVerification("merge_state_ownership_mismatch", summary);
            return blocked("merge_state_ownership_mismatch", "human", false, summary, artifactReference(verificationArtifact), { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: merge.mergeCommit!, resultTree: merge.tree! }, merge.forwardMergeId ?? checkId);
          }
          recordVerification(verification.code ?? "verification_failed", verification.summary);
          return blocked(verification.code === "verification_timed_out" ? "verification_timed_out" : verification.code === "verification_evidence_too_large" ? "verification_evidence_too_large" : "verification_failed", "lead", true, verification.summary, artifactReference(verificationArtifact), { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: merge.mergeCommit!, resultTree: merge.tree! }, merge.forwardMergeId ?? checkId);
        }
        await service.assertMergedOwnership({ worktreePath: context.worktreePath, branchName: context.branchName, priorHead: merge.priorHead, targetBaseSha: merge.targetBaseSha, mergeCommit: merge.mergeCommit!, tree: merge.tree! });
        const deliveryArtifact = await artifacts.put(input.companyId, "forward-merge-delivery", { filename: `${merge.forwardMergeId ?? checkId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, checkId: merge.forwardMergeId ?? checkId, priorHead: merge.priorHead, priorTree: merge.priorTree, targetBaseSha: merge.targetBaseSha, resultCommit: merge.mergeCommit, resultTree: merge.tree, developerExecutionId: input.developerExecutionId, supersededDeliveryArtifactId: context.deliveryArtifactId, supersededEvidenceArtifactId: context.evidenceArtifactId, verificationArtifactId: verificationArtifact.id, verification }, null, 2), "utf8") });
        registerArtifact(database, deliveryArtifact);
        const newExecutionId = `developer_${randomBytes(12).toString("hex")}`;
        const now = new Date().toISOString();
        const nextAttempt = Number((database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, context.planRevision) as { attempt: number })).attempt) + 1;
        database.authTransaction((db) => {
          db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, session_ref, started_at, finished_at, heartbeat_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, execution_kind) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?, ?, 'forward_merge')").run(newExecutionId, input.taskId, input.companyId, input.workflowId, context.planRevision, nextAttempt, context.branchName, context.worktreePath, merge.targetBaseSha, input.developerExecutionId, context.developerSessionRef, now, now, now, merge.mergeCommit, merge.tree, deliveryArtifact.id, verificationArtifact.id);
          db.prepare("UPDATE forge_forward_merges SET result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, delivery_artifact_id = ?, delivery_artifact_sha256 = ?, supersedes_delivery_artifact_id = ?, supersedes_evidence_artifact_id = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(merge.mergeCommit, merge.tree, newExecutionId, verificationArtifact.id, verificationArtifact.sha256, deliveryArtifact.id, deliveryArtifact.sha256, context.deliveryArtifactId, context.evidenceArtifactId, now, merge.forwardMergeId ?? "", input.taskId, input.companyId);
        });
        return { outcome: "revalidated", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, headSha: merge.mergeCommit!, headTree: merge.tree!, developerExecutionId: newExecutionId, deliveryArtifact: artifactReference(deliveryArtifact), verificationArtifact: artifactReference(verificationArtifact) };
      } catch (error) {
        if (error instanceof ForwardMergeFailure) {
          const failure = reconcileBlocker(error);
          return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
        }
        return blocked("verification_failed", "lead", true, "Pinned verification could not be completed");
      } finally { await guard.cleanup(); }
    },
    async reconcileCi(input: ReconcileCiActivityInput) {
      const context = database.authQuery((db) => db.prepare("SELECT r.normalized_json AS normalizedJson FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' WHERE t.id = ? AND t.company_id = ?").get(input.taskId, input.companyId) as { normalizedJson: string } | undefined);
      if (!context) throw new Error("CI repository context is unavailable");
      const result = await ci.reconcile({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, expectedHeadSha: input.expectedHeadSha, attemptNumber: input.attemptNumber });
      return { runId: result.runId, attemptId: result.attemptId, attemptNumber: result.attemptNumber, expectedHeadSha: result.expectedHeadSha, observedHeadSha: result.observedHeadSha, evidenceArtifactId: result.evidenceArtifactId, outcome: result.outcome, reason: result.reason, owner: result.owner, repairable: result.repairable, summary: result.summary, retryAt: result.retryAt, nextPollAt: result.nextPollAt, policyHash: result.policyHash, propagationDeadline: result.propagationDeadline, overallDeadline: result.overallDeadline };
    },
    async planCiRepair(input) {
      return withCapacity(input, "lead", () => (agent?.planCiRepair ?? defaultAgent.planCiRepair.bind(defaultAgent))(input));
    },
    async finalReview(input: WorkflowFinalReviewActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.developerExecutionId);
      const context = database.authQuery((db) => db.prepare("SELECT r.normalized_json AS normalizedJson, rel.repository, rel.pr_number AS pullRequestNumber, rel.pr_url AS pullRequestUrl, rel.head_branch AS headBranch, rel.base_branch AS baseBranch, rel.base_sha AS baseSha, rel.head_sha AS headSha, rel.superseded_at AS supersededAt FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' JOIN forge_releases rel ON rel.id = ? AND rel.task_id = t.id AND rel.company_id = t.company_id WHERE t.id = ? AND t.company_id = ?").get(input.releaseId, input.taskId, input.companyId) as { normalizedJson: string; repository: string; pullRequestNumber: number | null; pullRequestUrl: string | null; headBranch: string; baseBranch: string; baseSha: string; headSha: string; supersededAt: string | null } | undefined);
      const pinned = context ? pinnedProjectRevision(context.normalizedJson) : undefined;
      if (!context || !pinned || context.supersededAt || context.pullRequestNumber === null) throw new Error("Final review release is unavailable");
      const currentPullRequest = await githubRelease.getPullRequest({ repository: context.repository, number: context.pullRequestNumber });
      if (currentPullRequest.state !== "open" || !currentPullRequest.isDraft || currentPullRequest.repository.toLowerCase() !== context.repository.toLowerCase() || currentPullRequest.number !== context.pullRequestNumber || currentPullRequest.url.replace(/\/$/, "").toLowerCase() !== context.pullRequestUrl?.replace(/\/$/, "").toLowerCase() || currentPullRequest.baseBranch !== context.baseBranch || currentPullRequest.baseSha.toLowerCase() !== context.baseSha.toLowerCase() || currentPullRequest.headBranch !== context.headBranch || currentPullRequest.headSha.toLowerCase() !== context.headSha.toLowerCase() || currentPullRequest.headSha.toLowerCase() !== input.subjectCommit.toLowerCase()) throw new Error("Pull request head changed before final review");
      {
        const currentBaseSha = await githubRelease.getBranchHead({ repository: pinned.repository, branch: pinned.baseBranch });
        if (currentBaseSha === null) throw new Error("Target base branch is unavailable");
        if (currentBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new Error("Target base has drifted since CI completed; a fresh forward merge and review are required");
      }
      const developerSessionRef = database.authQuery((db) => db.prepare("SELECT session_ref AS sessionRef FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND delivery_artifact_id = ? AND evidence_artifact_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId, input.deliveryArtifactId, input.evidenceArtifactId) as { sessionRef: string } | undefined)?.sessionRef;
      if (!developerSessionRef) throw new AgentFailure("scoped-input-missing", "Final review requires the exact Developer session");
      const reviewInput = { ...input, worktreePath, roleProfiles: input.roleProfiles, reviewKind: "final" as const, subject: { planRevision: input.planRevision, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree, developerExecutionId: input.developerExecutionId, deliveryArtifactId: input.deliveryArtifactId, developerEvidenceArtifactId: input.evidenceArtifactId, leadSessionRef: input.leadSessionRef, developerSessionRef }, supersedesReviewId: null };
      const review = await withCapacity(input, "review", () => (agent?.reviewDelivery ?? defaultAgent.reviewDelivery.bind(defaultAgent))(reviewInput));
      const normalized = normalizeReviewResult(review, reviewInput);
      if (normalized.outcome !== "completed") throw new AgentFailure(normalized.code, normalized.summary);
      const reviewArtifact = await durableArtifactReference(database, artifacts, input.companyId, normalized.review.opinionArtifactId, "delivery-review");
      return { finalReviewId: normalized.review.reviewId, leadExecutionId: normalized.review.leadExecutionId, leadSessionRef: normalized.review.leadSessionRef, opinionArtifactId: normalized.review.opinionArtifactId, evidenceArtifactId: normalized.review.evidenceArtifactId, reviewArtifact, outcome: normalized.review.opinion, summary: SafeSummarySchema.parse(normalized.review.summary), findings: normalized.review.findings, repairPlan: normalized.review.repairPlan, repairPlanArtifactId: normalized.review.repairPlanArtifactId ?? null, repairPlanSha256: normalized.review.repairPlanSha256 ?? null };
    },
    async acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }) {
      const context = database.authQuery((db) => db.prepare("SELECT pr.normalized_json AS normalizedJson FROM forge_tasks t JOIN forge_project_revisions pr ON pr.id = t.project_revision_id AND pr.id = ? AND pr.state = 'accepted' WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?").get(input.projectRevisionId, input.taskId, input.companyId, input.workflowId) as { normalizedJson: string } | undefined);
      if (!context) throw new Error("Acceptance context is unavailable");
      const pinned = pinnedProjectRevision(context.normalizedJson);
      if (pinned.repository !== input.repository || pinned.baseBranch !== input.baseBranch || pinned.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error("Acceptance configuration does not match the pinned project revision");
      const result = await acceptance.accept({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: input.projectRevisionId, releaseId: input.releaseId, deliveryReviewId: input.deliveryReviewId, finalReviewId: input.finalReviewId, ciRunId: input.ciRunId, pullRequestNumber: input.pullRequestNumber, repository: input.repository, baseBranch: input.baseBranch, baseSha: input.baseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree, leadSessionRef: input.leadSessionRef, actorUserId: input.actorUserId, ...(input.decision ? { decision: input.decision } : {}), ...(input.note !== undefined ? { reason: input.note } : {}) });
      return { acceptanceId: result.acceptanceId, status: result.status, ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}), ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}), pullRequestNumber: result.pullRequest?.number ?? input.pullRequestNumber, pullRequestUrl: result.pullRequest?.url ?? "", ...(result.readyAt !== undefined ? { readyAt: result.readyAt } : {}), ...(result.acceptedAt !== undefined ? { acceptedAt: result.acceptedAt } : {}), ...(result.reasonArtifactId !== undefined ? { reasonArtifactId: result.reasonArtifactId } : {}) };
    },
    async reconcileAcceptance(input: ReconcileAcceptanceActivityInput) {
      const result = await acceptance.reconcileReady({ acceptanceId: input.acceptanceId, taskId: input.taskId, companyId: input.companyId });
      return { acceptanceId: result.acceptanceId, status: result.status, outcome: result.outcome, retryAt: result.retryAt, readyAt: result.readyAt, acceptedAt: result.acceptedAt, ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}), pullRequestNumber: result.pullRequest?.number ?? 0, pullRequestUrl: result.pullRequest?.url ?? "" };
    },
    async reconcileMerge(input: ReconcileMergeActivityInput) {
      const result = await acceptance.reconcileMerge(input);
      return { outcome: result.outcome, pullRequestNumber: result.pullRequest?.number ?? 0, pullRequestUrl: result.pullRequest?.url ?? "", mergeObservationId: result.observationId, completionReceiptId: result.completionReceiptId, observedAt: result.observedAt, mergedAt: result.mergedAt, retryAt: result.retryAt ?? result.blocker?.retryAt ?? null, ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}) };
    },
    async planMergeConflict(input: WorkflowMergeConflictPlanActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input);
      const rawInput: MergeConflictPlanActivityInput = { ...input, worktreePath };
      return withCapacity(input, "lead", () => (agent?.planMergeConflict ?? defaultAgent.planMergeConflict.bind(defaultAgent))(rawInput));
    },
    async resolveMergeConflict(input: WorkflowMergeConflictResolutionActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.developerExecutionId);
      const rawInput: MergeConflictResolutionActivityInput = { ...input, worktreePath };
      const operation = developer.runMergeConflictResolution ? developer.runMergeConflictResolution.bind(developer) : defaultDeveloper.runMergeConflictResolution.bind(defaultDeveloper);
      return withCapacity(input, "developer", () => operation(rawInput));
    },
    async runDeveloperExecution(input) {
      const operation = developer.run ? developer.run.bind(developer) : defaultDeveloper.run.bind(defaultDeveloper);
      const result = await withCapacity(input, "developer", () => operation(input));
      if (input.executionId && result.developerExecutionId !== input.executionId) throw new Error("Developer execution identity did not match the durable Workflow operation");
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      return { ...safeResult, deliverySummary: SafeSummarySchema.parse(safeResult.deliverySummary) };
    },
    async runDeveloperRepair(input: WorkflowDeveloperRepairActivityInput) {
      const execution = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string; targetBaseSha: string; resultCommit: string | null; resultTree: string | null } | undefined) ?? { worktreePath: latestWorktree(input, input.developerExecutionId), branchName: input.branchName, targetBaseSha: input.targetBaseSha, resultCommit: input.subjectCommit, resultTree: input.subjectTree };
      if (!execution) throw new Error("Developer execution context is unavailable");
      let blockingFindings = input.blockingFindings;
      let repairPlan = input.repairPlan;
      let artifactRepairPlan: string | undefined;
      if (input.repairPlanArtifactId) {
        const reference = await durableArtifactReference(database, artifacts, input.companyId, input.repairPlanArtifactId, "delivery-repair-plan");
        if (!input.repairPlanSha256 || reference.sha256 !== input.repairPlanSha256) throw new Error("Repair plan artifact hash mismatch");
        artifactRepairPlan = (await verifiedArtifactBytes(database, artifacts, input.companyId, { ...reference, sha256: input.repairPlanSha256 }, "delivery-repair-plan")).toString("utf8");
        repairPlan = artifactRepairPlan;
      }
      if (input.reviewArtifact) {
        const review = DeliveryReviewSchema.parse(JSON.parse((await verifiedArtifactBytes(database, artifacts, input.companyId, input.reviewArtifact, "delivery-review")).toString("utf8")));
        if (typeof review.repairPlan !== "string") throw new Error("Delivery review artifact is not repairable");
        blockingFindings = review.findings;
        if (artifactRepairPlan && artifactRepairPlan !== review.repairPlan) throw new Error("Repair plan artifact does not match the authoritative delivery review");
        repairPlan = review.repairPlan;
      }
      if (!blockingFindings || !repairPlan) throw new Error("Delivery review repair evidence is unavailable");
      const serviceInput = { ...input, worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree!, blockingFindings, repairPlan };
      const result = await withCapacity(input, "developer", async () => normalizeRepairResult(await (developer.runRepair ?? defaultDeveloper.runRepair.bind(defaultDeveloper))(serviceInput), serviceInput));
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      return { ...safeResult, summary: SafeSummarySchema.parse(safeResult.summary) };
    },
    async runCiRepair(input: WorkflowCiRepairActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.priorDeveloperExecutionId);
      const operation = developer.runCiRepair ? developer.runCiRepair.bind(developer) : defaultDeveloper.runCiRepair.bind(defaultDeveloper);
      const result = await withCapacity(input, "developer", () => operation({ ...input, worktreePath }));
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      return safeResult;
    },
    async cancelDeveloperExecution(input) {
      return cancelDeveloperExecution(database, input.executionId);
    },
    async recordPlanDecision(input) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Plan decision actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin" ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ?").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Plan decision scope is unavailable");
      const note = (redact(input.note.trim()) as string) || `${input.decision} plan`;
      const artifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "plan-decision", { filename: `decision_${input.planRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(note, "utf8") });
      const decisionId = `decision_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
        db.prepare("INSERT INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(decisionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.decision, input.actorUserId, artifact.id, artifact.createdAt);
      });
      return { decisionId };
    },
    async recordDeliveryDecision(rawInput) {
      const input = DeliveryDecisionActivityInputSchema.parse(rawInput);
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Delivery decision actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId)
        : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Delivery decision scope is unavailable");
      const note = (redact(input.note.trim()) as string) || "Member decision recorded for blocked delivery";
      const artifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "delivery-decision", { filename: "delivery-decision.md", mimeType: "text/markdown", bytes: Buffer.from(note, "utf8") });
      const decisionId = `delivery_decision_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
        db.prepare("INSERT INTO forge_delivery_decisions (id, task_id, company_id, workflow_id, actor_user_id, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(decisionId, input.taskId, input.companyId, input.workflowId, input.actorUserId, artifact.id, artifact.createdAt);
      });
      return { artifactId: artifact.id };
    },
  };
}
