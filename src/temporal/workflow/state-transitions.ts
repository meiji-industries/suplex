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

export function humanBlocker(category: IssueBlocker["category"], summary: string, actions: IssueBlockerAction[], evidence: ArtifactPointer | undefined): IssueBlocker | null {
  if (!evidence) return null;
  return IssueBlockerSchema.parse({ category, summary: summary.replace(/[\r\n]+/g, " ").slice(0, 240), unblockOwner: "human", actions, evidence, createdAt: new Date().toISOString(), retry: null });
}

export function revisioned(state: IssueWorkflowState, phase: IssueWorkflowState["phase"], owner: IssueWorkflowState["owner"], allowedCommands: IssueWorkflowState["allowedCommands"], pendingAction: string): IssueWorkflowState {
  const revision = state.revision + 1;
  return IssueWorkflowStateSchema.parse({ ...state, revision, phase, owner, allowedCommands, pendingAction, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${revision}` });
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
  return revisioned(state, "reviewing_delivery", "lead", [], "Lead delivery review");
}

export function reviewBlockedState(state: IssueWorkflowState, result: { attemptId: string | null; code: DeliveryWorkflowBlockCode; summary: string; evidenceArtifactId: string | null }, infrastructure = false): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, "delivery_blocked", "human", ["review_delivery", "cancel_issue"], infrastructure ? "Delivery review infrastructure failed; retry the review" : "Delivery review blocked; retry the review or cancel"),
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

export function repairRequiredState(state: IssueWorkflowState, result: CompletedReview, repairCycleLimit: number): IssueWorkflowState {
  const openBlocking = result.review.findings.filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
  const canRepair = result.review.opinion === "blocking" && openBlocking.length > 0 && (state.repairCycle ?? 0) < repairCycleLimit;
  const phase = result.review.opinion === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "delivery_blocked";
  const owner = phase === "repair_required" ? "lead" : "human";
  const allowedCommands: IssueWorkflowState["allowedCommands"] = phase === "repair_required" ? ["record_delivery_decision", "repair_delivery", "cancel_issue"] : phase === "delivery_blocked" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"];
  const pendingAction = phase === "repair_required" ? "Builder is fixing review findings" : phase === "delivery_blocked" ? "Needs your call" : "Opening the pull request";
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, phase, owner, allowedCommands, pendingAction),
    blocker: phase === "delivery_blocked" ? humanBlocker("agent_exhausted", result.review.summary, [{ command: "record_delivery_decision", label: "Continue anyway", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], result.review.reviewArtifact ? evidencePointer(result.review.reviewArtifact.artifactId, "delivery-review") : undefined) : null,
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
  const progressState = withRepairProgress(state, { signature: repairSignature({ source: "local_check", code: result.code }), commit: state.resultCommit ?? null, diagnosticHash: result.evidenceArtifactId ?? null });
  const exhausted = noProgressEnabled ? (progressState.repairProgress?.repeats ?? 0) >= 1 : result.cycle > repairCycleLimit;
  const retry = !exhausted;
  return IssueWorkflowStateSchema.parse({
    ...revisioned(progressState, "delivery_blocked", "human", retry ? ["record_delivery_decision", "repair_delivery", "retry_development", "cancel_issue"] : ["retry_development", "cancel_issue"], retry ? result.summary : "Needs your call"),
    blocker: retry ? null : humanBlocker("agent_exhausted", `Automatic repair is not making progress: ${result.summary}`, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.evidenceArtifactId, "developer-repair")),
    repairCycle: result.cycle,
    deliveryRepairAttemptId: result.repairAttemptId,
    deliveryRepairBlockerCode: result.code,
    deliveryRepairBlockerSummary: result.summary,
    deliveryRepairBlockerEvidenceArtifactId: result.evidenceArtifactId,
  });
}

export function repairInfrastructureBlockedState(state: IssueWorkflowState, cycle: number, repairCycleLimit: number, evidenceArtifactId: string | null, summary = "The repair infrastructure did not complete; retry the repair.", noProgressEnabled = false): IssueWorkflowState {
  const progressState = withRepairProgress(state, { signature: repairSignature({ source: "local_check", code: "repair-infrastructure-failure" }), commit: state.resultCommit ?? null, diagnosticHash: evidenceArtifactId });
  const retry = noProgressEnabled ? (progressState.repairProgress?.repeats ?? 0) < 1 : cycle < repairCycleLimit;
  return IssueWorkflowStateSchema.parse({
    ...revisioned(progressState, "delivery_blocked", "human", retry ? ["repair_delivery", "cancel_issue"] : ["retry_development", "cancel_issue"], retry ? summary : "Needs your call"),
    blocker: retry ? null : humanBlocker("agent_exhausted", `Automatic repair is not making progress: ${summary}`, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(evidenceArtifactId ?? undefined, "developer-repair")),
    repairCycle: cycle,
    deliveryRepairBlockerCode: "repair-infrastructure-failure",
    deliveryRepairBlockerSummary: summary,
    deliveryRepairBlockerEvidenceArtifactId: evidenceArtifactId,
  });
}

export function repairedDeliveryAwaitingFreshReviewState(state: IssueWorkflowState, result: CompletedRepair): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, "delivery_ready", "lead", ["review_delivery", "cancel_issue"], "Fresh Lead delivery review required"),
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
export const optionalRolesPatch = "forge-optional-roles-v1";
export function integratorTurn(ctx: IssueWorkflowContext, legacyRole: "planner" | "builder"): { role: CapacityRole; profileId: string | undefined } {
  if (!ctx.patched(optionalRolesPatch)) return { role: legacyRole, profileId: ctx.input.roleProfiles[legacyRole] };
  return { role: "integrator", profileId: ctx.input.roleProfiles.integrator ?? ctx.input.roleProfiles[legacyRole] };
}

export function finalReviewerTurn(ctx: IssueWorkflowContext): { role: CapacityRole; profileId: string | undefined } {
  return ctx.input.roleProfiles.reviewer
    ? { role: "reviewer", profileId: ctx.input.roleProfiles.reviewer }
    : { role: "planner", profileId: ctx.input.roleProfiles.planner };
}
