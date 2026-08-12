import { randomBytes } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";

import { ProjectionIntegrityFailure, type ForgeDatabase } from "../database.js";
import type { ForgeConfig } from "../config.js";
import { ArtifactStore } from "../artifacts.js";
import { redact } from "../logging.js";
import { AgentFailure, AgentService } from "../codex-lead.js";
import { DeveloperService } from "../codex-developer.js";
import { cancelDeveloperExecution } from "../developer-recovery.js";
import { AcceptanceService } from "../acceptance.js";
import { CiService, createGithubCiProvider, type CiProvider } from "../ci.js";
import { createGithubReleasePort, ReleaseService, type GithubReleasePort } from "../github-release.js";
import { ForwardMergeService } from "../forward-merge.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { DeliveryDecisionActivityInputSchema, DeliveryReviewSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, SafeSummarySchema, type AcceptDeliveryActivityInput, type DurableArtifactReference, type IssueActivities, type IssueProjectionEvent, type IssueWorkflowState, type MergeConflictPlanActivityInput, type MergeConflictResolutionActivityInput, type PublishReleaseActivityInput, type ReconcileCiActivityInput, type ReconcileMergeActivityInput, type WorkflowCiRepairActivityInput, type WorkflowDeliveryReviewActivityInput, type WorkflowDeveloperRepairActivityInput, type WorkflowFinalReviewActivityInput, type WorkflowMergeConflictPlanActivityInput, type WorkflowMergeConflictResolutionActivityInput } from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";
import { CapacityManager } from "../capacity.js";

export interface ActivityOptions {
  agent?: Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "planMergeConflict" | "planCiRepair">>;
  developer?: Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution" | "runCiRepair">>;
  githubRelease?: GithubReleasePort;
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

const PinnedProjectRevisionSchema = z.object({
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  repository: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/),
  baseBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  requiredChecks: z.array(z.string()),
});

function pinnedProjectRevision(raw: string): z.infer<typeof PinnedProjectRevisionSchema> {
  try {
    return PinnedProjectRevisionSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Pinned project revision is unavailable");
  }
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

const MergeConflictEvidenceSchema = z.object({
  version: z.literal(1),
  priorHead: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  conflictFiles: z.array(z.string().min(1).max(1_000)).min(1).max(128),
  combinedDiff: z.string().max(8 * 1024 * 1024),
});

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities {
  const logger = new StructuredLogger();
  const defaultAgent = new AgentService(database, config);
  const githubRelease = options.githubRelease ?? createGithubReleasePort();
  const defaultDeveloper = new DeveloperService(database, config, { github: githubRelease });
  const artifacts = new ArtifactStore(config.artifactRoot);
  const release = new ReleaseService(database, artifacts, githubRelease);
  const ci = new CiService(database, options.ciProvider ?? createGithubCiProvider(), artifacts);
  const acceptance = new AcceptanceService(database, githubRelease);
  const forwardMerge = new ForwardMergeService(database);
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
    try {
      return await operation();
    } catch (error) {
      const permanentFailure = asNonRetryableApplicationFailure(error);
      if (permanentFailure) throw permanentFailure;
      throw error;
    } finally {
      capacity.release(request.id, "turn-completed");
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
      const context = database.authQuery((db) => db.prepare(`SELECT r.normalized_json AS normalizedJson, d.worktree_path AS worktreePath, d.branch_name AS branchName, d.target_base_sha AS targetBaseSha, d.result_commit AS subjectCommit, d.result_tree AS subjectTree, r2.summary AS deliverySummary, t.title
        FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
        JOIN forge_developer_executions d ON d.id = ?
        JOIN forge_delivery_reviews r2 ON r2.id = ? AND r2.task_id = t.id AND r2.company_id = t.company_id AND r2.workflow_id = t.workflow_id
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.developerExecutionId, input.reviewId, input.taskId, input.companyId, input.workflowId) as { normalizedJson: string; worktreePath: string; branchName: string; targetBaseSha: string; subjectCommit: string; subjectTree: string; deliverySummary: string; title: string } | undefined);
      if (!context) throw new Error("Release context is unavailable");
      const pinned = pinnedProjectRevision(context.normalizedJson);
      const repositoryPath = pinned.repositoryPath;
      const repository = pinned.repository;
      const baseBranch = pinned.baseBranch;
      if (githubRelease.getBranchHead) {
        const currentBaseSha = await githubRelease.getBranchHead({ repository, branch: baseBranch });
        const expectedBaseSha = input.targetBaseSha || context.targetBaseSha;
        if (currentBaseSha.toLowerCase() !== expectedBaseSha.toLowerCase()) {
          const merged = await forwardMerge.reconcile({ worktreePath: context.worktreePath, repositoryPath, branchName: input.branchName || context.branchName, expectedBaseSha, currentBaseSha, taskId: input.taskId, companyId: input.companyId });
          if (merged.status === "conflict") {
            const evidence = await artifacts.put(input.companyId, "merge-conflict-evidence", { filename: `${input.taskId}-${merged.forwardMergeId ?? "forward-merge"}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, priorHead: merged.priorHead, targetBaseSha: currentBaseSha, conflictFiles: merged.conflictFiles, combinedDiff: merged.conflictDiff ?? "" }), "utf8") });
            database.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt));
            const reference = await durableArtifactReference(database, artifacts, input.companyId, evidence.id, "merge-conflict-evidence");
            return { releaseId: "", repository, branchName: input.branchName || context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree, pullRequestNumber: 0, pullRequestUrl: "", isDraft: false, reused: false, baseDriftConflict: true, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), priorHead: merged.priorHead, mergeConflictEvidence: reference, targetBaseSha: currentBaseSha };
          }
          const headSha = merged.mergeCommit ?? context.subjectCommit;
          const headTree = merged.tree ?? context.subjectTree;
          return { releaseId: "", repository, branchName: input.branchName || context.branchName, headSha, headTree, pullRequestNumber: 0, pullRequestUrl: "", isDraft: false, reused: false, baseDriftMerged: true, targetBaseSha: currentBaseSha, priorHead: merged.priorHead, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), ...(merged.mergeCommit ? { mergeCommit: merged.mergeCommit } : {}), ...(merged.tree ? { tree: merged.tree } : {}) };
        }
      }
      const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, repositoryPath: context.worktreePath, repository, branchName: input.branchName || context.branchName, baseBranch, targetBaseSha: input.targetBaseSha || context.targetBaseSha, subjectCommit: input.subjectCommit || context.subjectCommit, subjectTree: input.subjectTree || context.subjectTree, reviewId: input.reviewId, planSummary: input.planSummary || context.title, deliverySummary: input.deliverySummary || context.deliverySummary, verificationSummary: input.verificationSummary, ...(input.expectedPullRequestNumber ? { expectedPullRequestNumber: input.expectedPullRequestNumber } : {}) });
      return { releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: result.pullRequest.isDraft, reused: result.reused, targetBaseSha: input.targetBaseSha || context.targetBaseSha };
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
      if (!context || !pinned || context.supersededAt || context.pullRequestNumber === null || !githubRelease.getPullRequest) throw new Error("Final review release is unavailable");
      const currentPullRequest = await githubRelease.getPullRequest({ repository: context.repository, number: context.pullRequestNumber });
      if (currentPullRequest.state !== "open" || !currentPullRequest.isDraft || currentPullRequest.repository.toLowerCase() !== context.repository.toLowerCase() || currentPullRequest.number !== context.pullRequestNumber || currentPullRequest.url.replace(/\/$/, "").toLowerCase() !== context.pullRequestUrl?.replace(/\/$/, "").toLowerCase() || currentPullRequest.baseBranch !== context.baseBranch || currentPullRequest.baseSha.toLowerCase() !== context.baseSha.toLowerCase() || currentPullRequest.headBranch !== context.headBranch || currentPullRequest.headSha.toLowerCase() !== context.headSha.toLowerCase() || currentPullRequest.headSha.toLowerCase() !== input.subjectCommit.toLowerCase()) throw new Error("Pull request head changed before final review");
      if (pinned && githubRelease.getBranchHead) {
        const currentBaseSha = await githubRelease.getBranchHead({ repository: pinned.repository, branch: pinned.baseBranch });
        if (currentBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new Error("Target base has drifted since CI completed; a fresh forward merge and review are required");
      }
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
      const pinned = pinnedProjectRevision(context.normalizedJson);
      const result = await acceptance.reconcile({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, repository: pinned.repository, number: context.pullRequestNumber, expectedHeadSha: input.expectedHeadSha, expectedBaseBranch: pinned.baseBranch });
      return { outcome: result.outcome, pullRequestNumber: result.pullRequest?.number ?? context.pullRequestNumber, pullRequestUrl: result.pullRequest?.url ?? "" };
    },
    async planMergeConflict(input: WorkflowMergeConflictPlanActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input);
      let conflictFiles = input.conflictFiles ?? [];
      let conflictDiff = input.conflictDiff ?? "";
      const conflictEvidence = input.conflictEvidence;
      if (conflictEvidence) {
        const evidence = MergeConflictEvidenceSchema.parse(JSON.parse((await verifiedArtifactBytes(database, artifacts, input.companyId, conflictEvidence, "merge-conflict-evidence")).toString("utf8")));
        if (evidence.priorHead.toLowerCase() !== input.priorHead.toLowerCase() || evidence.targetBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new Error("Merge-conflict evidence identity is invalid");
        conflictFiles = evidence.conflictFiles;
        conflictDiff = evidence.combinedDiff;
      }
      if (!conflictFiles.length) throw new Error("Merge-conflict files are unavailable");
      const rawInput: MergeConflictPlanActivityInput = { ...input, worktreePath, conflictFiles, conflictDiff };
      return withCapacity(input, "lead", () => (agent?.planMergeConflict ?? defaultAgent.planMergeConflict.bind(defaultAgent))(rawInput));
    },
    async resolveMergeConflict(input: WorkflowMergeConflictResolutionActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.developerExecutionId);
      let conflictFiles = input.conflictFiles;
      if (!conflictFiles) {
        const row = database.authQuery((db) => db.prepare("SELECT conflict_files_json AS conflictFiles FROM forge_merge_conflict_resolutions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND prior_head = ? AND target_base_sha = ? ORDER BY updated_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId, input.priorHead, input.targetBaseSha) as { conflictFiles: string } | undefined);
        conflictFiles = row ? JSON.parse(row.conflictFiles) as string[] : [];
      }
      if (!conflictFiles.length) throw new Error("Merge-conflict files are unavailable");
      const rawInput: MergeConflictResolutionActivityInput = { ...input, worktreePath, conflictFiles };
      return withCapacity(input, "developer", () => (developer?.runMergeConflictResolution ?? defaultDeveloper.runMergeConflictResolution.bind(defaultDeveloper))(rawInput));
    },
    async runDeveloperExecution(input) {
      const result = await withCapacity(input, "developer", () => (developer.run ?? defaultDeveloper.run.bind(defaultDeveloper))(input));
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
      const result = await withCapacity(input, "developer", () => (developer.runRepair ?? defaultDeveloper.runRepair.bind(defaultDeveloper))({ ...input, worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree!, blockingFindings, repairPlan }));
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      return { ...safeResult, deliverySummary: SafeSummarySchema.parse(safeResult.deliverySummary) };
    },
    async runCiRepair(input: WorkflowCiRepairActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.priorDeveloperExecutionId);
      const result = await withCapacity(input, "developer", () => (developer.runCiRepair ?? defaultDeveloper.runCiRepair.bind(defaultDeveloper))({ ...input, worktreePath }));
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
