import {
  ArtifactPointerSchema,
  IssueBlockerSchema,
  IssueWorkflowStateSchema,
  type ArtifactPointer,
  type DeliveryReviewActivityResult,
  type DeliveryWorkflowBlockCode,
  type DeveloperRepairActivityResult,
  type IssueBlocker,
  type IssueBlockerAction,
  type IssueWorkflowState,
} from "../issue-contracts.js";
import type { CapacityRole } from "../../capacity-contracts.js";
import { at } from "../../issue-phases.js";
import type { IssueWorkflowContext } from "./context.js";

type CompletedReview = Extract<DeliveryReviewActivityResult, { outcome: "completed" }>;
type CompletedRepair = Omit<Extract<DeveloperRepairActivityResult, { outcome: "completed" }>, "worktreePath"> & { worktreePath?: string };
type BlockedRepair = Omit<Extract<DeveloperRepairActivityResult, { outcome: "blocked" }>, "worktreePath">;

export function repairSignature(input: { source: "local_check" | "ci" | "merge" | "review"; code: string | null; failingCommand?: string | null; firstFailingLine?: string | null }): string {
  return [input.source, input.code ?? "", input.failingCommand ?? "", input.firstFailingLine ?? ""].join("|");
}

export function noProgress(previous: IssueWorkflowState["repairProgress"] | undefined, next: { signature: string; commit: string | null; diagnosticHash: string | null }): boolean {
  return !!previous && previous.signature === next.signature && previous.commit === next.commit && previous.diagnosticHash === next.diagnosticHash;
}

export function withRepairProgress(state: IssueWorkflowState, next: { signature: string; commit: string | null; diagnosticHash: string | null }): IssueWorkflowState {
  const repeated = noProgress(state.repairProgress, next);
  return IssueWorkflowStateSchema.parse({ ...state, repairProgress: { ...next, repeats: repeated ? (state.repairProgress?.repeats ?? 0) + 1 : 0 } });
}

export function evidencePointer(artifactId: string | undefined, kind: ArtifactPointer["kind"]): ArtifactPointer | undefined {
  const pointer = artifactId ? { artifactId, kind } : undefined;
  return pointer && ArtifactPointerSchema.safeParse(pointer).success ? pointer : undefined;
}

export function humanBlocker(category: IssueBlocker["category"], summary: string, actions: IssueBlockerAction[], evidence: ArtifactPointer | undefined): IssueBlocker {
  return IssueBlockerSchema.parse({ category, summary: summary.replace(/[\r\n]+/g, " ").slice(0, 240), unblockOwner: "human", actions, evidence: evidence ?? { artifactId: "blocker", kind: "attention-evidence" }, createdAt: new Date().toISOString(), retry: null });
}

export function revisioned(state: IssueWorkflowState, step: IssueWorkflowState["step"], owner: IssueWorkflowState["owner"], allowedCommands: IssueWorkflowState["allowedCommands"], pendingAction: string): IssueWorkflowState {
  const revision = state.revision + 1;
  return IssueWorkflowStateSchema.parse({ ...state, revision, ...at(step), owner, allowedCommands, pendingAction, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${revision}` });
}

export function withWorktreeCommands(state: IssueWorkflowState): IssueWorkflowState {
  const terminal = state.phase === "done" || state.phase === "cancelled";
  const noActiveOperation = state.activeOperation === null || state.activeOperation === undefined;
  const canDelete = noActiveOperation && state.worktreeState !== "cleaned" && (Boolean(state.worktreePath) || (terminal && Boolean(state.branchName)));
  const canRecreate = !terminal && (state.worktreeState === "cleaned" || state.worktreeState === "removed_externally");
  const canSyncBase = noActiveOperation && Boolean(state.branchName && state.developerExecutionId && state.targetBaseSha && state.resultCommit && state.resultTree);
  const allowedCommands = [
    ...state.allowedCommands,
    ...(canDelete && !state.allowedCommands.includes("delete_worktree") ? ["delete_worktree" as const] : []),
    ...(canRecreate && !state.allowedCommands.includes("recreate_worktree") ? ["recreate_worktree" as const] : []),
    ...(canSyncBase && !state.allowedCommands.includes("retry_target_base_reconciliation") ? ["retry_target_base_reconciliation" as const] : []),
  ];
  return allowedCommands.length === state.allowedCommands.length ? state : IssueWorkflowStateSchema.parse({ ...state, allowedCommands });
}

export function freshDeliveryLineage(): Pick<IssueWorkflowState, "deliveryReviewSupersedesId" | "deliveryRepairAttemptId" | "repairCycle" | "deliveryReviewId" | "deliveryReviewOutcome" | "deliveryReviewSummary" | "deliveryBlockingFindings" | "deliveryRepairPlan" | "deliveryRepairPlanArtifactId" | "deliveryRepairAuthority"> {
  return {
    deliveryReviewSupersedesId: null,
    deliveryRepairAttemptId: null,
    repairCycle: 0,
    deliveryReviewId: null,
    deliveryReviewOutcome: null,
    deliveryReviewSummary: null,
    deliveryBlockingFindings: [],
    deliveryRepairPlan: null,
    deliveryRepairPlanArtifactId: null,
    deliveryRepairAuthority: null,
  };
}

export function reviewingDeliveryState(state: IssueWorkflowState): IssueWorkflowState {
  return revisioned(state, "reviewing_delivery", "lead", [], "The Planner reviews the delivery");
}

export function reviewBlockedState(state: IssueWorkflowState, result: { attemptId: string | null; code: DeliveryWorkflowBlockCode; summary: string; evidenceArtifactId: string | null }, _infrastructure = false): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, "delivery_ready", "human", ["review_delivery", "cancel_issue"], result.summary),
    blocker: humanBlocker("agent_exhausted", result.summary, [{ command: "review_delivery", label: "Retry the delivery review", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(result.evidenceArtifactId ?? undefined, "delivery-review")),
    deliveryReviewAttemptId: result.attemptId,
    deliveryReviewId: null,
    deliveryReviewOutcome: null,
    deliveryReviewSummary: null,
    deliveryBlockingFindings: [],
    deliveryRepairPlan: null,
    deliveryReviewBlockerCode: result.code,
    deliveryReviewBlockerSummary: result.summary,
    deliveryReviewBlockerEvidenceArtifactId: result.evidenceArtifactId,
  });
}

export function repairRequiredState(state: IssueWorkflowState, result: CompletedReview, repairCycleLimit: number, noProgressEnabled = false): IssueWorkflowState {
  const openBlocking = result.review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
  const firstFinding = openBlocking[0];
  const progress = withRepairProgress(state, { signature: repairSignature({ source: "review", code: firstFinding ? `${firstFinding.findingId}:${firstFinding.rationale}` : null }), commit: state.resultCommit ?? null, diagnosticHash: result.review.reviewArtifact?.artifactId ?? null });
  const exhausted = result.review.opinion !== "approved" && noProgressEnabled && noProgress(state.repairProgress, progress.repairProgress!);
  const canRepair = !exhausted && result.review.opinion === "blocking" && openBlocking.length > 0 && (state.repairCycle ?? 0) < repairCycleLimit;
  const step = result.review.opinion === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "development";
  const owner = step === "repair_required" ? "lead" : "human";
  const allowedCommands: IssueWorkflowState["allowedCommands"] = step === "repair_required" ? ["record_delivery_decision", "repair_delivery", "cancel_issue"] : exhausted ? ["retry_development", "cancel_issue"] : step === "development" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"];
  const pendingAction = step === "repair_required" ? "The Builder fixes the review findings" : step === "development" && !exhausted ? "The review problems are not fixed" : step === "development" ? "Your decision is necessary" : "Forge opens the pull request";
  const repairLimitSummary = `The review found ${openBlocking.length} blocking problem${openBlocking.length === 1 ? "" : "s"}. The Builder made ${state.repairCycle ?? 0} repair attempt${(state.repairCycle ?? 0) === 1 ? "" : "s"} and did not fix them. Read the review findings. Then accept the delivery as is, or cancel the task.`;
  return IssueWorkflowStateSchema.parse({
    ...revisioned(progress, step, owner, allowedCommands, pendingAction),
    blocker: exhausted ? humanBlocker("agent_exhausted", `Automatic repair does not make progress: ${result.review.summary}`, [{ command: "retry_development", label: "Resume the Builder turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(result.review.reviewArtifact?.artifactId ?? result.review.evidenceArtifactId, "delivery-review")) : step === "development" ? humanBlocker("agent_exhausted", repairLimitSummary, [{ command: "record_delivery_decision", label: "Accept as is and publish", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(result.review.reviewArtifact?.artifactId ?? result.review.evidenceArtifactId, "delivery-review")) : null,
    deliveryReviewId: result.review.reviewId,
    deliveryReviewAttemptId: result.attemptId,
    deliveryReviewOutcome: result.review.opinion,
    deliveryReviewSummary: result.review.summary,
    deliveryBlockingFindings: openBlocking,
    deliveryReviewBlockerCode: null,
    deliveryReviewBlockerSummary: null,
    deliveryReviewBlockerEvidenceArtifactId: null,
    deliveryReviewSupersedesId: result.review.supersedesReviewId,
    deliveryReviewArtifact: result.review.reviewArtifact,
    repairCycle: state.repairCycle ?? 0,
  });
}

export function repairBlockedState(state: IssueWorkflowState, result: BlockedRepair, repairCycleLimit: number, noProgressEnabled = false): IssueWorkflowState {
  const verificationIncomplete = result.code === "repair-incomplete" || result.code === "repair-scope";
  if (verificationIncomplete) {
    return IssueWorkflowStateSchema.parse({
      ...revisioned(state, "delivery_ready", "human", ["repair_delivery", "review_delivery", "cancel_issue"], "The verification is not complete"),
      blocker: null,
      repairCycle: result.cycle,
      deliveryRepairAttemptId: result.repairAttemptId,
      deliveryRepairBlockerCode: result.code,
      deliveryRepairBlockerSummary: result.summary,
      deliveryRepairBlockerEvidenceArtifactId: result.evidenceArtifactId,
    });
  }
  const progressState = withRepairProgress(state, { signature: repairSignature({ source: "local_check", code: result.code }), commit: state.resultCommit ?? null, diagnosticHash: result.evidenceArtifactId ?? null });
  const exhausted = noProgressEnabled ? (progressState.repairProgress?.repeats ?? 0) >= 1 : result.cycle > repairCycleLimit;
  const retry = !exhausted;
  return IssueWorkflowStateSchema.parse({
    ...revisioned(progressState, "development", "human", retry ? ["record_delivery_decision", "repair_delivery", "retry_development", "cancel_issue"] : ["retry_development", "cancel_issue"], retry ? result.summary : "Your decision is necessary"),
    blocker: humanBlocker(retry ? "unsafe_recovery" : "agent_exhausted", retry ? result.summary : `Automatic repair does not make progress: ${result.summary}`, retry ? [{ command: "record_delivery_decision", label: "Accept as is and publish", requiresNote: true, destructive: false }, { command: "repair_delivery", label: "Send back to the Builder", requiresNote: false, destructive: false }, { command: "retry_development", label: "Retry the build", requiresNote: false, destructive: false }] : [{ command: "retry_development", label: "Resume the Builder turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(result.evidenceArtifactId, "developer-repair")),
    repairCycle: result.cycle,
    deliveryRepairAttemptId: result.repairAttemptId,
    deliveryRepairBlockerCode: result.code,
    deliveryRepairBlockerSummary: result.summary,
    deliveryRepairBlockerEvidenceArtifactId: result.evidenceArtifactId,
  });
}

export function repairInfrastructureBlockedState(state: IssueWorkflowState, cycle: number, repairCycleLimit: number, evidenceArtifactId: string | null, summary = "The repair did not complete. Retry the repair.", noProgressEnabled = false): IssueWorkflowState {
  const progressState = withRepairProgress(state, { signature: repairSignature({ source: "local_check", code: "repair-infrastructure-failure" }), commit: state.resultCommit ?? null, diagnosticHash: evidenceArtifactId });
  const retry = noProgressEnabled ? (progressState.repairProgress?.repeats ?? 0) < 1 : cycle < repairCycleLimit;
  return IssueWorkflowStateSchema.parse({
    ...revisioned(progressState, "development", "human", retry ? ["repair_delivery", "cancel_issue"] : ["retry_development", "cancel_issue"], retry ? summary : "Your decision is necessary"),
    blocker: humanBlocker(retry ? "provider_connectivity_exhausted" : "agent_exhausted", retry ? summary : `Automatic repair does not make progress: ${summary}`, retry ? [{ command: "repair_delivery", label: "Send back to the Builder", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }] : [{ command: "retry_development", label: "Resume the Builder turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(evidenceArtifactId ?? undefined, "developer-repair")),
    repairCycle: cycle,
    deliveryRepairBlockerCode: "repair-infrastructure-failure",
    deliveryRepairBlockerSummary: summary,
    deliveryRepairBlockerEvidenceArtifactId: evidenceArtifactId,
  });
}

export function transientRetryState(state: IssueWorkflowState, command: IssueWorkflowState["allowedCommands"][number], summary: string): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, state.step, "lead", [command, "cancel_issue"], "Retrying after a temporary failure"),
    blocker: null,
    deliveryRepairBlockerSummary: summary,
  });
}

export function credentialBlockedState(state: IssueWorkflowState, command: IssueWorkflowState["allowedCommands"][number], evidence: ArtifactPointer | undefined): IssueWorkflowState {
  const summary = "GitHub sign-in is necessary to continue.";
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, state.step, "human", [command, "cancel_issue"], summary),
    blocker: humanBlocker("provider_authentication", summary, [{ command, label: "Sign in to GitHub and retry", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidence),
  });
}

export function repairedDeliveryAwaitingFreshReviewState(state: IssueWorkflowState, result: CompletedRepair): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, "delivery_ready", "lead", ["review_delivery", "cancel_issue"], "A new delivery review is necessary"),
    developerExecutionId: result.developerExecutionId,
    developerSessionRef: result.developerSessionRef,
    worktreePath: result.worktreePath ?? state.worktreePath,
    branchName: result.branchName,
    targetBaseSha: result.subject.targetBaseSha,
    resultCommit: result.resultCommit,
    resultTree: result.resultTree,
    dirtyState: result.dirtyState,
    deliveryArtifactId: result.deliveryArtifactId,
    developerEvidenceArtifactId: result.evidenceArtifactId,
    deliverySummary: result.summary,
    developerOutcome: "completed",
    repairCycle: result.cycle,
    deliveryRepairAttemptId: result.repairAttemptId,
    deliveryRepairBlockerCode: null,
    deliveryRepairBlockerSummary: null,
    deliveryRepairBlockerEvidenceArtifactId: null,
    deliveryReviewSupersedesId: state.deliveryReviewId,
    deliveryReviewId: null,
    deliveryReviewOutcome: null,
    deliveryReviewSummary: null,
    deliveryBlockingFindings: [],
    deliveryReviewBlockerCode: null,
    deliveryReviewBlockerSummary: null,
    deliveryReviewBlockerEvidenceArtifactId: null,
    releaseId: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    expectedHeadSha: null,
    expectedHeadTree: null,
    ciRunId: null,
    ciAttempt: 0,
    ciOutcome: null,
    ciNextPollAt: null,
    finalReviewId: null,
    finalReviewOutcome: null,
    acceptanceId: null,
    acceptedHeadSha: null,
    mergeOutcome: null,
  });
}

export function reviewApprovedState(state: IssueWorkflowState, result: CompletedReview): IssueWorkflowState {
  return repairRequiredState(state, result, state.repairCycle ?? 0);
}

// The Integrator owns getting the Builder's branch merged: publish, CI repair, and merge
// conflicts. Gated so replayed histories keep their original role/profile.
export function integratorTurn(ctx: IssueWorkflowContext, legacyRole: "planner" | "builder"): { role: CapacityRole; profileId: string | undefined } {
  return { role: "integrator", profileId: ctx.input.roleProfiles.integrator ?? ctx.input.roleProfiles[legacyRole] };
}

export function finalReviewerTurn(ctx: IssueWorkflowContext): { role: CapacityRole; profileId: string | undefined } {
  return ctx.input.roleProfiles.reviewer
    ? { role: "reviewer", profileId: ctx.input.roleProfiles.reviewer }
    : { role: "planner", profileId: ctx.input.roleProfiles.planner };
}
