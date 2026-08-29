import { IssueWorkflowStateSchema, type IssueWorkflowState, type ReconcileTargetBaseActivityResult } from "./issue-contracts.js";

export function applyTargetBaseNoDrift(state: IssueWorkflowState, result: Extract<ReconcileTargetBaseActivityResult, { outcome: "no_drift" }>): IssueWorkflowState {
  const resumed = state.phase !== "delivery_blocked"
    ? {}
    : result.checkpoint === "pre_release"
      ? { phase: "delivery_reviewed" as const, owner: "lead" as const, allowedCommands: ["publish_draft", "cancel_issue"] as const, pendingAction: "Publish one exact draft pull request" }
      : result.checkpoint === "pre_final_review"
        ? { phase: "final_review" as const, owner: "lead" as const, allowedCommands: ["final_review", "cancel_issue"] as const, pendingAction: "Final Lead review" }
        : { phase: "accepted" as const, owner: "human" as const, allowedCommands: ["accept_delivery", "request_delivery_changes", "cancel_issue"] as const, pendingAction: "Member acceptance required" };
  const resumedRevision = state.phase === "delivery_blocked" ? { revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` } : {};
  return IssueWorkflowStateSchema.parse({ ...state, ...resumed, ...resumedRevision, targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null });
}

export function applyTargetBaseRevalidation(
  state: IssueWorkflowState,
  result: Extract<ReconcileTargetBaseActivityResult, { outcome: "revalidated" }>,
): IssueWorkflowState {
  const published = Boolean(state.releaseId && state.pullRequestNumber && state.pullRequestUrl);
  return IssueWorkflowStateSchema.parse({
    ...state,
    phase: "delivery_ready",
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
