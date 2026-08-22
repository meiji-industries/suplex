import { ApplicationFailure, setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import * as activityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import * as releaseFailures from "../../release-failures.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerReleaseHandlers(ctx: IssueWorkflowContext): void {
  const runPublishTurn = async (): Promise<contracts.IssueWorkflowState> => {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "releasing", owner: "lead", allowedCommands: [], pendingAction: "Opening the pull request", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    if (!ctx.state.deliveryReviewId || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree) throw new Error("Approved exact delivery is required before publishing");
    if (!ctx.patched("forge-kodiak-merge-v1") && !(await ctx.runTargetBaseCheckpoint("pre_release"))) return ctx.state;
    const typedReleaseResult = ctx.patched(ctx.typedReleaseResultPatch);
    const publishInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, reviewId: ctx.state.deliveryReviewId, developerExecutionId: ctx.state.developerExecutionId!, branchName: ctx.state.branchName, targetBaseSha: ctx.state.targetBaseSha, subjectCommit: ctx.state.resultCommit, subjectTree: ctx.state.resultTree, pullRequestMode: ctx.input.pullRequestMode ?? "draft", ...(ctx.state.releaseId ? { releaseId: ctx.state.releaseId } : {}) };
    const rawResult = await activityProxies.publishRelease((typedReleaseResult ? publishInput : { ...publishInput, planSummary: ctx.state.leadSummary ?? "Approved Forge plan", deliverySummary: ctx.state.deliverySummary ?? "Exact Developer delivery", verificationSummary: "Lead delivery review approved", ...(ctx.state.pullRequestNumber ? { expectedPullRequestNumber: ctx.state.pullRequestNumber } : {}) }) as contracts.PublishReleaseActivityInput);
    let result: contracts.PublishReleaseActivityResult = rawResult;
    if (!typedReleaseResult) {
      const legacy = rawResult as unknown as Omit<contracts.PublishReleaseActivityResult, "outcome" | "attempt"> & { baseDriftMerged?: boolean; baseDriftConflict?: boolean };
      result = { ...legacy, outcome: legacy.baseDriftConflict ? "base-drift-conflict" : legacy.baseDriftMerged ? "base-drift-merged" : "completed", attempt: 0 } as contracts.PublishReleaseActivityResult;
    }
    if (result.outcome === "blocked") {
      if (result.code === "stale-reviewed-revision") {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseStatus: "blocked", releaseFailureCode: result.code, releaseFailureSummary: result.summary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      const retryable = releaseFailures.isRetryableReleaseFailure(result.code);
      const waitingForRateLimit = result.code === "provider-rate-limited" && result.retryAt !== null;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: waitingForRateLimit ? "releasing" : "delivery_blocked", owner: waitingForRateLimit ? "lead" : "human", allowedCommands: waitingForRateLimit ? ["cancel_issue"] : [...(retryable ? ["publish_draft"] : []), "cancel_issue"], pendingAction: waitingForRateLimit ? "Waiting for GitHub" : result.summary ?? "GitHub needs a retry", releaseStatus: waitingForRateLimit ? "reconciling" : "blocked", releaseFailureCode: result.code ?? "provider-unavailable", releaseFailureSummary: result.summary ?? "GitHub needs a retry", releaseRetryAt: result.retryAt ?? null, releaseOperationAttempt: result.attempt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (!ctx.patched("forge-kodiak-merge-v1") && result.outcome === "base-drift-conflict") {
      const legacyConflict = !ctx.patched(ctx.artifactBackedConflictPatch);
      if (!legacyConflict && !result.mergeConflictEvidence) throw ApplicationFailure.nonRetryable("Merge-conflict evidence is missing", "merge_conflict_evidence_missing");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: [], pendingAction: "Lead conflict-resolution plan", targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, forwardMergeId: result.forwardMergeId ?? null, forwardMergePriorHead: result.priorHead ?? ctx.state.resultCommit, forwardMergePriorTree: result.priorTree ?? ctx.state.resultTree, forwardMergeTargetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, ...(result.conflictArtifact ? { forwardMergeConflictArtifact: result.conflictArtifact } : {}), ...(result.conflictFileCount ? { forwardMergeConflictFileCount: result.conflictFileCount } : {}), ...(result.mergeConflictEvidence ? { mergeConflictEvidence: result.mergeConflictEvidence } : {}), ...(legacyConflict ? { forwardMergeConflictFiles: result.conflictFiles ?? [], forwardMergeConflictDiff: result.conflictDiff ?? null } : {}), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      try {
        const plan = await ctx.acquireExternalTurn<contracts.MergeConflictPlanActivityResult>(
          { operation: "merge_conflict_plan", ...stateTransitions.integratorTurn(ctx, "planner"), sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => {
            const legacyPlanInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, executionRole: stateTransitions.integratorTurn(ctx, "planner").role === "integrator" ? "integrator" : "planner", leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, branchName: ctx.state.branchName!, priorHead: ctx.state.forwardMergePriorHead!, targetBaseSha: ctx.state.forwardMergeTargetBaseSha!, ...(ctx.state.mergeConflictEvidence ? { conflictEvidence: ctx.state.mergeConflictEvidence } : { conflictFiles: ctx.state.forwardMergeConflictFiles ?? [], conflictDiff: ctx.state.forwardMergeConflictDiff ?? "" }), ...(ctx.state.forwardMergeId ? { forwardMergeId: ctx.state.forwardMergeId } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) } as unknown as Parameters<typeof activityProxies.planMergeConflict>[0];
            return activityProxies.planMergeConflict(legacyPlanInput);
          },
          (result) => result.leadExecutionId,
        );
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      } catch {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Planner couldn't plan the fix — retry or take a look", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      if (legacyConflict) ctx.continuationRequested = true;
      await ctx.project();
      return ctx.state;
    }
    if (!ctx.patched("forge-kodiak-merge-v1") && result.outcome === "base-drift-merged") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ctx.addRevisionCommand(["review_delivery"]), pendingAction: "Re-reviewing after updating from main", targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (result.outcome !== "completed" || !result.releaseId || result.pullRequestNumber === null || result.pullRequestUrl === null) throw new Error("Release completion result is incomplete");
    if (ctx.input.deliveryTarget === "pull_request_draft" || ctx.input.deliveryTarget === "pull_request_ready") {
      const ready = ctx.input.deliveryTarget === "pull_request_ready";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "done", owner: "human", allowedCommands: [], pendingAction: ready ? "Done — pull request ready for review" : "Done — draft pull request created", releaseStatus: ready ? "ready" : "draft", releaseFailureCode: null, releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const adoptedHead = ctx.patched("forge-adopt-observed-head-v1") ? { targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree } : {};
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...adoptedHead, revision: ctx.state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Waiting for CI", releaseStatus: result.isDraft ? "draft" : "ready", releaseFailureCode: null, releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, ciAttempt: 0, ciOutcome: "waiting", ciNextPollAt: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  setHandler(issueUpdates.publish_draft, ctx.guarded(async (rawInput) => {
    contracts.StartPlanningInputSchema.parse(rawInput);
    return runPublishTurn();
  }), { validator(rawInput) { const command = contracts.StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision"); if (!(ctx.state.phase === "delivery_reviewed" || (ctx.state.phase === "delivery_blocked" && ctx.state.releaseStatus === "blocked" && ctx.state.allowedCommands.includes("publish_draft"))) || !ctx.state.deliveryReviewId) throw new Error("Draft publication is not available in the current phase"); } });

  ctx.runPublishTurn = runPublishTurn;
}
