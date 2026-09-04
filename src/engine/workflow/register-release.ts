import { at, isBlocked } from "../../issue-phases.js";
import { isCancellation, runExecution, setHandler } from "../registry.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { issueUpdates } from "../issue-updates.js";
import { githubPullRequestObservationFields } from "../../github-pull-request-observation.js";
import type { IssueWorkflowContext } from "./context.js";
import { GithubReleaseFailure } from "../../github-release.js";
import { resumeReviewedDeliveryTarget } from "./register-delivery-review.js";
import { ReleaseFailureCodeSchema, releaseFailureCopy } from "../../release-failures.js";

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
  const retryAt = (value: string | null): string => value ?? new Date(runExecution.current().now() + 60_000).toISOString();
  const blockDelivery = async (failure: GithubReleaseFailure): Promise<contracts.IssueWorkflowState> => {
    if (failure.code === "provider-unavailable" || failure.code === "provider-rate-limited") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("releasing"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge waits for GitHub", blocker: null, releaseFailureSummary: releaseFailureCopy[failure.code], releaseRetryAt: retryAt(failure.retryAt), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "human", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: releaseFailureCopy[failure.code], blocker: stateTransitions.humanBlocker("provider_connectivity_exhausted", releaseFailureCopy[failure.code], [{ command: "review_delivery", label: "Review the delivery", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(ctx.state.deliveryReviewArtifact?.artifactId ?? ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence")), releaseFailureSummary: releaseFailureCopy[failure.code], releaseRetryAt: failure.retryAt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  const runPublishTurn = async (): Promise<contracts.IssueWorkflowState> => {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("releasing"), owner: "lead", allowedCommands: [], pendingAction: "Forge opens the pull request", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    if (!ctx.state.deliveryReviewId || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree) return blockDelivery(new GithubReleaseFailure("stale-reviewed-revision", "Approved exact delivery is required before publishing"));
    try {
      await activityProxies.pushDeliveryBranch({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName, commitSha: ctx.state.resultCommit });
    } catch (error) {
      if (isCancellation(error)) throw error;
      const failure = ctx.permanentActivityFailure(error);
      const code = ReleaseFailureCodeSchema.safeParse(failure?.code);
      const releaseFailure = code.success ? new GithubReleaseFailure(code.data, failure?.summary ?? "The reviewed branch is unavailable for pushing") : null;
      return blockDelivery(releaseFailure ?? new GithubReleaseFailure("provider-unavailable", failure?.summary ?? "The reviewed branch is unavailable for pushing"));
    }
    const publishInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, reviewId: ctx.state.deliveryReviewId, developerExecutionId: ctx.state.developerExecutionId!, branchName: ctx.state.branchName, targetBaseSha: ctx.state.targetBaseSha, subjectCommit: ctx.state.resultCommit, subjectTree: ctx.state.resultTree, pullRequestMode: ctx.input.pullRequestMode ?? "draft", ...(ctx.state.releaseId ? { releaseId: ctx.state.releaseId } : {}) };
    const result = await activityProxies.publishRelease(publishInput);
    if (result.outcome === "blocked") {
      const releaseFailureCode = ReleaseFailureCodeSchema.safeParse(result.code);
      const releaseFailureSummary = releaseFailureCode.success ? releaseFailureCopy[releaseFailureCode.data] : result.summary;
      if (result.code === "target-base-drift") {
        const summary = "The base branch moved. Forge updates it before the publish.";
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "lead", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: summary, blocker: stateTransitions.humanBlocker("provider_connectivity_exhausted", summary, [{ command: "retry_target_base_reconciliation", label: "Retry the base update", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(ctx.state.deliveryReviewArtifact?.artifactId ?? ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence")), targetBaseCheckpoint: "pre_release", targetBaseOutcome: "blocked", targetBaseBlockerCode: "base_advanced_again", targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, releaseFailureSummary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      if (result.code === "stale-reviewed-revision") {
        const reviewedCommitChanged = result.headSha.toLowerCase() !== ctx.state.resultCommit.toLowerCase();
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: reviewedCommitChanged ? "The Planner reviews the latest changes" : releaseFailureSummary, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseFailureSummary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      const waitingForProvider = result.code === "provider-rate-limited" || result.code === "provider-unavailable";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("releasing"), owner: waitingForProvider ? "lead" : "human", allowedCommands: waitingForProvider ? ["cancel_issue"] : ["publish_draft", "cancel_issue"], pendingAction: waitingForProvider ? "Forge waits for GitHub" : releaseFailureSummary, releaseFailureSummary, releaseRetryAt: waitingForProvider ? retryAt(result.retryAt) : result.retryAt, releaseOperationAttempt: result.attempt, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (result.pullRequestUrl === null) throw new Error("Release completion result is incomplete");
    if (ctx.input.deliveryTarget === "pull_request_draft" || ctx.input.deliveryTarget === "pull_request_ready") {
      const ready = ctx.input.deliveryTarget === "pull_request_ready";
      const observed = await activityProxies.observeGithubPullRequest({ repository: result.repository, branch: result.branchName, pullRequestNumber: result.pullRequestNumber });
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...githubPullRequestLifecycleFields(observed, new Date().toISOString()), revision: ctx.state.revision + 1, ...at("done"), owner: "human", allowedCommands: [], pendingAction: ready ? `Done. Pull request #${result.pullRequestNumber} is ready for review.` : `Done. Draft pull request #${result.pullRequestNumber} opened.`, releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const adoptedHead = { targetBaseSha: result.targetBaseSha ?? ctx.state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree };
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
