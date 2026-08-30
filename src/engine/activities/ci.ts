import type { CiActivities, ReconcileCiActivityInput, WorkflowCiRepairActivityInput, WorkflowCiRepairActivityResult } from "../contracts/activities/ci.js";
import type { AttentionCategory } from "../contracts/primitives.js";
import type { ActivityContext } from "./context.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";

export function createCiActivities(ctx: ActivityContext): CiActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async reconcileCi(input: ReconcileCiActivityInput) {
      try { database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); }
      catch { return attentionFailure(input, "provider_ambiguity", "ci_repository_context_unavailable", "CI repository context is unavailable."); }
      try {
        const result = await ci.reconcile({ taskId: input.taskId, companyId: input.companyId, releaseId: input.releaseId, expectedHeadSha: input.expectedHeadSha, attemptNumber: input.attemptNumber });
        return { runId: result.runId, attemptId: result.attemptId, attemptNumber: result.attemptNumber, expectedHeadSha: result.expectedHeadSha, observedHeadSha: result.observedHeadSha, evidenceArtifactId: result.evidenceArtifactId, outcome: result.outcome, reason: result.reason, owner: result.owner, repairable: result.repairable, summary: result.summary, retryAt: result.retryAt, nextPollAt: result.nextPollAt, policyHash: result.policyHash, propagationDeadline: result.propagationDeadline, overallDeadline: result.overallDeadline };
      } catch (error) {
        const category: AttentionCategory = error instanceof CiProviderFailure && error.code === "authentication" ? "provider_authentication" : error instanceof CiFailure && error.code === "scope" ? "provider_ambiguity" : error instanceof CiProviderFailure && (error.code === "rate_limited" || error.code === "transient") ? "provider_connectivity_exhausted" : "provider_ambiguity";
        return attentionFailure(input, category, "ci_provider_failure", error instanceof Error ? error.message : "CI provider reconciliation failed.");
      }
    },
    async planCiRepair(input) {
      const result = await invokeAgent(input, () => (agent?.planCiRepair ?? defaultAgent.planCiRepair.bind(defaultAgent))(input));
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.leadExecutionId, sessionRef: result.leadSessionRef }, result);
    },
    async rerunCi(input) {
      try {
        const result = await ci.rerunFailedChecks({ taskId: input.taskId, companyId: input.companyId, attemptId: input.ciAttemptId });
        return { rerunRunIds: result.rerunRunIds, summary: `Re-ran ${result.rerunRunIds.length} failed CI run(s)` };
      } catch (error) {
        const category: AttentionCategory = error instanceof CiProviderFailure && error.code === "authentication" ? "provider_authentication" : "provider_ambiguity";
        return attentionFailure(input, category, "ci_rerun_failed", error instanceof Error ? error.message : "CI rerun failed.");
      }
    },
    async updateCiFromBase(input) {
      const context = database.authQuery((db) => db.prepare(`SELECT d.worktree_path AS worktreePath
        FROM forge_tasks t
        JOIN forge_developer_executions d ON d.id = ? AND d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id
        WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`).get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { worktreePath: string } | undefined);
      if (!context) throw new Error("The exact CI delivery worktree is unavailable");
      const pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input));
      const adopt = (baseSha: string, headSha: string, headTree: string): { outcome: "updated"; baseSha: string; headSha: string; headTree: string; summary: string } => {
        const now = new Date().toISOString();
        const update = database.authTransaction((db) => {
          const release = db.prepare("UPDATE forge_releases SET base_sha = ?, head_sha = ?, head_tree = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(baseSha, headSha, headTree, now, input.releaseId, input.taskId, input.companyId);
          db.prepare("UPDATE forge_ci_runs SET expected_head_sha = ?, expected_head_tree = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(headSha, headTree, now, input.ciRunId, input.taskId, input.companyId);
          return release;
        });
        if (update.changes !== 1) throw new Error("The exact CI release record is unavailable");
        return { outcome: "updated", baseSha, headSha, headTree, summary: "Merged the latest base branch into the pull request and pushed it" };
      };
      const local = await githubRelease.inspectLocalRevision({ cwd: context.worktreePath });
      const remoteHead = await githubRelease.getBranchHead({ repository: pinned.repository, branch: input.branchName });
      if (!local.clean
        || local.branch !== input.branchName
        || local.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()
        || local.treeSha.toLowerCase() !== input.expectedHeadTree.toLowerCase()
        || remoteHead?.toLowerCase() !== input.expectedHeadSha.toLowerCase()) throw new CiFailure("stale-input");
      const service = new ForwardMergeService(database, githubRelease, new ArtifactStore(config.artifactRoot));
      const merge = await service.reconcile({
        worktreePath: context.worktreePath,
        repositoryPath: pinned.repositoryPath,
        repository: pinned.repository,
        baseBranch: pinned.baseBranch,
        branchName: input.branchName,
        expectedBaseSha: input.expectedBaseSha,
        expectedHeadSha: input.expectedHeadSha,
        expectedHeadTree: input.expectedHeadTree,
        taskId: input.taskId,
        companyId: input.companyId,
        workflowId: input.workflowId,
        projectRevisionId: pinned.artifactId,
        checkpoint: "ci_update_from_base",
        developerExecutionId: input.developerExecutionId,
        releaseId: input.releaseId,
        ciRunId: input.ciRunId,
      });
      if (merge.status === "no_drift") return { outcome: "no_drift" as const, summary: "The pull request base has not advanced" };
      if (merge.status === "conflict") {
        if (!merge.forwardMergeId || !merge.priorTree || !merge.conflictArtifact || !merge.conflictFiles.length) throw new Error("Base update conflict evidence is unavailable");
        return { outcome: "conflict" as const, forwardMergeId: merge.forwardMergeId, priorHead: merge.priorHead, priorTree: merge.priorTree, baseSha: merge.targetBaseSha, conflictArtifactId: merge.conflictArtifact.id, conflictArtifactSha256: merge.conflictArtifact.sha256, conflictFileCount: merge.conflictFiles.length, summary: "Updating the pull request branch has a merge conflict" };
      }
      if (!merge.mergeCommit || !merge.tree) throw new Error("Updated pull request branch is incomplete");
      await githubRelease.pushNormal({ cwd: context.worktreePath, branch: input.branchName });
      const observedHead = await githubRelease.getBranchHead({ repository: pinned.repository, branch: input.branchName });
      if (observedHead?.toLowerCase() !== merge.mergeCommit.toLowerCase()) throw new Error("The updated CI branch was not confirmed on the provider");
      return adopt(merge.targetBaseSha, merge.mergeCommit, merge.tree);
    },
    async runCiRepair(input: WorkflowCiRepairActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.priorDeveloperExecutionId);
      const supervised = await invokeAgent(input, () => runSupervised<WorkflowCiRepairActivityResult>(input, async (service) => {
        const { worktreePath: _worktreePath, ...result } = await service.runCiRepair({ ...input, worktreePath });
        void _worktreePath;
        return result;
      }));
      if (supervised.status !== "completed") throw ApplicationFailure.nonRetryable(supervised.summary, supervised.reasonCode, { executionId: supervised.developerExecutionId });
      const result = supervised.result;
      activityWorktrees.set(result.developerExecutionId, worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, worktreePath);
      const safeResult = result;
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath }, safeResult);
    },
  };
}
