import type { ReleaseActivities, PublishReleaseActivityInput } from "../contracts/activities/release.js";
import type { AttentionCategory } from "../contracts/primitives.js";
import { z } from "zod";
import type { ActivityContext } from "./context.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";

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
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async pushDeliveryBranch(input) {
      const context = database.authQuery((db) => db.prepare(`SELECT d.worktree_path AS worktreePath
        FROM forge_tasks t
        JOIN forge_developer_executions d ON d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id AND d.branch_name = ? AND d.result_commit = ? AND d.status = 'completed'
        WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.branchName, input.commitSha, input.taskId, input.companyId, input.workflowId) as { worktreePath: string } | undefined);
      if (!context) throw new GithubReleaseFailure("stale-reviewed-revision", "The reviewed branch is unavailable for pushing");
      let pinned: ReturnType<typeof pinnedProjectRevision>;
      try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The task project configuration is incomplete"); }
      await release.pushBranch({ repository: pinned.repository, worktreePath: context.worktreePath, branchName: input.branchName, commitSha: input.commitSha });
      return { repository: pinned.repository, branchName: input.branchName, commitSha: input.commitSha };
    },
    async publishRelease(input: PublishReleaseActivityInput) {
      let identity = { repository: "", branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree };
      try {
        const context = database.authQuery((db) => db.prepare(`SELECT d.id AS developerExecutionId, d.worktree_path AS worktreePath, d.branch_name AS branchName, r2.base_sha AS targetBaseSha, r2.subject_commit AS subjectCommit, r2.subject_tree AS subjectTree, d.delivery_artifact_id AS deliveryArtifactId, da.storage_path AS deliveryStoragePath, da.sha256 AS deliverySha, r2.id AS reviewId, t.title
          FROM forge_tasks t
          JOIN forge_developer_executions d ON d.id = ? AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id AND d.status = 'completed'
          JOIN forge_delivery_reviews r2 ON r2.id = ? AND r2.task_id = t.id AND r2.company_id = t.company_id AND r2.workflow_id = t.workflow_id AND r2.outcome = 'approved'
          JOIN forge_artifacts da ON da.id = d.delivery_artifact_id AND da.company_id = d.company_id AND da.kind IN ('developer-delivery', 'developer-repair', 'forward-merge-delivery')
          WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.developerExecutionId, input.reviewId, input.taskId, input.companyId, input.workflowId) as { developerExecutionId: string; worktreePath: string; branchName: string; targetBaseSha: string; subjectCommit: string; subjectTree: string; deliveryArtifactId: string; deliveryStoragePath: string; deliverySha: string; reviewId: string; title: string } | undefined);
        if (!context) throw new GithubReleaseFailure("stale-reviewed-revision", "The exact approved Developer revision is unavailable");
        identity = { repository: "", branchName: context.branchName, headSha: context.subjectCommit, headTree: context.subjectTree };
        let pinned: ReturnType<typeof pinnedProjectRevision> & { artifactId: string };
        try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "The task project configuration is incomplete"); }
        identity.repository = pinned.repository;
        let delivery: ReturnType<typeof releaseDeliveryProjection>;
        try { delivery = releaseDeliveryProjection(JSON.parse(artifacts.getArtifactSync({ companyId: input.companyId, storagePath: context.deliveryStoragePath, sha256: context.deliverySha }).toString("utf8"))); }
        catch { throw new GithubReleaseFailure("pinned-configuration-incomplete", "Completed delivery artifact is unavailable"); }
        const result = await release.publish({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), coordinates: { projectRevisionId: pinned.artifactId, repositoryPath: pinned.repositoryPath, worktreePath: context.worktreePath, repository: pinned.repository, owner: pinned.repository.split("/")[0]!, headBranch: context.branchName, baseBranch: pinned.baseBranch, expectedBaseSha: context.targetBaseSha }, reviewedRevision: { reviewId: context.reviewId, developerExecutionId: context.developerExecutionId, commitSha: context.subjectCommit, treeSha: context.subjectTree }, taskTitle: context.title, delivery });
        if (input.pullRequestMode !== undefined && input.pullRequestMode !== "draft") await release.markReadyForReview({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, releaseId: result.releaseId, repository: result.repository, pullRequestNumber: result.pullRequest.number });
        return PublishReleaseActivityResultSchema.parse({ outcome: "completed", releaseId: result.releaseId, repository: result.repository, branchName: result.branchName, baseBranch: result.baseBranch, headSha: result.headSha, headTree: result.headTree, pullRequestNumber: result.pullRequest.number, pullRequestUrl: result.pullRequest.url, isDraft: input.pullRequestMode === undefined || input.pullRequestMode === "draft" ? result.pullRequest.isDraft : false, reused: result.reused, attempt: result.attempt, targetBaseSha: context.targetBaseSha });
      } catch (error) {
        const failure = error instanceof GithubReleaseFailure ? error : new GithubReleaseFailure("provider-unavailable", "Release context or provider state is unavailable");
        const operation = database.authQuery((db) => db.prepare("SELECT MAX(COALESCE(attempt, 0)) AS attempt FROM forge_provider_operations WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND kind IN ('push', 'create-draft-pr', 'update-draft-pr')").get(input.taskId, input.companyId, input.workflowId) as { attempt: number | null });
        const category: AttentionCategory = failure.code === "authentication-required" ? "provider_authentication" : failure.code === "stale-reviewed-revision" || failure.code === "target-base-drift" ? "target_drift" : failure.code === "provider-rate-limited" || failure.code === "provider-unavailable" || failure.code === "invalid-provider-response" ? "provider_connectivity_exhausted" : failure.code === "pinned-configuration-incomplete" || failure.code === "public-projection-unsafe" ? "verification_unrecoverable" : "provider_ambiguity";
        const evidence = await putAttentionEvidence(input, category, failure.code, failure.summary);
        return PublishReleaseActivityResultSchema.parse({ outcome: "blocked", releaseId: null, ...identity, pullRequestNumber: null, pullRequestUrl: null, isDraft: true, reused: false, code: failure.code, summary: failure.summary, retryAt: failure.retryAt, attempt: operation.attempt ?? 0, evidenceArtifactId: evidence.artifactId });
      }
    },
  };
}
