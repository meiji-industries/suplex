import { IssueWorkflowStateSchema, type IssueWorkflowState, type ReconcileTargetBaseActivityResult } from "./issue-contracts.js";
import { at, isBlocked } from "../issue-phases.js";

export function applyTargetBaseNoDrift(state: IssueWorkflowState, result: Extract<ReconcileTargetBaseActivityResult, { outcome: "no_drift" }>): IssueWorkflowState {
  const requiresResume = isBlocked(state) || (result.checkpoint === "pre_release" && (state.step === "delivery_ready" || (state.step === "development" && Boolean(state.deliveryArtifactId))));
  const resumed = !requiresResume
    ? {}
    : result.checkpoint === "pre_release"
      ? state.deliveryReviewId
        ? { ...at("delivery_reviewed"), owner: "lead" as const, allowedCommands: ["publish_draft", "cancel_issue"] as const, pendingAction: "Publish one exact draft pull request" }
        : { ...at("delivery_ready"), owner: "lead" as const, allowedCommands: ["review_delivery", "cancel_issue"] as const, pendingAction: "Lead delivery review" }
      : result.checkpoint === "pre_final_review"
        ? { ...at("final_review"), owner: "lead" as const, allowedCommands: ["final_review", "cancel_issue"] as const, pendingAction: "Final Lead review" }
        : { ...at("accepted"), owner: "human" as const, allowedCommands: ["accept_delivery", "request_delivery_changes", "cancel_issue"] as const, pendingAction: "Member acceptance required" };
  const changed = requiresResume
    || state.targetBaseCheckId !== result.checkId
    || state.targetBaseCheckpoint !== result.checkpoint
    || state.targetBaseOutcome !== result.outcome;
  const revision = changed ? { revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` } : {};
  return IssueWorkflowStateSchema.parse({ ...state, ...resumed, ...revision, targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null });
}

export function applyTargetBaseRevalidation(
  state: IssueWorkflowState,
  result: Extract<ReconcileTargetBaseActivityResult, { outcome: "revalidated" }>,
): IssueWorkflowState {
  const published = Boolean(state.releaseId && state.pullRequestNumber && state.pullRequestUrl);
  return IssueWorkflowStateSchema.parse({
    ...state,
    ...at("delivery_ready"),
    owner: "lead",
    allowedCommands: ["review_delivery", "cancel_issue"],
    pendingAction: "Fresh Lead review required after target-base revalidation",
    revision: state.revision + 1,
    lastEventId: `${state.workflowId}:${state.revision + 1}`,
    targetBaseSha: result.observedBaseSha,
    targetBaseCheckId: result.checkId,
    targetBaseCheckpoint: result.checkpoint,
    targetBaseOutcome: result.outcome,
    targetBaseBlockerCode: null,
    targetBaseBlockerOwner: null,
    targetBaseBlockerRetryable: null,
    targetBaseBlockerSummary: null,
    forwardMergeId: result.checkId,
    forwardMergePriorHead: result.priorHead,
    forwardMergePriorTree: result.priorTree,
    forwardMergeTargetBaseSha: result.observedBaseSha,
    forwardMergeConflictArtifact: null,
    forwardMergeConflictFileCount: null,
    developerExecutionId: result.developerExecutionId,
    resultCommit: result.headSha,
    resultTree: result.headTree,
    dirtyState: "clean",
    deliveryArtifactId: result.deliveryArtifact.id,
    developerEvidenceArtifactId: result.developerEvidenceArtifactId ?? result.verificationArtifact.id,
    deliverySummary: "Forward-merge delivery revalidated",
    developerOutcome: "completed",
    deliveryReviewSupersedesId: null,
    repairCycle: 0,
    deliveryReviewId: null,
    deliveryReviewOutcome: null,
    deliveryReviewSummary: null,
    deliveryBlockingFindings: [],
    deliveryRepairPlan: null,
    deliveryDecisionArtifactId: null,
    releaseId: published ? state.releaseId : null,
    pullRequestNumber: published ? state.pullRequestNumber : null,
    pullRequestUrl: published ? state.pullRequestUrl : null,
    ciRunId: null,
    ciAttempt: 0,
    ciOutcome: null,
    ciNextPollAt: null,
    finalReviewId: null,
    finalReviewOutcome: null,
    acceptanceId: null,
    acceptedHeadSha: null,
    mergeOutcome: null,
    expectedHeadSha: result.headSha,
    expectedHeadTree: result.headTree,
  });
}
