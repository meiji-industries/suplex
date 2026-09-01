import type { MergeConflictActivities, MergeConflictPlanActivityInput, MergeConflictResolutionActivityInput, MergeConflictResolutionActivityResult, ReconcileMergeActivityInput, WorkflowMergeConflictPlanActivityInput, WorkflowMergeConflictResolutionActivityInput } from "../contracts/activities/merge-conflict.js";
import type { ActivityContext } from "./context.js";

export function createMergeConflictActivities(ctx: ActivityContext): MergeConflictActivities {
  const { defaultAgent, defaultDeveloper, acceptance, agent, developer, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree, agentRuntime } = ctx;
  return {
    async reconcileMerge(input: ReconcileMergeActivityInput) {
      const result = await acceptance.reconcileMerge(input);
      return { outcome: result.outcome, pullRequestNumber: result.pullRequest?.number ?? 0, pullRequestUrl: result.pullRequest?.url ?? "", observedHeadSha: result.pullRequest?.headSha ?? null, mergeObservationId: result.observationId, completionReceiptId: result.completionReceiptId, observedAt: result.observedAt, mergedAt: result.mergedAt, retryAt: result.retryAt ?? result.blocker?.retryAt ?? null, ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}) };
    },
    async planMergeConflict(input: WorkflowMergeConflictPlanActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input);
      const rawInput: MergeConflictPlanActivityInput = { ...input, worktreePath };
      const result = await invokeAgent(input, () => agent?.planMergeConflict ? agent.planMergeConflict(rawInput) : defaultAgent.planMergeConflict(rawInput, agentRuntime()), input.executionRole ?? "integrator");
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.leadExecutionId, sessionRef: result.leadSessionRef, worktreePath }, result);
    },
    async resolveMergeConflict(input: WorkflowMergeConflictResolutionActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.developerExecutionId);
      const rawInput: MergeConflictResolutionActivityInput = { ...input, worktreePath };
      const operation = developer.runMergeConflictResolution ? developer.runMergeConflictResolution.bind(developer) : defaultDeveloper.runMergeConflictResolution.bind(defaultDeveloper);
      const result = await invokeAgent(input, () => operation(rawInput), "integrator");
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath }, { ...result, worktreePath });
    },
    async resolveMergeConflictSupervised(input) {
      const workflowResult = (raw: unknown): MergeConflictResolutionActivityResult => raw as MergeConflictResolutionActivityResult;
      return invokeAgent(input, () => runSupervised<MergeConflictResolutionActivityResult>(input, "merge-conflict-resolution", async (service, execution) => {
        const worktreePath = input.worktreePath ?? latestWorktree(input, input.developerExecutionId);
        return workflowResult(await service.runMergeConflictResolution({ ...input, worktreePath, signal: execution.signal }));
      }), "integrator");
    },
  };
}
