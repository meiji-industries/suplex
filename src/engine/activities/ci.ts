import type { CiActivities, ReconcileCiActivityInput, WorkflowCiRepairActivityInput, WorkflowCiRepairActivityResult } from "../contracts/activities/ci.js";
import type { AttentionCategory } from "../contracts/primitives.js";
import type { ActivityContext } from "./context.js";
import type { DeveloperService } from "../../codex-developer.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { proveRevisionInGit } from "./git-proof.js";

export function createCiActivities(ctx: ActivityContext): CiActivities {
  const { database, config, ApplicationFailure, ArtifactStore, CiFailure, CiProviderFailure, ForwardMergeService, defaultAgent, githubRelease, artifacts, ci, activityWorktrees, activityWorktreesByBranch, agent, attentionFailure, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree } = ctx;
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
      const result = await invokeAgent(input, () => (agent?.planCiRepair ?? defaultAgent.planCiRepair.bind(defaultAgent))(input), input.executionRole ?? "integrator");
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
      if (local.branch !== input.branchName || remoteHead === null) throw new CiFailure("stale-input");
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
    async findCiRepairPriorDelivery(input) {
      const candidates = database.authQuery((db) => db.prepare(`SELECT id AS developerExecutionId, session_ref AS developerSessionRef, worktree_path AS worktreePath,
        branch_name AS branchName, result_tree AS resultTree
        FROM forge_developer_executions
        WHERE task_id = ? AND company_id = ? AND workflow_id = ?
          AND lower(result_commit) = lower(?)
          AND session_ref IS NOT NULL
        ORDER BY finished_at DESC, started_at DESC`).all(input.taskId, input.companyId, input.workflowId, input.resultCommit) as Array<{ developerExecutionId: string; developerSessionRef: string; worktreePath: string; branchName: string; resultTree: string | null }>);
      for (const candidate of candidates) {
        if (!candidate.resultTree) continue;
        const proof = await proveRevisionInGit(githubRelease, { worktreePath: candidate.worktreePath, branchName: candidate.branchName, commit: input.resultCommit, tree: candidate.resultTree });
        if (proof.proven) return { developerExecutionId: candidate.developerExecutionId, developerSessionRef: candidate.developerSessionRef, worktreePath: candidate.worktreePath };
      }
      return null;
    },
    async runCiRepair(input: WorkflowCiRepairActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.priorDeveloperExecutionId);
      const workflowResult = (raw: unknown): WorkflowCiRepairActivityResult => {
        const { worktreePath: _worktreePath, ...result } = raw as Awaited<ReturnType<DeveloperService["runCiRepair"]>>;
        void _worktreePath;
        return result;
      };
      const supervised = await invokeAgent(input, () => runSupervised<WorkflowCiRepairActivityResult>(input, "ci-repair", async (service, execution) => {
        return workflowResult(await service.runCiRepair({ ...input, worktreePath, signal: execution.signal }));
      }), "integrator");
      if (supervised.status !== "completed") throw ApplicationFailure.nonRetryable(supervised.summary, supervised.reasonCode, { executionId: supervised.developerExecutionId });
      const result = supervised.result;
      activityWorktrees.set(result.developerExecutionId, worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, worktreePath);
      const safeResult = result;
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath }, safeResult);
    },
  };
}
