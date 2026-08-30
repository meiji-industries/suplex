import type { ReleaseActivities, PublishReleaseActivityInput, AdoptPullRequestReleaseActivityInput } from "../contracts/activities/release.js";
import { z } from "zod";
import type { ActivityContext } from "./context.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { jsonRequired } from "../../task-utils.js";

const LegacyReleaseDeliverySchema = z.object({
  summary: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  commandsRun: z.array(z.string()).optional(),
  testResults: z.array(z.string()).optional(),
  steps: z.array(z.object({
    notes: z.string().optional(),
    filesChanged: z.array(z.string()).optional(),
    commandsRun: z.array(z.string()).optional(),
    testResults: z.array(z.string()).optional(),
  }).passthrough()).default([]),
}).passthrough();

export function releaseDeliveryProjection(value: unknown): { summary?: string; changes?: string[]; filesChanged?: string[]; commandsRun?: string[]; testResults?: string[] } {
  const legacy = LegacyReleaseDeliverySchema.parse(value);
  return {
    ...(legacy.summary ? { summary: legacy.summary } : {}),
    changes: legacy.steps.flatMap((step) => step.notes ? [step.notes] : []),
    filesChanged: [...(legacy.filesChanged ?? []), ...legacy.steps.flatMap((step) => step.filesChanged ?? [])],
    commandsRun: [...(legacy.commandsRun ?? []), ...legacy.steps.flatMap((step) => step.commandsRun ?? [])],
    testResults: [...(legacy.testResults ?? []), ...legacy.steps.flatMap((step) => step.testResults ?? [])],
  };
}

export function createReleaseActivities(ctx: ActivityContext): ReleaseActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async pushDeliveryBranch(input) {
      try {
      const context = database.authQuery((db) => db.prepare(`SELECT d.worktree_path AS worktreePath
        FROM forge_tasks t
        JOIN forge_developer_executions d ON d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id AND d.branch_name = ? AND d.result_commit = ? AND d.status = 'completed'
        WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.branchName, input.commitSha, input.taskId, input.companyId, input.workflowId) as { worktreePath: string } | undefined);
      if (!context) throw new GithubReleaseFailure("stale-reviewed-revision", "The reviewed revision does not match a completed Developer execution");
      let pinned: ReturnType<typeof pinnedProjectRevision>;
      try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The task project configuration is incomplete"); }
      await release.pushBranch({ repository: pinned.repository, worktreePath: context.worktreePath, branchName: input.branchName, commitSha: input.commitSha });
        return { repository: pinned.repository, branchName: input.branchName, commitSha: input.commitSha };
      } catch (error) {
        if (error instanceof GithubReleaseFailure) throw ApplicationFailure.nonRetryable(error.summary, error.code, { code: error.code, summary: error.summary });
        throw error;
      }
    },
    async adoptPullRequestRelease(input: AdoptPullRequestReleaseActivityInput) {
      if (!githubRelease.getCommitTree) throw new GithubReleaseFailure("provider-unavailable", "GitHub commit inspection is unavailable");
      const pullRequest = await githubRelease.getPullRequest({ repository: input.repository, number: input.pullRequestNumber });
      if (pullRequest.state !== "open" || pullRequest.repository.toLowerCase() !== input.repository.toLowerCase() || pullRequest.headBranch !== input.branchName || pullRequest.headSha.toLowerCase() !== input.headSha.toLowerCase() || pullRequest.baseBranch !== input.baseBranch || (input.expectedBaseSha && pullRequest.baseSha.toLowerCase() !== input.expectedBaseSha.toLowerCase())) throw new GithubReleaseFailure("stale-reviewed-revision", "The pull request no longer matches the observed CI identity");
      const headTree = await githubRelease.getCommitTree({ repository: input.repository, commitSha: input.headSha });
      const releaseKey = createHash("sha256").update([input.workflowId, input.projectRevisionId, input.repository, input.branchName, input.baseBranch, input.headSha, headTree].join("|"), "utf8").digest("hex");
      const now = new Date().toISOString();
      const releaseId = `release_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare(`INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, reused, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 1, ?, ?, ?)
          ON CONFLICT(release_key) DO UPDATE SET repository = excluded.repository, head_branch = excluded.head_branch, base_branch = excluded.base_branch, base_sha = excluded.base_sha, head_sha = excluded.head_sha, head_tree = excluded.head_tree, status = 'ready', pr_number = excluded.pr_number, pr_url = excluded.pr_url, reused = 1, title = excluded.title, updated_at = excluded.updated_at`)
          .run(releaseId, input.taskId, input.companyId, input.workflowId, releaseKey, input.repository, input.branchName, input.baseBranch, pullRequest.baseSha, input.headSha, headTree, pullRequest.number, pullRequest.url, pullRequest.title || `Pull request #${pullRequest.number}`, now, now);
      });
      const release = database.authQuery((db) => db.prepare("SELECT id FROM forge_releases WHERE release_key = ?").get(releaseKey) as { id: string });
      return { releaseId: release.id, repository: input.repository, branchName: input.branchName, baseBranch: input.baseBranch, targetBaseSha: pullRequest.baseSha, headSha: input.headSha, headTree, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url };
    },
    async publishRelease(input: PublishReleaseActivityInput) {
      let identity = { repository: "", branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree };
      try {
        const context = database.authQuery((db) => db.prepare(`SELECT d.id AS developerExecutionId, d.worktree_path AS worktreePath, d.branch_name AS branchName, r2.base_sha AS targetBaseSha, r2.subject_commit AS subjectCommit, r2.subject_tree AS subjectTree, d.delivery_artifact_id AS deliveryArtifactId, da.storage_path AS deliveryStoragePath, da.sha256 AS deliverySha, r2.id AS reviewId, t.title
          FROM forge_tasks t
          JOIN forge_developer_executions d ON d.id = ? AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id AND d.status = 'completed'
          JOIN forge_delivery_reviews r2 ON r2.id = ? AND r2.task_id = t.id AND r2.company_id = t.company_id AND r2.workflow_id = t.workflow_id AND (r2.outcome = 'approved' OR EXISTS (SELECT 1 FROM forge_delivery_decisions dd WHERE dd.task_id = t.id AND dd.workflow_id = t.workflow_id AND dd.created_at >= r2.created_at))
          JOIN forge_artifacts da ON da.id = d.delivery_artifact_id AND da.company_id = d.company_id AND da.kind IN ('developer-delivery', 'developer-repair', 'forward-merge-delivery')
          WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.developerExecutionId, input.reviewId, input.taskId, input.companyId, input.workflowId) as { developerExecutionId: string; worktreePath: string; branchName: string; targetBaseSha: string; subjectCommit: string; subjectTree: string; deliveryArtifactId: string; deliveryStoragePath: string; deliverySha: string; reviewId: string; title: string } | undefined);
        if (!context) throw new GithubReleaseFailure("stale-reviewed-revision", "The exact approved Developer revision is unavailable");
        identity = { repository: "", branchName: context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree };
        let pinned: ReturnType<typeof pinnedProjectRevision> & { artifactId: string };
        try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The task project configuration is incomplete"); }
        identity.repository = pinned.repository;
        let delivery: ReturnType<typeof releaseDeliveryProjection>;
        try { delivery = releaseDeliveryProjection(jsonRequired(artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha }).toString("utf8"))); }
        catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "Completed delivery artifact is unavailable"); }
        const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), coordinates: { projectRevisionId: pinned.artifactId, repositoryPath: pinned.repositoryPath, worktreePath: context.worktreePath, repository: pinned.repository, owner: pinned.repository.split("/")[0]!, headBranch: context.branchName, baseBranch: pinned.baseBranch, expectedBaseSha: context.targetBaseSha }, reviewedRevision: { reviewId: context.reviewId, developerExecutionId: context.developerExecutionId, commitSha: context.subjectCommit, treeSha: context.subjectTree }, taskTitle: context.title, delivery });
        if (input.pullRequestMode !== undefined && input.pullRequestMode !== "draft") await release.markReadyForReview({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, releaseId: result.releaseId, repository: result.repository, pullRequestNumber: result.pullRequest.number });
        return PublishReleaseActivityResultSchema.parse({ outcome: "completed", releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, baseBranch: result.baseBranch, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: input.pullRequestMode === undefined || input.pullRequestMode === "draft" ? result.pullRequest.isDraft : false, reused: result.reused, attempt: result.attempt, targetBaseSha: context.targetBaseSha });
      } catch (error) {
        const failure = error instanceof GithubReleaseFailure ? error : new GithubReleaseFailure("provider-unavailable", `Could not open the pull request: ${error instanceof Error ? error.message : String(error)}`);
        const operation = database.authQuery((db) => db.prepare("SELECT MAX(COALESCE(attempt, 0)) AS attempt FROM forge_provider_operations WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND kind IN ('push', 'create-draft-pr', 'update-draft-pr')").get(input.taskId, input.companyId, input.workflowId) as { attempt: number | null });
        return PublishReleaseActivityResultSchema.parse({ outcome: "blocked", releaseId: null, ...identity, pullRequestNumber: null, pullRequestUrl: null, isDraft: true, reused: false, code: failure.code, summary: failure.summary, retryAt: failure.retryAt, attempt: operation.attempt ?? 0 });
      }
    },
  };
}
