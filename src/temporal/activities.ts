import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { ForgeDatabase } from "../database.js";
import type { ForgeConfig } from "../config.js";
import { ArtifactStore } from "../artifacts.js";
import { redact } from "../logging.js";
import { AgentService } from "../codex-lead.js";
import { DeveloperService } from "../codex-developer.js";
import { cancelDeveloperExecution } from "../developer-recovery.js";
import { AcceptanceService } from "../acceptance.js";
import { CiService, createGithubCiProvider } from "../ci.js";
import { createGithubReleasePort, ReleaseService, type GithubReleasePort } from "../github-release.js";
import { ForwardMergeService } from "../forward-merge.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { DeliveryDecisionActivityInputSchema, IssueWorkflowStateSchema, type AcceptDeliveryActivityInput, type FinalReviewActivityInput, type IssueActivities, type IssueWorkflowState, type MergeConflictPlanActivityInput, type MergeConflictResolutionActivityInput, type PublishReleaseActivityInput, type ReconcileCiActivityInput, type ReconcileMergeActivityInput } from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";
import { CapacityManager } from "../capacity.js";

export interface ActivityOptions {
  agent?: Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan" | "reviewDelivery" | "planMergeConflict">>;
  developer?: Partial<Pick<DeveloperService, "run" | "runRepair" | "runMergeConflictResolution">>;
  githubRelease?: GithubReleasePort;
}

export class CapacityWaitError extends Error {
  constructor(readonly requestId: string, readonly position: number) {
    super(`Forge capacity is unavailable; retry request ${requestId} at queue position ${position}`);
    this.name = "CapacityWaitError";
  }
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

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities {
  const logger = new StructuredLogger();
  const defaultAgent = new AgentService(database, config);
  const defaultDeveloper = new DeveloperService(database, config);
  const githubRelease = options.githubRelease ?? createGithubReleasePort();
  const release = new ReleaseService(database, new ArtifactStore(config.artifactRoot), githubRelease);
  const ci = new CiService(database, createGithubCiProvider(), new ArtifactStore(config.artifactRoot));
  const acceptance = new AcceptanceService(database, githubRelease);
  const forwardMerge = new ForwardMergeService(database);
  const capacity = new CapacityManager(database, config);
  capacity.reconcileFromLedgers();
  const agent = options.agent;
  const developer = options.developer ?? defaultDeveloper;
  const withCapacity = async <T>(input: { taskId: string; companyId: string; workflowId: string }, turnKind: "lead" | "developer" | "review", operation: () => Promise<T>): Promise<T> => {
    const request = capacity.request({ ...input, turnKind });
    const admitted = capacity.tryAcquire(request.id);
    if (!admitted.acquired) throw new CapacityWaitError(request.id, capacity.position(request.id) ?? 1);
    try { return await operation(); } finally { capacity.release(request.id, "turn-completed"); }
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
    async projectIssueState(input: IssueWorkflowState): Promise<IssueWorkflowState> {
      const state = IssueWorkflowStateSchema.parse(input);
      database.projectIssueState({
        taskId: state.issueId,
        companyId: state.companyId,
        projectId: state.projectId,
        workflowId: state.workflowId,
        revision: state.revision,
        phase: state.phase,
        owner: state.owner,
        allowedCommands: state.allowedCommands,
        pendingAction: state.pendingAction,
        lastEventId: state.lastEventId,
        state,
        ...(state.planRevision !== undefined ? { planRevision: state.planRevision } : {}),
        ...(state.planMaterial !== undefined ? { planMaterial: state.planMaterial } : {}),
        ...(state.materialCategories !== undefined ? { materialCategories: state.materialCategories } : {}),
        ...(state.supplementalReviewUsed !== undefined ? { supplementalReviewUsed: state.supplementalReviewUsed } : {}),
        ...(state.supplementalReviewArtifactId !== undefined ? { supplementalReviewArtifactId: state.supplementalReviewArtifactId } : {}),
        ...(state.decisionId !== undefined ? { decisionId: state.decisionId } : {}),
        ...(state.developerExecutionId !== undefined ? { developerExecutionId: state.developerExecutionId } : {}),
        ...(state.developerSessionRef !== undefined ? { developerSessionRef: state.developerSessionRef } : {}),
        ...(state.worktreePath !== undefined ? { worktreePath: state.worktreePath } : {}),
        ...(state.branchName !== undefined ? { branchName: state.branchName } : {}),
        ...(state.targetBaseSha !== undefined ? { targetBaseSha: state.targetBaseSha } : {}),
        ...(state.currentStep !== undefined ? { currentStep: state.currentStep } : {}),
        ...(state.resultCommit !== undefined ? { resultCommit: state.resultCommit } : {}),
        ...(state.resultTree !== undefined ? { resultTree: state.resultTree } : {}),
        ...(state.dirtyState !== undefined ? { dirtyState: state.dirtyState } : {}),
        ...(state.deliveryArtifactId !== undefined ? { deliveryArtifactId: state.deliveryArtifactId } : {}),
        ...(state.developerEvidenceArtifactId !== undefined ? { developerEvidenceArtifactId: state.developerEvidenceArtifactId } : {}),
        ...(state.deliverySummary !== undefined ? { deliverySummary: state.deliverySummary } : {}),
        ...(state.developerOutcome !== undefined ? { developerOutcome: state.developerOutcome } : {}),
        ...(state.deliveryReviewId !== undefined ? { deliveryReviewId: state.deliveryReviewId } : {}),
        ...(state.deliveryReviewOutcome !== undefined ? { deliveryReviewOutcome: state.deliveryReviewOutcome } : {}),
        ...(state.deliveryReviewSummary !== undefined ? { deliveryReviewSummary: state.deliveryReviewSummary } : {}),
        ...(state.deliveryBlockingFindings !== undefined ? { deliveryBlockingFindings: state.deliveryBlockingFindings } : {}),
        ...(state.deliveryRepairPlan !== undefined ? { deliveryRepairPlan: state.deliveryRepairPlan } : {}),
        ...(state.repairCycle !== undefined ? { repairCycle: state.repairCycle } : {}),
        ...(state.deliveryDecisionArtifactId !== undefined ? { deliveryDecisionArtifactId: state.deliveryDecisionArtifactId } : {}),
      });
      return state;
    },
    async runLeadPlanning(input) {
      return withCapacity(input, "lead", () => (agent?.runLeadPlanning ?? defaultAgent.runLeadPlanning.bind(defaultAgent))(input));
    },
    async runSupplementalReview(input) {
      return withCapacity(input, "review", () => (agent?.runSupplementalReview ?? defaultAgent.runSupplementalReview.bind(defaultAgent))(input));
    },
    async consolidateLeadPlan(input) {
      return withCapacity(input, "lead", () => (agent?.consolidateLeadPlan ?? defaultAgent.consolidateLeadPlan.bind(defaultAgent))(input));
    },
    async reviewDelivery(input) {
      return withCapacity(input, "review", () => (agent?.reviewDelivery ?? defaultAgent.reviewDelivery.bind(defaultAgent))(input));
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
            return { releaseId: "", repository, branchName: input.branchName || context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree, pullRequestNumber: 0, pullRequestUrl: "", isDraft: false, reused: false, baseDriftConflict: true, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), priorHead: merged.priorHead, conflictFiles: merged.conflictFiles, ...(merged.conflictDiff !== undefined ? { conflictDiff: merged.conflictDiff } : {}), targetBaseSha: currentBaseSha };
          }
          const headSha = merged.mergeCommit ?? context.subjectCommit;
          const headTree = merged.tree ?? context.subjectTree;
          return { releaseId: "", repository, branchName: input.branchName || context.branchName, headSha, headTree, pullRequestNumber: 0, pullRequestUrl: "", isDraft: false, reused: false, baseDriftMerged: true, targetBaseSha: currentBaseSha, priorHead: merged.priorHead, ...(merged.forwardMergeId ? { forwardMergeId: merged.forwardMergeId } : {}), ...(merged.mergeCommit ? { mergeCommit: merged.mergeCommit } : {}), ...(merged.tree ? { tree: merged.tree } : {}) };
        }
      }
      const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, repositoryPath: context.worktreePath, repository, branchName: input.branchName || context.branchName, baseBranch, targetBaseSha: input.targetBaseSha || context.targetBaseSha, subjectCommit: input.subjectCommit || context.subjectCommit, subjectTree: input.subjectTree || context.subjectTree, reviewId: input.reviewId, planSummary: input.planSummary || context.title, deliverySummary: input.deliverySummary || context.deliverySummary, verificationSummary: input.verificationSummary });
      return { releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: result.pullRequest.isDraft, reused: result.reused, targetBaseSha: input.targetBaseSha || context.targetBaseSha };
    },
    async reconcileCi(input: ReconcileCiActivityInput) {
      const context = database.authQuery((db) => db.prepare("SELECT r.normalized_json AS normalizedJson FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' WHERE t.id = ? AND t.company_id = ?").get(input.taskId, input.companyId) as { normalizedJson: string } | undefined);
      if (!context) throw new Error("CI repository context is unavailable");
      const pinned = pinnedProjectRevision(context.normalizedJson);
      const result = await ci.reconcile({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, repository: pinned.repository, expectedHeadSha: input.expectedHeadSha, requiredChecks: pinned.requiredChecks, ...(input.attempt !== undefined ? { attempt: input.attempt } : {}) });
      return { runId: result.runId, outcome: result.outcome, summary: result.summary, nextPollAt: result.nextPollAt };
    },
    async finalReview(input: FinalReviewActivityInput) {
      const context = database.authQuery((db) => db.prepare("SELECT r.normalized_json AS normalizedJson FROM forge_tasks t JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' WHERE t.id = ? AND t.company_id = ?").get(input.taskId, input.companyId) as { normalizedJson: string } | undefined);
      const pinned = context ? pinnedProjectRevision(context.normalizedJson) : undefined;
      if (pinned && githubRelease.getBranchHead) {
        const currentBaseSha = await githubRelease.getBranchHead({ repository: pinned.repository, branch: pinned.baseBranch });
        if (currentBaseSha.toLowerCase() !== input.targetBaseSha.toLowerCase()) throw new Error("Target base has drifted since CI completed; a fresh forward merge and review are required");
      }
      const review = await withCapacity(input, "review", () => (agent?.reviewDelivery ?? defaultAgent.reviewDelivery.bind(defaultAgent))({ ...input, reviewKind: "final" }));
      return { finalReviewId: review.reviewId, leadExecutionId: review.leadExecutionId, leadSessionRef: review.leadSessionRef, opinionArtifactId: review.opinionArtifactId, evidenceArtifactId: review.evidenceArtifactId, outcome: review.outcome, summary: review.summary, findings: review.findings };
    },
    async acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }) {
      const context = database.authQuery((db) => db.prepare(`SELECT pr.normalized_json AS normalizedJson, r.id AS reviewId, r.subject_commit AS subjectCommit, r.subject_tree AS subjectTree, rel.pr_number AS pullRequestNumber
        FROM forge_tasks t JOIN forge_project_revisions pr ON pr.id = t.project_revision_id AND pr.state = 'accepted' JOIN forge_delivery_reviews r ON r.task_id = t.id AND r.company_id = t.company_id AND r.workflow_id = t.workflow_id AND r.outcome = 'approved'
        JOIN forge_releases rel ON rel.id = ? AND rel.task_id = t.id AND rel.company_id = t.company_id
        WHERE t.id = ? AND t.company_id = ? ORDER BY r.created_at DESC LIMIT 1`).get(input.releaseId, input.taskId, input.companyId) as { normalizedJson: string; reviewId: string; subjectCommit: string; subjectTree: string; pullRequestNumber: number | null } | undefined);
      if (!context || context.pullRequestNumber === null) throw new Error("Acceptance context is unavailable");
      const pinned = pinnedProjectRevision(context.normalizedJson);
      const result = await acceptance.accept({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, reviewId: context.reviewId, ...(input.finalReviewId ? { finalReviewId: input.finalReviewId } : {}), ciRunId: input.ciRunId, repository: pinned.repository, baseBranch: pinned.baseBranch, headSha: input.expectedHeadSha || context.subjectCommit, headTree: input.expectedHeadTree || context.subjectTree, actorUserId: input.actorUserId, ...(input.decision ? { decision: input.decision } : {}) });
      return { acceptanceId: result.acceptanceId, status: result.status, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url };
    },
    async reconcileMerge(input: ReconcileMergeActivityInput) {
      const context = database.authQuery((db) => db.prepare("SELECT pr.normalized_json AS normalizedJson, r.pr_number AS pullRequestNumber FROM forge_tasks t JOIN forge_project_revisions pr ON pr.id = t.project_revision_id AND pr.state = 'accepted' JOIN forge_releases r ON r.id = ? AND r.task_id = t.id AND r.company_id = t.company_id WHERE t.id = ? AND t.company_id = ?").get(input.releaseId, input.taskId, input.companyId) as { normalizedJson: string; pullRequestNumber: number | null } | undefined);
      if (!context || context.pullRequestNumber === null) throw new Error("Merge reconciliation context is unavailable");
      const pinned = pinnedProjectRevision(context.normalizedJson);
      const result = await acceptance.reconcile({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, repository: pinned.repository, number: context.pullRequestNumber, expectedHeadSha: input.expectedHeadSha, expectedBaseBranch: pinned.baseBranch });
      return { outcome: result.outcome, pullRequestNumber: result.pullRequest?.number ?? context.pullRequestNumber, pullRequestUrl: result.pullRequest?.url ?? "" };
    },
    async planMergeConflict(input: MergeConflictPlanActivityInput) {
      return withCapacity(input, "lead", () => (agent?.planMergeConflict ?? defaultAgent.planMergeConflict.bind(defaultAgent))(input));
    },
    async resolveMergeConflict(input: MergeConflictResolutionActivityInput) {
      return withCapacity(input, "developer", () => (developer?.runMergeConflictResolution ?? defaultDeveloper.runMergeConflictResolution.bind(defaultDeveloper))(input));
    },
    async runDeveloperExecution(input) {
      return withCapacity(input, "developer", () => (developer.run ?? defaultDeveloper.run.bind(defaultDeveloper))(input));
    },
    async runDeveloperRepair(input) {
      return withCapacity(input, "developer", () => (developer.runRepair ?? defaultDeveloper.runRepair.bind(defaultDeveloper))(input));
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
