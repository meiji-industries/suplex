import { at, isBlocked } from "../../issue-phases.js";
import { isCancellation, setHandler } from "../registry.js";
import { ApplicationFailure } from "../failures.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { issueUpdates } from "../issue-updates.js";
import { githubPullRequestObservationFields } from "../../github-pull-request-observation.js";
import type { IssueWorkflowContext } from "./context.js";
import { GithubReleaseFailure } from "../../github-release.js";
import { resumeReviewedDeliveryTarget } from "./register-delivery-review.js";
import { ReleaseFailureCodeSchema } from "../../release-failures.js";

function githubPullRequestLifecycleFields(
  observed: contracts.GithubPullRequestObservationResult,
  observedAt: string,
) {
  const lifecycle = githubPullRequestObservationFields(observed, observedAt);
  Reflect.deleteProperty(lifecycle, "expectedHeadSha");
  Reflect.deleteProperty(lifecycle, "targetBaseSha");
  return lifecycle;
}

export function registerReleaseHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  const blockDelivery = async (failure: GithubReleaseFailure): Promise<contracts.IssueWorkflowState> => {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "human", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: failure.summary, releaseFailureSummary: failure.summary, releaseRetryAt: failure.retryAt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  const runPublishTurn = async (): Promise<contracts.IssueWorkflowState> => {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("releasing"), owner: "lead", allowedCommands: [], pendingAction: "Forge opens the pull request", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    if (!ctx.state.deliveryReviewId || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree) return blockDelivery(new GithubReleaseFailure("stale-reviewed-revision", "Approved exact delivery is required before publishing"));
    if (!true && !(await ctx.runTargetBaseCheckpoint("pre_release"))) return ctx.state;
    // Publication always starts by making the exact reviewed branch observable
    // on GitHub. This patch preserves histories created before the extra
    // activity existed; new histories record it before PR creation.
    if (true) {
      try {
        await activityProxies.pushDeliveryBranch({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName, commitSha: ctx.state.resultCommit });
      } catch (error) {
        if (isCancellation(error)) throw error;
        const failure = ctx.permanentActivityFailure(error);
        const code = ReleaseFailureCodeSchema.safeParse(failure?.code);
        const releaseFailure = code.success ? new GithubReleaseFailure(code.data, failure?.summary ?? "The reviewed branch is unavailable for pushing") : null;
        return blockDelivery(releaseFailure ?? new GithubReleaseFailure("provider-unavailable", failure?.summary ?? "The reviewed branch is unavailable for pushing"));
      }
    }
    const typedReleaseResult = true;
    const publishInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, reviewId: ctx.state.deliveryReviewId, developerExecutionId: ctx.state.developerExecutionId!, branchName: ctx.state.branchName, targetBaseSha: ctx.state.targetBaseSha, subjectCommit: ctx.state.resultCommit, subjectTree: ctx.state.resultTree, pullRequestMode: ctx.input.pullRequestMode ?? "draft", ...(ctx.state.releaseId ? { releaseId: ctx.state.releaseId } : {}) };
    const rawResult = await activityProxies.publishRelease((typedReleaseResult ? publishInput : { ...publishInput, planSummary: ctx.state.leadSummary ?? "Approved Forge plan", deliverySummary: ctx.state.deliverySummary ?? "Exact Developer delivery", verificationSummary: "The delivery review approved", ...(ctx.state.pullRequestNumber ? { expectedPullRequestNumber: ctx.state.pullRequestNumber } : {}) }) as contracts.PublishReleaseActivityInput);
    let result: contracts.PublishReleaseActivityResult = rawResult;
    if (!typedReleaseResult) {
      const legacy = rawResult as unknown as Omit<contracts.PublishReleaseActivityResult, "outcome" | "attempt"> & { baseDriftMerged?: boolean; baseDriftConflict?: boolean };
      result = { ...legacy, outcome: legacy.baseDriftConflict ? "base-drift-conflict" : legacy.baseDriftMerged ? "base-drift-merged" : "completed", attempt: 0 } as contracts.PublishReleaseActivityResult;
    }
    if (result.outcome === "blocked") {
      if (result.code === "target-base-drift") {
        const summary = "The base branch moved. Forge updates it before the publish.";
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "lead", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: summary, blocker: stateTransitions.humanBlocker("provider_connectivity_exhausted", summary, [{ command: "retry_target_base_reconciliation", label: "Retry the base update", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(ctx.state.deliveryReviewArtifact?.artifactId ?? ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence")), targetBaseCheckpoint: "pre_release", targetBaseOutcome: "blocked", targetBaseBlockerCode: "base_advanced_again", targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, releaseFailureSummary: result.summary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      if (result.code === "stale-reviewed-revision") {
        const reviewedCommitChanged = result.headSha.toLowerCase() !== ctx.state.resultCommit?.toLowerCase();
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: reviewedCommitChanged ? "The Planner reviews the latest changes" : result.summary, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseFailureSummary: result.summary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      const waitingForRateLimit = result.code === "provider-rate-limited" && result.retryAt !== null;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("releasing"), owner: waitingForRateLimit ? "lead" : "human", allowedCommands: waitingForRateLimit ? ["cancel_issue"] : ["publish_draft", "cancel_issue"], pendingAction: waitingForRateLimit ? "Forge waits for GitHub" : result.summary ?? "Retry GitHub", releaseFailureSummary: result.summary ?? "Retry GitHub", releaseRetryAt: result.retryAt ?? null, releaseOperationAttempt: result.attempt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (!true && result.outcome === "base-drift-conflict") {
      const legacyConflict = !true;
      if (!legacyConflict && !result.mergeConflictEvidence) throw ApplicationFailure.nonRetryable("Merge-conflict evidence is missing", "merge_conflict_evidence_missing");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_reviewing"), owner: "lead", allowedCommands: [], pendingAction: "The Planner plans the conflict resolution", targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, forwardMergeId: result.forwardMergeId ?? null, forwardMergePriorHead: result.priorHead ?? ctx.state.resultCommit, forwardMergePriorTree: result.priorTree ?? ctx.state.resultTree, forwardMergeTargetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, ...(result.conflictArtifact ? { forwardMergeConflictArtifact: result.conflictArtifact } : {}), ...(result.conflictFileCount ? { forwardMergeConflictFileCount: result.conflictFileCount } : {}), ...(result.mergeConflictEvidence ? { mergeConflictEvidence: result.mergeConflictEvidence } : {}), ...(legacyConflict ? { forwardMergeConflictFiles: result.conflictFiles ?? [], forwardMergeConflictDiff: result.conflictDiff ?? null } : {}), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
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
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "The Builder waits for the Planner conflict plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      } catch (error) {
        if (isCancellation(error)) throw error;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "The Planner did not plan the fix. Retry, or inspect the task.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      if (legacyConflict) ctx.continuationRequested = true;
      await ctx.project();
      return ctx.state;
    }
    if (!true && result.outcome === "base-drift-merged") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["review_delivery"]), pendingAction: "The Planner reviews again after the base update", targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (result.outcome !== "completed" || !result.releaseId || result.pullRequestNumber === null || result.pullRequestUrl === null) throw new Error("Release completion result is incomplete");
    if (ctx.input.deliveryTarget === "pull_request_draft" || ctx.input.deliveryTarget === "pull_request_ready") {
      const ready = ctx.input.deliveryTarget === "pull_request_ready";
      const observed = true ? await activityProxies.observeGithubPullRequest({ repository: result.repository, branch: result.branchName, pullRequestNumber: result.pullRequestNumber }) : null;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...(observed ? githubPullRequestLifecycleFields(observed, new Date().toISOString()) : {}), revision: ctx.state.revision + 1, ...at("done"), owner: "human", allowedCommands: [], pendingAction: ready ? `Done. Pull request #${result.pullRequestNumber} is ready for review.` : `Done. Draft pull request #${result.pullRequestNumber} opened.`, releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const adoptedHead = true ? { targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree } : {};
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...adoptedHead, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge waits for CI", releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, ciAttempt: 0, ciNextPollAt: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  setHandler(issueUpdates.publish_draft, ctx.guarded(async (rawInput: any) => {
    contracts.StartPlanningInputSchema.parse(rawInput);
    if (ctx.state.step === "delivery_reviewed" && (ctx.input.deliveryTarget === "remote_branch" || ctx.input.deliveryTarget === "local_worktree")) return resumeReviewedDeliveryTarget(ctx);
    return runPublishTurn();
  }), { validator(rawInput) { const command = contracts.StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision"); if (!(ctx.state.step === "delivery_reviewed" || (isBlocked(ctx.state) && stateTransitions.blockerOffers(ctx.state, "publish_draft"))) || !ctx.state.deliveryReviewId) throw new Error("Draft publication is not available in the current phase"); } });

  ctx.runPublishTurn = runPublishTurn;
}
