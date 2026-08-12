import { randomBytes } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";

import { ProjectionIntegrityFailure, type ForgeDatabase } from "../database.js";
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
import { ArtifactReferenceSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, SafeSummarySchema, type AcceptDeliveryActivityInput, type DurableArtifactReference, type IssueActivities, type IssueProjectionEvent, type IssueWorkflowState, type MergeConflictPlanActivityInput, type MergeConflictResolutionActivityInput, type PublishReleaseActivityInput, type ReconcileCiActivityInput, type ReconcileMergeActivityInput, type ReconcileTargetBaseActivityInput, type ReconcileTargetBaseActivityResult, type TargetBaseBlockerCode, type WorkflowCiRepairActivityInput, type WorkflowDeliveryReviewActivityInput, type WorkflowDeveloperRepairActivityInput, type WorkflowFinalReviewActivityInput, type WorkflowMergeConflictPlanActivityInput, type WorkflowMergeConflictResolutionActivityInput } from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";
import { CapacityManager } from "../capacity.js";

export interface ActivityOptions {
  agent?: Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "planMergeConflict" | "planCiRepair">>;
  developer?: Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">>;
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

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities {
  const logger = new StructuredLogger();
  const defaultAgent = new AgentService(database, config);
  const githubRelease = options.githubRelease ?? createGithubReleasePort();
  const defaultDeveloper = new DeveloperService(database, config, { github: githubRelease });
  const artifacts = new ArtifactStore(config.artifactRoot);
  const release = new ReleaseService(database, artifacts, githubRelease);
  const ci = new CiService(database, options.ciProvider ?? createGithubCiProvider(), artifacts);
  const acceptance = new AcceptanceService(database, githubRelease);
  const legacyForwardMerge = new ForwardMergeService(database);
  const capacity = new CapacityManager(database, config);
  const activityWorktrees = new Map<string, string>();
  const activityWorktreesByBranch = new Map<string, string>();
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
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.developerExecutionId);
      const result = await withCapacity(input, "review", () => (agent?.reviewDelivery ?? defaultAgent.reviewDelivery.bind(defaultAgent))({ ...input, worktreePath }));
      const reviewArtifact = await durableArtifactReference(database, artifacts, input.companyId, result.opinionArtifactId, "delivery-review");
      return { reviewId: result.reviewId, leadExecutionId: result.leadExecutionId, leadSessionRef: result.leadSessionRef, opinionArtifactId: result.opinionArtifactId, evidenceArtifactId: result.evidenceArtifactId, reviewArtifact, outcome: result.outcome, summary: SafeSummarySchema.parse(result.summary), targetBaseSha: result.targetBaseSha, subjectCommit: result.subjectCommit, subjectTree: result.subjectTree };
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
            return PublishReleaseActivityResultSchema.parse({ outcome: "base-drift-conflict", releaseId: null, repository: pinned.repository, branchName: context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, reused: false, attempt: 1, baseDriftConflict: true, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), priorHead: merged.priorHead, mergeConflictEvidence: reference, targetBaseSha: currentBaseSha });
          }
            const headSha = merged.mergeCommit ?? context.subjectCommit;
            const headTree = merged.tree ?? context.subjectTree;
            return PublishReleaseActivityResultSchema.parse({ outcome: "base-drift-merged", releaseId: null, repository: pinned.repository, branchName: context.branchName, headSha, headTree, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, reused: false, attempt: 1, baseDriftMerged: true, targetBaseSha: currentBaseSha, priorHead: merged.priorHead, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), ...(merged.mergeCommit ? { mergeCommit: merged.mergeCommit } : {}), ...(merged.tree ? { tree: merged.tree } : {}) });
          }
        }
        let parsed: z.infer<typeof DeveloperDeliverySchema>;
        try { parsed = DeveloperDeliverySchema.parse(JSON.parse(artifacts.readSync({ companyId: input.companyId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha }).toString("utf8"))); }
        catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "Completed delivery artifact is unavailable"); }
        const delivery = { filesChanged: parsed.steps.flatMap((step) => step.filesChanged ?? []), commandsRun: parsed.steps.flatMap((step) => step.commandsRun ?? []), testResults: parsed.steps.flatMap((step) => step.testResults ?? []) };
        const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), coordinates: { projectRevisionId: context.projectRevisionId, repositoryPath: pinned.repositoryPath, worktreePath: context.worktreePath, repository: pinned.repository, owner: pinned.repository.split("/")[0]!, headBranch: context.branchName, baseBranch: pinned.baseBranch, expectedBaseSha: context.targetBaseSha }, reviewedRevision: { reviewId: context.reviewId, developerExecutionId: context.developerExecutionId, commitSha: context.subjectCommit, treeSha: context.subjectTree }, taskTitle: context.title, delivery });
        return PublishReleaseActivityResultSchema.parse({ outcome: "completed", releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: result.pullRequest.isDraft, reused: result.reused, attempt: result.attempt, targetBaseSha: context.targetBaseSha });
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
      const review = await withCapacity(input, "review", () => (agent?.reviewDelivery ?? defaultAgent.reviewDelivery.bind(defaultAgent))({ ...input, worktreePath, reviewKind: "final" }));
      const reviewArtifact = await durableArtifactReference(database, artifacts, input.companyId, review.opinionArtifactId, "delivery-review");
      return { finalReviewId: review.reviewId, leadExecutionId: review.leadExecutionId, leadSessionRef: review.leadSessionRef, opinionArtifactId: review.opinionArtifactId, evidenceArtifactId: review.evidenceArtifactId, reviewArtifact, outcome: review.outcome, summary: SafeSummarySchema.parse(review.summary) };
    },
    async acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }) {
      const context = database.authQuery((db) => db.prepare(`SELECT pr.normalized_json AS normalizedJson, r.id AS reviewId, r.subject_commit AS subjectCommit, r.subject_tree AS subjectTree, rel.pr_number AS pullRequestNumber
        FROM forge_tasks t JOIN forge_project_revisions pr ON pr.id = t.project_revision_id AND pr.state = 'accepted' JOIN forge_delivery_reviews r ON r.task_id = t.id AND r.company_id = t.company_id AND r.workflow_id = t.workflow_id AND r.outcome = 'approved'
        JOIN forge_releases rel ON rel.id = ? AND rel.task_id = t.id AND rel.company_id = t.company_id
        WHERE t.id = ? AND t.company_id = ? ORDER BY r.created_at DESC LIMIT 1`).get(input.releaseId, input.taskId, input.companyId) as { normalizedJson: string; reviewId: string; subjectCommit: string; subjectTree: string; pullRequestNumber: number | null } | undefined);
      if (!context || context.pullRequestNumber === null) throw new Error("Acceptance context is unavailable");
      const pinned = pinnedProjectRevision(context.normalizedJson);
      const result = await acceptance.accept({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, reviewId: context.reviewId, finalReviewId: input.finalReviewId, ciRunId: input.ciRunId, repository: pinned.repository, baseBranch: pinned.baseBranch, headSha: input.expectedHeadSha || context.subjectCommit, headTree: input.expectedHeadTree || context.subjectTree, actorUserId: input.actorUserId, ...(input.decision ? { decision: input.decision } : {}) });
      return { acceptanceId: result.acceptanceId, status: result.status, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url };
    },
    async reconcileMerge(input: ReconcileMergeActivityInput) {
      const context = database.authQuery((db) => db.prepare("SELECT pr.normalized_json AS normalizedJson, r.pr_number AS pullRequestNumber FROM forge_tasks t JOIN forge_project_revisions pr ON pr.id = t.project_revision_id AND pr.state = 'accepted' JOIN forge_releases r ON r.id = ? AND r.task_id = t.id AND r.company_id = t.company_id WHERE t.id = ? AND t.company_id = ?").get(input.releaseId, input.taskId, input.companyId) as { normalizedJson: string; pullRequestNumber: number | null } | undefined);
      if (!context || context.pullRequestNumber === null) throw new Error("Merge reconciliation context is unavailable");
      const pinned = parseAcceptedProjectRevision(context.normalizedJson);
      const result = await acceptance.reconcile({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, repository: pinned.repository, number: context.pullRequestNumber, expectedHeadSha: input.expectedHeadSha, expectedBaseBranch: pinned.baseBranch });
      return { outcome: result.outcome, pullRequestNumber: result.pullRequest?.number ?? context.pullRequestNumber, pullRequestUrl: result.pullRequest?.url ?? "" };
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
      if (input.reviewArtifact) {
        const review = DeliveryReviewSchema.parse(JSON.parse((await verifiedArtifactBytes(database, artifacts, input.companyId, input.reviewArtifact, "delivery-review")).toString("utf8")));
        if (typeof review.repairPlan !== "string") throw new Error("Delivery review artifact is not repairable");
        blockingFindings = review.findings;
        repairPlan = review.repairPlan;
      }
      if (!blockingFindings || !repairPlan) throw new Error("Delivery review repair evidence is unavailable");
      const operation = developer.runRepair ? developer.runRepair.bind(developer) : defaultDeveloper.runRepair.bind(defaultDeveloper);
      const result = await withCapacity(input, "developer", () => operation({ ...input, worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree!, blockingFindings, repairPlan }));
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      return { ...safeResult, deliverySummary: SafeSummarySchema.parse(safeResult.deliverySummary) };
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
