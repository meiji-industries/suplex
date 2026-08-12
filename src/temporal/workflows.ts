import { ActivityCancellationType } from "@temporalio/common";
import { ActivityFailure, allHandlersFinished, ApplicationFailure, condition, continueAsNew, defineQuery, defineUpdate, patched, proxyActivities, setHandler, sleep, workflowInfo } from "@temporalio/workflow";

import { ProbeWorkflowInputSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import {
  ArtifactPointerSchema,
  AttentionCategorySchema,
  ContinueWorkCommandSchema,
  buildInitialIssueWorkflowState,
  IssueProjectionEventSchema,
  IssueBlockerSchema,
  IssueWorkflowInputSchema,
  IssueWorkflowStateSchema,
  PlanCommandInputSchema,
  PlanRevisionCommandSchema,
  RecordProgressInputSchema,
  StartPlanningInputSchema,
  type AcceptDeliveryActivityInput,
  type ArtifactPointer,
  type ContinueWorkCommand,
  type CiRepairPlanActivityResult,
  type DeliveryBlockerActivities,
  type DeliveryRepairPlanResult,
  type DeliveryReviewActivityResult,
  type DeliveryWorkflowBlockCode,
  type DeveloperRepairActivityResult,
  type FinalReviewActivityResult,
  type IssueActivities,
  type IssueBlocker,
  type IssueBlockerAction,
  type IssueCommand,
  type IssueWorkflowInput,
  type IssueWorkflowState,
  type LegacyDeveloperRepairResult,
  type LeadPlanningResult,
  type MergeConflictPlanActivityResult,
  type PlanCommandInput,
  type PlanRevisionCommand,
  type PublishReleaseActivityInput,
  type PublishReleaseActivityResult,
  type RecordProgressInput,
  type ReconcileTargetBaseActivityResult,
  type StartPlanningInput,
  type SupplementalReviewResult,
  type TargetBaseCheckpoint,
  type WorkflowCiRepairActivityResult,
  type WorkflowDeliveryReviewResult,
  type WorkflowDeveloperExecutionResult,
  type WorkflowDeveloperRepairResult,
} from "./issue-contracts.js";
import { assertContinuationStateWithinLimit, assertPayloadWithinLimit, WORKFLOW_HISTORY_EVENT_LIMIT } from "./policy.js";
import { isRetryableReleaseFailure } from "../release-failures.js";
import { applyTargetBaseNoDrift, applyTargetBaseRevalidation } from "./target-base.js";
import { developerExecutionId } from "./deterministic-id.js";
import type { CapacityOperation, CapacityRole } from "../capacity-contracts.js";

const { recordProbeStarted } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
});

const { projectIssueState: projectIssueStateActivity } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});
async function projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState> {
  return projectIssueStateActivity(IssueProjectionEventSchema.parse({
    schemaVersion: 1,
    runId: workflowInfo().runId,
    eventId: state.lastEventId,
    state,
  }));
}

const EXTERNAL_AGENT_RETRY_POLICY = {
  maximumAttempts: 3,
  initialInterval: "1 second",
  maximumInterval: "30 seconds",
  nonRetryableErrorTypes: ["rate-limited"],
};
const { runLeadPlanning } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { runSupplementalReview, consolidateLeadPlan } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { runDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { runDeveloperExecutionSupervised, runDeveloperRepairSupervised, resolveMergeConflictSupervised } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 100, initialInterval: "1 second", maximumInterval: "30 seconds", nonRetryableErrorTypes: ["developer-ownership-ambiguous", "developer-result-claim-conflict"] },
});
const { cancelDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { findActiveDeveloperExecution } = proxyActivities<IssueActivities>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "5 seconds" } });
const { observeDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { cancelCapacityExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { recordPlanDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});
const { authorizePlanRevision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
});
const { preparePlanRevision } = proxyActivities<IssueActivities>({ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 1 } });
const { createSuccessor } = proxyActivities<IssueActivities>({ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "30 seconds" } });
const { reviewDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { recordDeliveryBlocker } = proxyActivities<DeliveryBlockerActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { runDeveloperRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { recordDeliveryDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});
const { publishRelease } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 5, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});
const { reconcileTargetBase } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});
const { planMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { resolveMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { reconcileCi } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});
const { planCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { runCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 1 },
});
const { finalReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const { planDeliveryRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});
const { acceptDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});
const { reconcileAcceptance } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});
const { reconcileMerge } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});
const { requestCapacity, tryAcquireCapacity, inspectCapacity, requeueCapacity, cancelCapacity, finalizeCapacity, rateLimitCapacity, reconcileCapacityOwnership } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "15 seconds" },
});

function isoEpochMillis(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146097 + dayOfEra - 719468;
  return days * 86_400_000 + Number(match[4]) * 3_600_000 + Number(match[5]) * 60_000 + Number(match[6]) * 1_000 + Number((match[7] ?? "").padEnd(3, "0") || 0);
}

const MAX_RECONCILIATION_ATTEMPTS = 20;

function sleepUntil(retryAt: string | null | undefined): Promise<void> {
  if (!retryAt) return sleep("1 second");
  return sleep(Math.max(1, Date.parse(retryAt) - Date.now()));
}

export const probeStateQuery = defineQuery<ProbeWorkflowState>("probeState");

export async function probeWorkflow(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
  const validatedInput = ProbeWorkflowInputSchema.parse(input);
  let state: ProbeWorkflowState = {
    workflowId: validatedInput.workflowId,
    probeId: validatedInput.probeId,
    companyId: validatedInput.companyId,
    status: "starting",
  };
  setHandler(probeStateQuery, () => state);
  state = await recordProbeStarted(validatedInput);
  await condition(() => false);
  return state;
}

export const issueStateQuery = defineQuery<IssueWorkflowState>("issueState");
export const startPlanningUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("startPlanning");
export const recordProgressUpdate = defineUpdate<IssueWorkflowState, [RecordProgressInput]>("recordProgress");
export const requestSupplementalReviewUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("requestSupplementalReview");
export const approvePlanUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("approvePlan");
export const rejectPlanUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("rejectPlan");
export const revisePlanUpdate = defineUpdate<IssueWorkflowState, [PlanRevisionCommand]>("revisePlan");
export const continueWorkUpdate = defineUpdate<IssueWorkflowState, [ContinueWorkCommand]>("continueWork");
export const startDevelopmentUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("startDevelopment");
export const retryDevelopmentUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryDevelopment");
export const cancelDevelopmentUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("cancelDevelopment");
export const verifyDeveloperOwnershipUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("verifyDeveloperOwnership");
export const reviewDeliveryUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reviewDelivery");
export const repairDeliveryUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("repairDelivery");
export const recordDeliveryDecisionUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("recordDeliveryDecision");
export const publishDraftUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("publishDraft");
export const resolveMergeConflictUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("resolveMergeConflict");
export const retryTargetBaseReconciliationUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryTargetBaseReconciliation");
export const retryForwardMergeVerificationUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryForwardMergeVerification");
export const reconcileCIUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileCI");
export const repairCIUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("repairCI");
export const finalReviewUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("finalReview");
export const acceptDeliveryUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("acceptDelivery");
export const requestDeliveryChangesUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("requestDeliveryChanges");
export const cancelIssueUpdate = defineUpdate<IssueWorkflowState, [PlanCommandInput]>("cancelIssue");
export const reconcileAcceptanceUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileAcceptance");
export const reconcileMergeUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("reconcileMerge");
export const retryCapacityUpdate = defineUpdate<IssueWorkflowState, [StartPlanningInput]>("retryCapacity");
const leadPlanningPatch = "forge-lead-planning-v1";
const planGovernancePatch = "forge-plan-governance-v1";
const planningProjectionIntegrityPatch = "forge-planning-projection-integrity-v1";
const distinctPlanningStatesPatch = "forge-distinct-planning-states-v1";
const developerFailureRecoveryPatch = "forge-developer-failure-recovery-v1";
const captureInitialProjectionStatePatch = "forge-capture-initial-projection-state-v1";
const artifactBackedConflictPatch = "forge-artifact-backed-conflict-evidence-v1";
const artifactBackedReviewPatch = "forge-artifact-backed-review-evidence-v1";
const exactDeliveryReviewPatch = "forge-exact-delivery-review-v1";
const typedReleaseResultPatch = "forge-typed-release-result-v1";
const targetBaseReconciliationPatch = "forge-target-base-reconciliation-v1";
const exactAcceptanceReceiptPatch = "forge-exact-acceptance-receipt-v1";
const reviseContinuePatch = "forge-revise-continue-v1";
const developerSupervisorPatch = "forge-developer-supervisor-v1";

function compactStateForContinuation(state: IssueWorkflowState): IssueWorkflowState {
  const compact = { ...state, activeOperation: null } as Record<string, unknown>;
  for (const key of ["worktreePath", "deliveryBlockingFindings", "deliveryRepairPlan", "forwardMergeConflictFiles", "forwardMergeConflictDiff", "conflictFiles", "conflictDiff"]) delete compact[key];
  return IssueWorkflowStateSchema.parse(compact);
}
const durableCapacityPatch = "durable-capacity-v1";

function permanentActivityFailure(error: unknown): { code: string; summary: string; category?: IssueBlocker["category"]; evidenceArtifactId?: string; evidenceSha256?: string } | undefined {
  if (error instanceof ApplicationFailure && error.nonRetryable) {
    return { code: error.type ?? "permanent-activity-failure", summary: error.message || "The invocation cannot complete without a configuration change." };
  }
  if (!(error instanceof ActivityFailure) || !(error.cause instanceof ApplicationFailure) || !error.cause.nonRetryable) return undefined;
  const detail = error.cause.details?.[0];
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.summary === "string") {
      const category = AttentionCategorySchema.safeParse(record.category);
      return { code: record.code, summary: record.summary, ...(category.success ? { category: category.data } : {}), ...(typeof record.evidenceArtifactId === "string" ? { evidenceArtifactId: record.evidenceArtifactId } : {}), ...(typeof record.evidenceSha256 === "string" ? { evidenceSha256: record.evidenceSha256 } : {}) };
    }
  }
  return { code: error.cause.type ?? "permanent-activity-failure", summary: "The invocation cannot complete without a configuration change." };
}

function evidencePointer(artifactId: string | undefined, sha256: string | undefined, kind: ArtifactPointer["kind"]): ArtifactPointer | undefined {
  const pointer = artifactId && sha256 ? { artifactId, sha256, kind } : undefined;
  return pointer && ArtifactPointerSchema.safeParse(pointer).success ? pointer : undefined;
}

function humanBlocker(category: IssueBlocker["category"], summary: string, actions: IssueBlockerAction[], evidence: ArtifactPointer | undefined): IssueBlocker | null {
  if (!evidence) return null;
  return IssueBlockerSchema.parse({ category, summary: summary.replace(/[\r\n]+/g, " ").slice(0, 240), unblockOwner: "human", actions, evidence, createdAt: new Date().toISOString(), retry: null });
}

type CompletedReview = Extract<DeliveryReviewActivityResult, { outcome: "completed" }>;
type LegacyReviewResult = {
  reviewId: string;
  outcome: "approved" | "blocking";
  summary: string;
  repairPlan?: string | null;
  findings?: Array<{ severity: "blocking" | "advisory"; disposition: "open" | "accepted" | "repaired" }>;
  reviewArtifact?: IssueWorkflowState["deliveryReviewArtifact"];
};
type CompletedRepair = Omit<Extract<DeveloperRepairActivityResult, { outcome: "completed" }>, "worktreePath"> & { worktreePath?: string };
type BlockedRepair = Omit<Extract<DeveloperRepairActivityResult, { outcome: "blocked" }>, "worktreePath">;

function revisioned(state: IssueWorkflowState, phase: IssueWorkflowState["phase"], owner: IssueWorkflowState["owner"], allowedCommands: IssueWorkflowState["allowedCommands"], pendingAction: string): IssueWorkflowState {
  const revision = state.revision + 1;
  return IssueWorkflowStateSchema.parse({ ...state, revision, phase, owner, allowedCommands, pendingAction, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${revision}` });
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
  const canRepair = result.review.opinion === "blocking" && result.review.repairPlan !== null && openBlocking.length > 0 && (state.repairCycle ?? 0) < repairCycleLimit;
  const phase = result.review.opinion === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "delivery_blocked";
  const owner = phase === "repair_required" ? "lead" : "human";
  const allowedCommands: IssueWorkflowState["allowedCommands"] = phase === "repair_required" ? ["repair_delivery", "cancel_issue"] : phase === "delivery_blocked" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"];
  const pendingAction = phase === "repair_required" ? "Developer repair of blocking findings" : phase === "delivery_blocked" ? "Member decision required" : "Publish draft pull request";
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, phase, owner, allowedCommands, pendingAction),
    blocker: phase === "delivery_blocked" ? humanBlocker("agent_exhausted", result.review.summary, [{ command: "record_delivery_decision", label: "Record delivery decision", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], result.review.reviewArtifact ? evidencePointer(result.review.reviewArtifact.artifactId, result.review.reviewArtifact.sha256, "delivery-review") : undefined) : null,
    deliveryReviewId: result.review.reviewId,
    deliveryReviewAttemptId: result.attemptId,
    deliveryReviewOutcome: result.review.opinion,
    deliveryReviewSummary: result.review.summary,
    deliveryBlockingFindings: openBlocking,
    deliveryRepairPlan: result.review.repairPlanArtifactId ? null : result.review.repairPlan,
    deliveryRepairPlanArtifactId: result.review.repairPlanArtifactId ?? null,
    deliveryRepairPlanSha256: result.review.repairPlanSha256 ?? null,
    deliveryRepairAuthority: result.review.opinion === "blocking" ? "delivery_review" : null,
    deliveryReviewBlockerCode: null,
    deliveryReviewBlockerSummary: null,
    deliveryReviewBlockerEvidenceArtifactId: null,
    deliveryReviewSupersedesId: result.review.supersedesReviewId,
    deliveryReviewArtifact: result.review.reviewArtifact,
    repairCycle: state.repairCycle ?? 0,
  });
}

export function repairBlockedState(state: IssueWorkflowState, result: BlockedRepair & { evidenceArtifactSha256?: string }, repairCycleLimit: number): IssueWorkflowState {
  const retry = result.cycle < repairCycleLimit && result.code !== "repair-cap-exhausted" && result.code !== "worktree-unsafe";
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, "delivery_blocked", "human", retry ? ["repair_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], retry ? "Developer repair blocked; retry the repair" : "Member decision required"),
    blocker: retry ? null : humanBlocker("agent_exhausted", result.summary, [{ command: "record_delivery_decision", label: "Record delivery decision", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.evidenceArtifactId, result.evidenceArtifactSha256, "developer-repair")),
    repairCycle: result.cycle,
    deliveryRepairAttemptId: result.repairAttemptId,
    deliveryRepairBlockerCode: result.code,
    deliveryRepairBlockerSummary: result.summary,
    deliveryRepairBlockerEvidenceArtifactId: result.evidenceArtifactId,
  });
}

export function repairInfrastructureBlockedState(state: IssueWorkflowState, cycle: number, repairCycleLimit: number, evidenceArtifactId: string | null): IssueWorkflowState {
  const retry = cycle < repairCycleLimit;
  return IssueWorkflowStateSchema.parse({
    ...revisioned(state, "delivery_blocked", "human", retry ? ["repair_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], "Repair infrastructure failed; retry or record a decision"),
    repairCycle: cycle,
    deliveryRepairBlockerCode: "repair-infrastructure-failure",
    deliveryRepairBlockerSummary: "The repair infrastructure did not complete; retry the repair.",
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
    deliveryRepairPlan: null,
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

function rateLimitFailure(error: unknown): { retryAt?: string } | undefined {
  if (!(error instanceof ActivityFailure) || !(error.cause instanceof ApplicationFailure) || error.cause.type !== "rate-limited") return undefined;
  const detail = error.cause.details?.[0];
  if (!detail || typeof detail !== "object") return {};
  const retryAt = (detail as Record<string, unknown>).retryAt;
  return typeof retryAt === "string" ? { retryAt } : {};
}

export async function issueWorkflow(input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const validatedInput = IssueWorkflowInputSchema.parse(input);
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const continuation = validatedInput.continuationState;
  const continueAfter = validatedInput.continueAsNewAfter ?? 0;
  const reviseContinueEnabled = patched(reviseContinuePatch);
  const addRevisionCommand = (commands: IssueCommand[]): IssueCommand[] => reviseContinueEnabled && !commands.includes("revise_plan") ? [...commands, "revise_plan"] : commands;
  let state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState(validatedInput),
    activeOperation: null,
    processedCommandIds: [],
    ...(continuation ?? {}),
    continuationCount: continuation ? continuation.continuationCount + 1 : 0,
  });
  let continuationRequested = false;
  let initialProjectionComplete = Boolean(continuation);
  const shouldContinueAsNew = (revision: number): boolean => {
    return workflowInfo().continueAsNewSuggested || (continueAfter > 0 && revision >= continueAfter) || workflowInfo().historyLength >= WORKFLOW_HISTORY_EVENT_LIMIT;
  };
  let stateMutationLocked = false;
  const withStateMutation = async <T>(operation: () => T): Promise<T> => {
    await condition(() => !stateMutationLocked);
    stateMutationLocked = true;
    try { return operation(); } finally { stateMutationLocked = false; }
  };
  const commandAlreadyProcessed = (commandId: string): boolean => commandId !== "legacy-command" && (state.processedCommandIds ?? []).includes(commandId);
  const markCommandProcessed = (commandId: string): void => {
    const processed = state.processedCommandIds ?? [];
    if (commandId !== "legacy-command" && !processed.includes(commandId)) state = IssueWorkflowStateSchema.parse({ ...state, processedCommandIds: [...processed, commandId].slice(-64) });
  };
  const applyTargetBaseBlocked = (result: Extract<ReconcileTargetBaseActivityResult, { outcome: "blocked" }>): void => {
    const verification = result.code === "verification_failed" || result.code === "verification_timed_out" || result.code === "verification_evidence_too_large";
    const allowedCommands = result.retryable ? [verification ? "retry_forward_merge_verification" : "retry_target_base_reconciliation", "cancel_issue"] as const : ["cancel_issue"] as const;
    state = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      phase: "delivery_blocked",
      owner: result.owner === "lead" ? "lead" : "human",
      allowedCommands,
      pendingAction: result.summary,
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      targetBaseCheckId: result.checkId,
      targetBaseCheckpoint: result.checkpoint,
      targetBaseOutcome: result.outcome,
      targetBaseBlockerCode: result.code,
      targetBaseBlockerOwner: result.owner,
      targetBaseBlockerRetryable: result.retryable,
      targetBaseBlockerSummary: result.summary,
      ...(verification && result.observedBaseSha ? { forwardMergeTargetBaseSha: result.observedBaseSha } : {}),
      ...(verification && result.resultHead ? { resultCommit: result.resultHead } : {}),
      ...(verification && result.resultTree ? { resultTree: result.resultTree } : {}),
      ...(verification && result.evidenceArtifact ? { developerEvidenceArtifactId: result.evidenceArtifact.id, developerOutcome: "blocked" as const } : {}),
    });
  };
  const runTargetBaseCheckpoint = async (checkpoint: TargetBaseCheckpoint, verificationOnly = false): Promise<boolean> => {
    if (!patched(targetBaseReconciliationPatch)) return true;
    if (!state.developerExecutionId || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("An exact Developer delivery is required before target-base reconciliation");
    const result = await reconcileTargetBase({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, checkpoint, developerExecutionId: state.developerExecutionId, expectedBaseSha: state.targetBaseSha, expectedHeadSha: state.resultCommit, expectedHeadTree: state.resultTree, ...(verificationOnly ? { verificationOnly: true, forwardMergeId: state.targetBaseCheckId ?? undefined } : {}), ...(state.deliveryReviewId ? { deliveryReviewId: state.deliveryReviewId } : {}), ...(state.ciRunId ? { ciRunId: state.ciRunId } : {}), ...(state.finalReviewId ? { finalReviewId: state.finalReviewId } : {}), ...(state.acceptanceId ? { acceptanceId: state.acceptanceId } : {}), ...(state.releaseId ? { releaseId: state.releaseId } : {}) });
    if (result.outcome === "no_drift") {
      const priorRevision = state.revision;
      state = applyTargetBaseNoDrift(state, result);
      if (state.revision !== priorRevision) await projectIssueState(state);
      return true;
    }
    if (result.outcome === "revalidated") state = applyTargetBaseRevalidation(state, result);
    else if (result.outcome === "blocked") applyTargetBaseBlocked(result);
    else {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: [], pendingAction: "Lead conflict-resolution plan", targetBaseCheckId: result.checkId, targetBaseCheckpoint: result.checkpoint, targetBaseOutcome: result.outcome, targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null, forwardMergePriorHead: result.priorHead, forwardMergePriorTree: result.priorTree, forwardMergeTargetBaseSha: result.observedBaseSha, forwardMergeConflictArtifact: result.conflictArtifact, forwardMergeConflictFileCount: result.conflictFileCount, forwardMergeId: result.checkId, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await planMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, worktreePath: state.worktreePath!, branchName: state.branchName!, priorHead: result.priorHead, targetBaseSha: result.observedBaseSha, conflictArtifact: result.conflictArtifact, conflictFileCount: result.conflictFileCount, forwardMergeId: result.checkId });
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Lead conflict-resolution planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
    }
    await projectIssueState(state);
    return false;
  };
  const supervisedDeveloperTurns = patched(developerSupervisorPatch);
  const recoveryFields = (status: "starting" | "active" | "reconnecting" | "result_pending_claim" | "cancellation_requested" | "cancelling" | "interrupted" | "cancelled" | "ownership_ambiguous" | "failed", reasonCode: string | null, summary: string | null, heartbeatAt: string | null) => ({ developerRecoveryStatus: status, developerRecoveryReasonCode: reasonCode, developerRecoverySummary: summary, developerLastHeartbeatAt: heartbeatAt });
  const applyCompletedDeveloperResult = (rawResult: unknown, summary: string): boolean => {
    if (!rawResult || typeof rawResult !== "object") return false;
    const result = rawResult as Record<string, unknown>;
    const requiredStrings = ["developerExecutionId", "developerSessionRef", "resultCommit", "resultTree", "deliveryArtifactId", "evidenceArtifactId"];
    if (requiredStrings.some((field) => typeof result[field] !== "string" || !result[field])) return false;
    const common = {
      developerExecutionId: result.developerExecutionId as string,
      developerSessionRef: result.developerSessionRef as string,
      resultCommit: result.resultCommit as string,
      resultTree: result.resultTree as string,
      deliveryArtifactId: result.deliveryArtifactId as string,
      developerEvidenceArtifactId: result.evidenceArtifactId as string,
      deliverySummary: (typeof result.deliverySummary === "string" ? result.deliverySummary : result.summary as string),
      developerOutcome: "completed" as const,
      ...recoveryFields("active", null, summary, null),
      activeOperation: null,
    };
    if (state.developerTurnKind === "implementation") {
      if (typeof result.branchName !== "string" || typeof result.targetBaseSha !== "string" || (result.dirtyState !== "clean" && result.dirtyState !== "dirty") || result.outcome !== "completed") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Lead delivery review", branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: typeof result.currentStep === "number" ? result.currentStep : null, dirtyState: result.dirtyState, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "repair") {
      if (typeof result.branchName !== "string" || typeof result.targetBaseSha !== "string" || (result.dirtyState !== "clean" && result.dirtyState !== "dirty") || result.outcome !== "completed" || typeof result.cycle !== "number") return false;
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead delivery review required", branchName: result.branchName, targetBaseSha: result.targetBaseSha, dirtyState: result.dirtyState, repairCycle: result.cycle, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    if (state.developerTurnKind === "merge_conflict_resolution") {
      state = IssueWorkflowStateSchema.parse({ ...state, ...common, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead delivery review required after conflict resolution", targetBaseSha: state.forwardMergeTargetBaseSha ?? state.targetBaseSha, dirtyState: "clean", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, mergeResolutionDeveloperExecutionId: result.developerExecutionId as string, mergeResolutionDeveloperSessionRef: result.developerSessionRef as string, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      return true;
    }
    return false;
  };
  setHandler(issueStateQuery, () => state);
  const captureInitialProjectionState = patched(captureInitialProjectionStatePatch);
  const initialProjectionState = state;
  const projectCapacityState = async (capacity: IssueWorkflowState["capacity"], pendingAction?: string): Promise<number> => {
    const changed = JSON.stringify(state.capacity) !== JSON.stringify(capacity) || (pendingAction !== undefined && state.pendingAction !== pendingAction);
    if (!changed) return state.revision;
    state = IssueWorkflowStateSchema.parse({ ...state, capacity, ...(capacity === null ? { capacityBlocker: null } : {}), ...(pendingAction !== undefined ? { pendingAction } : {}), revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    const projectedRevision = state.revision;
    await projectIssueState(state);
    return projectedRevision;
  };
  const acquireExternalTurn = async <T>(spec: { operation: CapacityOperation; role: CapacityRole; profileId?: string | undefined; sessionRef?: string | null | undefined; worktreePath?: string | null | undefined }, run: (capacityRequestId?: string) => Promise<T>, executionId: (result: T) => string | undefined): Promise<T> => {
    if (!patched(durableCapacityPatch)) return run(undefined);
    if (!spec.profileId) throw ApplicationFailure.nonRetryable("profile_unavailable", "profile_unavailable", { operation: spec.operation, role: spec.role });
    const turnRevision = state.revision;
    const expectedPhase = state.phase;
    const commandsBeforeWait = state.allowedCommands;
    let observedRevision = state.revision;
    const isCurrent = (): boolean => state.phase === expectedPhase && state.revision === observedRevision;
    const assertCurrent = (): void => { if (!isCurrent()) throw new Error("External turn became stale"); };
    const abandonStaleRequest = async (): Promise<void> => {
      const current = await inspectCapacity({ requestId: request.id });
      if (["queued", "rate_limited", "active", "ownership_ambiguous"].includes(current.status)) {
        await cancelCapacityExecution({ requestId: request.id });
      }
    };
    const request = await requestCapacity({ logicalTurnKey: `${state.workflowId}:${turnRevision}:${spec.operation}`, companyId: state.companyId, taskId: state.issueId, workflowId: state.workflowId, projectRevisionId: state.projectRevisionId, workflowRevision: turnRevision, operation: spec.operation, role: spec.role, profileId: spec.profileId, sessionRef: spec.sessionRef ?? null, worktreePath: spec.worktreePath ?? null });
    if (!isCurrent()) {
      await abandonStaleRequest();
      throw new Error("External turn became stale");
    }
    for (;;) {
      if (!isCurrent()) {
        await abandonStaleRequest();
        throw new Error("External turn became stale before admission");
      }
      const admission = await tryAcquireCapacity({ requestId: request.id, expectedWorkflowRevision: turnRevision });
      if (!isCurrent()) {
        await abandonStaleRequest();
        throw new Error("External turn became stale after admission");
      }
      if ((admission.status === "queued" || admission.status === "rate_limited") && state.allowedCommands.some((command) => !["cancel_issue", "cancel_development"].includes(command))) {
        const waitingCommands = state.allowedCommands.filter((command) => command === "cancel_issue" || command === "cancel_development");
        state = IssueWorkflowStateSchema.parse({ ...state, allowedCommands: waitingCommands, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        observedRevision = state.revision;
        await projectIssueState(state);
      }
      observedRevision = await projectCapacityState(admission.publicState, admission.status === "queued" ? "Waiting for external capacity" : admission.status === "rate_limited" ? "Waiting for provider reset" : state.pendingAction ?? undefined);
      if (!isCurrent()) {
        await abandonStaleRequest();
        throw new Error("External turn became stale after projection");
      }
      if (admission.status === "active") {
        if (state.allowedCommands.length !== commandsBeforeWait.length || state.allowedCommands.some((command, index) => command !== commandsBeforeWait[index])) {
          state = IssueWorkflowStateSchema.parse({ ...state, allowedCommands: commandsBeforeWait, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
          observedRevision = state.revision;
          await projectIssueState(state);
        }
        assertCurrent();
        try {
          const result = await run(request.id);
          assertCurrent();
          const current = await inspectCapacity({ requestId: request.id });
          assertCurrent();
          const resultExecutionId = executionId(result);
          if (current.executionId && resultExecutionId && current.executionId !== resultExecutionId) throw ApplicationFailure.nonRetryable("capacity_owner_mismatch", "capacity_owner_mismatch", { requestId: request.id });
          const ownerId = current.executionId;
          await finalizeCapacity({ requestId: request.id, expectedExecutionId: ownerId ?? request.id, terminalReason: ownerId ? "completed" : "failed_before_start" });
          assertCurrent();
          observedRevision = await projectCapacityState(null);
          return result;
        } catch (error) {
          if (!isCurrent()) throw error;
          const current = await inspectCapacity({ requestId: request.id });
          const rateLimit = rateLimitFailure(error);
          if (rateLimit && current.executionId) {
            const limited = await rateLimitCapacity({ requestId: request.id, executionId: current.executionId, ...(rateLimit.retryAt ? { retryAt: rateLimit.retryAt } : {}) });
            if (limited.status === "exhausted") {
              const blocker = { category: "capacity_exhausted" as const, summary: "External turn capacity was exhausted.", nextAction: "Retry capacity or cancel the issue.", resumeOperation: spec.operation };
              state = IssueWorkflowStateSchema.parse({ ...state, capacity: { ...admission.publicState, status: "exhausted", position: null, reason: null, retryAt: null, rateLimitAttempts: limited.rateLimitAttempts }, capacityBlocker: blocker, allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: "Capacity retry required", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
              observedRevision = state.revision;
              await projectIssueState(state);
              throw ApplicationFailure.nonRetryable("capacity_exhausted", "capacity_exhausted", blocker);
            }
            observedRevision = await projectCapacityState({ ...admission.publicState, status: "rate_limited", position: null, reason: "rate_limit_reset", retryAt: limited.retryAt, rateLimitAttempts: limited.rateLimitAttempts }, "Waiting for provider reset");
            continue;
          }
          await finalizeCapacity({ requestId: request.id, expectedExecutionId: current.executionId ?? request.id, terminalReason: current.executionId ? "process_failed" : "failed_before_start" });
          throw error;
        }
      }
      if (admission.status === "exhausted" || admission.status === "ownership_ambiguous") {
        const category = admission.status === "exhausted" ? "capacity_exhausted" : "ownership_ambiguous";
        state = IssueWorkflowStateSchema.parse({ ...state, capacity: admission.publicState, capacityBlocker: { category, summary: category === "capacity_exhausted" ? "External turn capacity was exhausted." : "Forge cannot prove external process ownership.", nextAction: category === "capacity_exhausted" ? "Retry capacity or cancel the issue." : "Verify ownership before retrying or cancelling.", resumeOperation: spec.operation }, allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: category === "capacity_exhausted" ? "Capacity retry required" : "Ownership verification required", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        throw ApplicationFailure.nonRetryable(category, category, state.capacityBlocker);
      }
      const retryDelay = admission.status === "rate_limited" && admission.publicState.retryAt
        ? Math.max(1_000, isoEpochMillis(admission.publicState.retryAt) - Date.now())
        : 5_000;
      await sleep(retryDelay);
      if (!isCurrent()) {
        await abandonStaleRequest();
        throw new Error("External turn became stale while waiting for capacity");
      }
      if (admission.status === "rate_limited") {
        await requeueCapacity({ requestId: request.id });
        if (!isCurrent()) {
          await abandonStaleRequest();
          throw new Error("External turn became stale while requeueing capacity");
        }
      }
    }
  };
  setHandler(startPlanningUpdate, async (rawInput) => {
    if (captureInitialProjectionState) await condition(() => initialProjectionComplete);
    assertPayloadWithinLimit("startPlanning command", rawInput);
    StartPlanningInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      phase: "planning",
      revision: state.revision + 1,
      owner: "lead",
      allowedCommands: continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      blocker: null,
      stateChangedAt: new Date().toISOString(),
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      continuationCount: state.continuationCount,
      lastSummaryHash: state.lastSummaryHash,
    });
    state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    const distinctPlanningStates = patched(distinctPlanningStatesPatch);
    if (distinctPlanningStates || !patched(planningProjectionIntegrityPatch)) await projectIssueState(next);
    if (patched(leadPlanningPatch)) {
      let leadResult;
      try {
        leadResult = await acquireExternalTurn<LeadPlanningResult>(
          { operation: "lead_planning", role: "lead", profileId: validatedInput.roleProfiles.lead },
          (capacityRequestId) => runLeadPlanning({
            taskId: validatedInput.issueId,
            companyId: validatedInput.companyId,
            workflowId: validatedInput.workflowId,
            projectId: validatedInput.projectId,
            projectRevisionId: validatedInput.projectRevisionId,
            briefArtifactId: validatedInput.briefArtifactId,
            imageArtifactIds: validatedInput.imageArtifactIds,
            roleProfiles: validatedInput.roleProfiles,
            revision: next.revision,
            ...(next.revisionRequestId ? { revisionRequestId: next.revisionRequestId } : {}),
            ...(next.revisionRequestId && next.leadSessionRef ? { resumeLeadSessionRef: next.leadSessionRef } : {}),
            ...(capacityRequestId ? { capacityRequestId } : {}),
          }),
          (result) => result.leadExecutionId,
        );
      } catch (error) {
        if (state.phase === "cancelled") return state;
        if (state.capacityBlocker) return state;
        const failure = permanentActivityFailure(error);
        if (!failure) throw error;
        const failureBase = patched(durableCapacityPatch) ? state : next;
        const failureRevision = failureBase.revision + 1;
        state = IssueWorkflowStateSchema.parse({
          ...failureBase,
          capacity: null,
          capacityBlocker: null,
          phase: "failed",
          revision: failureRevision,
          owner: "human",
          allowedCommands: reviseContinueEnabled ? ["start_planning", "continue_work", "cancel_issue"] : ["start_planning", "cancel_issue"],
          pendingAction: failure.summary,
          blocker: failure.category ? humanBlocker(failure.category, failure.summary, [{ command: "start_planning", label: "Retry planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null,
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${state.workflowId}:${failureRevision}`,
        });
        await projectIssueState(state);
        return state;
      }
      const planningBase = patched(durableCapacityPatch) ? state : next;
      state = IssueWorkflowStateSchema.parse({ ...planningBase, ...leadResult, ...(distinctPlanningStates ? { revision: planningBase.revision + 1, lastEventId: `${planningBase.workflowId}:${planningBase.revision + 1}` } : {}), planRevision: next.revision, planMaterial: leadResult.material, materialCategories: leadResult.materialCategories, preservedWorktreeCompatibility: leadResult.preservedWorktreeCompatibility ?? null, supplementalReviewUsed: false, blocker: null, stateChangedAt: new Date().toISOString() });
      if (state.revisionRequestId && state.revisedExecutionCoordinates?.disposition === "reuse" && state.preservedWorktreeCompatibility !== true) {
        state = IssueWorkflowStateSchema.parse({ ...state, phase: "delivery_blocked", owner: "human", allowedCommands: ["revise_plan", "cancel_issue"], pendingAction: "Choose a new exact-base worktree for the incompatible revised plan", blockerCode: "preserved-worktree-incompatible" });
        await projectIssueState(state);
        return state;
      }
      if (state.revisionRequestId) await authorizePlanRevision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, revisionRequestId: state.revisionRequestId, planRevision: state.planRevision ?? state.revision });
      if (patched(planGovernancePatch)) {
        const planBlocker = leadResult.material || leadResult.leadOutputKind === "decision_blocker"
          ? humanBlocker(leadResult.leadOutputKind === "decision_blocker" ? "member_decision" : "member_authorization", leadResult.leadSummary, [{ command: "approve_plan", label: "Approve plan", requiresNote: false, destructive: false }, { command: "reject_plan", label: "Request plan changes", requiresNote: true, destructive: false }], evidencePointer(leadResult.leadOutputArtifactId, leadResult.leadOutputArtifactSha256, leadResult.leadOutputKind === "decision_blocker" ? "decision-blocker" : "lead-plan"))
          : null;
        state = leadResult.material || leadResult.leadOutputKind === "decision_blocker"
          ? IssueWorkflowStateSchema.parse({ ...state, phase: "approval", owner: "human", allowedCommands: addRevisionCommand(["approve_plan", "reject_plan", "cancel_issue", ...(validatedInput.supplementalReview ? ["request_supplemental_review" as const] : [])]), pendingAction: leadResult.leadOutputKind === "decision_blocker" ? "Member decision required" : "Approve final plan", blocker: planBlocker, stateChangedAt: new Date().toISOString() })
          : IssueWorkflowStateSchema.parse({ ...state, phase: "ready_for_development", owner: "lead", allowedCommands: addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", blocker: null, stateChangedAt: new Date().toISOString() });
      }
      assertPayloadWithinLimit("Issue Workflow result", state);
      await projectIssueState(state);
    }
    return state;
  }, {
    validator(rawInput) {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "backlog" && state.phase !== "planning" && state.phase !== "failed") throw new Error("Planning can only start from Backlog, Planning, or Failed");
    },
  });
  const validatePlanCommand = (rawInput: PlanCommandInput): PlanCommandInput => {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "approval") throw new Error("Plan command is not available in the current phase");
    return command;
  };
  setHandler(requestSupplementalReviewUpdate, async (rawInput) => {
    assertPayloadWithinLimit("supplemental review command", rawInput);
    const command = validatePlanCommand(rawInput);
    const review = await acquireExternalTurn<SupplementalReviewResult>(
      { operation: "supplemental_review", role: "reviewer", profileId: validatedInput.roleProfiles.reviewer },
      (capacityRequestId) => runSupplementalReview({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.planRevision ?? state.revision, leadOutputArtifactId: state.leadOutputArtifactId!, leadEvidenceArtifactId: state.leadEvidenceArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.executionId,
    );
    const consolidated = await acquireExternalTurn<LeadPlanningResult>(
      { operation: "lead_consolidation", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef },
      (capacityRequestId) => consolidateLeadPlan({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.revision + 1, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.leadExecutionId,
    );
    state = IssueWorkflowStateSchema.parse({ ...state, ...consolidated, revision: state.revision + 1, phase: "approval", owner: "human", allowedCommands: addRevisionCommand(["approve_plan", "reject_plan", "cancel_issue"]), pendingAction: "Approve final plan", lastEventId: `${state.workflowId}:${state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, planMaterial: consolidated.material, materialCategories: consolidated.materialCategories, planRevision: state.planRevision ?? state.revision, blocker: humanBlocker("member_authorization", "Approve final plan", [{ command: "approve_plan", label: "Approve plan", requiresNote: false, destructive: false }, { command: "reject_plan", label: "Request plan changes", requiresNote: true, destructive: false }], evidencePointer(consolidated.leadOutputArtifactId, consolidated.leadOutputArtifactSha256, "lead-plan")), stateChangedAt: new Date().toISOString() });
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    validatePlanCommand(rawInput);
    if (!validatedInput.supplementalReview || state.supplementalReviewUsed) throw new Error("Supplemental review is not available");
    if (!state.planMaterial || !state.leadOutputArtifactId || !state.leadSessionRef) throw new Error("A material Lead plan is required before supplemental review");
    if (!validatedInput.roleProfiles.reviewer) throw new Error("A supplemental reviewer profile is required");
  } });
  setHandler(approvePlanUpdate, async (rawInput) => {
    assertPayloadWithinLimit("plan approval command", rawInput);
    const command = validatePlanCommand(rawInput);
    const planRevision = state.planRevision ?? state.revision;
    if (state.revisionRequestId) await authorizePlanRevision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, revisionRequestId: state.revisionRequestId, planRevision });
    const decision = await recordPlanDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision, actorUserId: command.actorUserId, decision: "approve", note: command.note ?? "Approved final plan", ...(state.revisionRequestId ? { revisionRequestId: state.revisionRequestId } : {}) });
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${state.workflowId}:${state.revision + 1}`, decisionId: decision.decisionId, blocker: null, stateChangedAt: new Date().toISOString() });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) { validatePlanCommand(rawInput); if (!state.planMaterial) throw new Error("Routine plans do not require approval"); } });
  setHandler(startDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("start development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    const planRevision = state.planRevision ?? state.revision;
    const developerAttempt = (state.developerAttempt ?? 0) + 1;
    const executionId = supervisedDeveloperTurns ? developerExecutionId(state.workflowId, planRevision, developerAttempt, "implementation") : `developer_${state.workflowId}_${command.commandId}`.slice(0, 256);
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || state.phase !== "ready_for_development") throw new Error("Development start was superseded by another command");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "development", owner: "lead", allowedCommands: addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: "Developer execution", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: executionId, developerAttempt, developerTurnKind: "implementation", ...recoveryFields("starting", null, "Starting the Developer turn.", null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
      markCommandProcessed(command.commandId);
    });
    await projectIssueState(state);
    const legacyInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, ...(state.revisionRequestId ? { revisionRequestId: state.revisionRequestId } : {}) };
    const recoverDeveloperFailures = supervisedDeveloperTurns ? false : patched(developerFailureRecoveryPatch);
    let outcome: Awaited<ReturnType<typeof runDeveloperExecutionSupervised>> | { status: "completed"; result: Awaited<ReturnType<typeof runDeveloperExecution>>; resultHash: string };
    try {
      outcome = await acquireExternalTurn(
        { operation: "developer_execution", role: "developer", profileId: validatedInput.roleProfiles.developer },
        (capacityRequestId) => supervisedDeveloperTurns
          ? runDeveloperExecutionSupervised({ ...legacyInput, developerTurnExecutionId: executionId, developerAttempt, turnKind: "implementation", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : runDeveloperExecution({ ...legacyInput, executionId, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
    } catch (error) {
      if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return state;
      if (supervisedDeveloperTurns || !recoverDeveloperFailures) throw error;
      const recovered = await withStateMutation(() => {
        if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer execution failed; retry is available", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null });
        if (shouldContinueAsNew(state.revision)) continuationRequested = true;
        return true;
      });
      if (recovered) await projectIssueState(state);
      return state;
    }
    const applied = await withStateMutation(() => {
      if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
      if (outcome.status === "completed") {
        const result = outcome.result;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? addRevisionCommand(["review_delivery", "cancel_issue"]) : addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, ...recoveryFields("active", null, "Developer result claimed.", null), activeOperation: null, blocker: result.outcome === "blocked" ? humanBlocker("agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.attentionEvidenceArtifactId, result.attentionEvidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
      } else {
        const allowedCommands = addRevisionCommand(outcome.status === "ownership_ambiguous" ? ["verify_developer_ownership", "cancel_issue"] : ["retry_development", "cancel_issue"]);
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands, pendingAction: outcome.summary, lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : state.developerEvidenceArtifactId, activeOperation: null });
      }
      if (shouldContinueAsNew(state.revision)) continuationRequested = true;
      return true;
    });
    if (applied) await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "ready_for_development") throw new Error("Development can only start after plan approval");
    if (state.planMaterial === null || state.planMaterial === undefined || !state.leadOutputArtifactId || !state.leadSessionRef) throw new Error("A validated Lead plan is required before development");
  } });
  setHandler(retryDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("retry development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    const planRevision = state.planRevision ?? state.revision;
    const developerAttempt = (state.developerAttempt ?? 0) + 1;
    const supersedesExecutionId = state.developerExecutionId!;
    const executionId = supervisedDeveloperTurns ? developerExecutionId(state.workflowId, planRevision, developerAttempt, "implementation") : `developer_${state.workflowId}_${command.commandId}`.slice(0, 256);
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || (state.phase !== "development" && state.phase !== "delivery_blocked")) throw new Error("Developer retry was superseded by another command");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "development", owner: "lead", allowedCommands: addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: "Developer retry", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: executionId, developerAttempt, developerTurnKind: "implementation", ...recoveryFields("starting", null, "Starting a linked Developer retry.", null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
      markCommandProcessed(command.commandId);
    });
    await projectIssueState(state);
    const legacyInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, ...(state.revisionRequestId ? { revisionRequestId: state.revisionRequestId } : {}), supersedesExecutionId, reuseWorktree: true };
    const outcome = await acquireExternalTurn(
      { operation: "developer_execution", role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: state.developerSessionRef, worktreePath: state.worktreePath },
      (capacityRequestId) => supervisedDeveloperTurns
        ? runDeveloperExecutionSupervised({ ...legacyInput, developerTurnExecutionId: executionId, developerAttempt, turnKind: "implementation", ...(capacityRequestId ? { capacityRequestId } : {}) })
        : runDeveloperExecution({ ...legacyInput, executionId, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
      (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
    );
    const applied = await withStateMutation(() => {
      if (state.activeOperation?.commandId !== command.commandId || state.phase !== "development") return false;
      if (outcome.status === "completed") {
        const result = outcome.result;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? addRevisionCommand(["review_delivery", "cancel_issue"]) : addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, ...recoveryFields("active", null, "Developer result claimed.", null), blocker: result.outcome === "blocked" ? humanBlocker("agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.attentionEvidenceArtifactId, result.attentionEvidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
      } else {
        const allowedCommands = addRevisionCommand(outcome.status === "ownership_ambiguous" ? ["verify_developer_ownership", "cancel_issue"] : ["retry_development", "cancel_issue"]);
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands, pendingAction: outcome.summary, lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : state.developerEvidenceArtifactId, activeOperation: null });
      }
      if (shouldContinueAsNew(state.revision)) continuationRequested = true;
      return true;
    });
    if (applied) await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "development" && state.phase !== "delivery_blocked") throw new Error("Developer retry is not available in the current phase");
    if (!state.developerExecutionId || !state.planMaterial || !state.leadOutputArtifactId || !state.leadSessionRef) throw new Error("A preserved Developer attempt and approved plan are required before retry");
  } });
  setHandler(reviewDeliveryUpdate, async (rawInput) => {
    assertPayloadWithinLimit("delivery review command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    const reviewing = reviewingDeliveryState(state);
    state = reviewing;
    await projectIssueState(state);
    let result: DeliveryReviewActivityResult | LegacyReviewResult;
    try {
      const subject = { planRevision: state.planRevision ?? state.revision, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, developerExecutionId: state.developerExecutionId!, deliveryArtifactId: state.deliveryArtifactId!, developerEvidenceArtifactId: state.developerEvidenceArtifactId!, leadSessionRef: state.leadSessionRef!, developerSessionRef: state.developerSessionRef! };
      const common = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadOutputArtifactId: state.leadOutputArtifactId!, branchName: state.branchName! };
      result = await acquireExternalTurn<DeliveryReviewActivityResult | LegacyReviewResult>(
        { operation: "delivery_review", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => reviewDelivery({ ...common, subject, worktreePath: state.worktreePath!, supersedesReviewId: state.deliveryReviewSupersedesId ?? null, ...(capacityRequestId ? { capacityRequestId } : {}) }) as unknown as Promise<DeliveryReviewActivityResult | LegacyReviewResult>,
        (value) => "attemptId" in value ? (value.outcome === "completed" ? value.review.leadExecutionId : value.executionId) : undefined,
      );
    } catch {
      let evidenceArtifactId: string | null = null;
      try { evidenceArtifactId = (await recordDeliveryBlocker({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, operation: "review" })).artifactId; } catch { /* Keep the fixed state transition if blocker recording itself is unavailable. */ }
      state = reviewBlockedState(state, { attemptId: null, code: "review-infrastructure-failure", summary: "The review infrastructure did not complete; retry the review.", evidenceArtifactId }, true);
      await projectIssueState(state);
      void command;
      return state;
    }
    const artifactBackedReview = patched(artifactBackedReviewPatch);
    patched(exactDeliveryReviewPatch);
    if (!("attemptId" in result)) {
      const legacyResult = result as LegacyReviewResult;
      if (artifactBackedReview && !legacyResult.reviewArtifact) throw ApplicationFailure.nonRetryable("Delivery review artifact is missing", "delivery_review_artifact_missing");
      const openBlocking = (legacyResult.findings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
      const canRepair = legacyResult.outcome === "blocking" && (state.repairCycle ?? 0) < validatedInput.repairCycleLimit;
      const nextPhase = legacyResult.outcome === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "delivery_blocked";
      state = IssueWorkflowStateSchema.parse({ ...revisioned(state, nextPhase, nextPhase === "repair_required" ? "lead" : "human", nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"], nextPhase === "repair_required" ? "Developer repair of blocking findings" : nextPhase === "delivery_blocked" ? "Member decision required" : "Publish draft pull request"), deliveryReviewId: legacyResult.reviewId, deliveryReviewOutcome: legacyResult.outcome, deliveryReviewSummary: legacyResult.summary, ...(legacyResult.reviewArtifact ? { deliveryReviewArtifact: legacyResult.reviewArtifact } : {}), deliveryBlockingFindings: openBlocking, deliveryRepairPlan: legacyResult.repairPlan ?? null, repairCycle: state.repairCycle ?? 0 });
    } else {
      const exactResult = result as DeliveryReviewActivityResult;
      state = exactResult.outcome === "blocked"
        ? reviewBlockedState(state, exactResult)
        : repairRequiredState(state, exactResult, validatedInput.repairCycleLimit);
    }
    state = IssueWorkflowStateSchema.parse({ ...state, allowedCommands: addRevisionCommand(state.allowedCommands) });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "delivery_ready" && state.phase !== "delivery_blocked") throw new Error("Delivery review is not available in the current phase");
    if (state.phase === "delivery_blocked" && !state.deliveryReviewBlockerCode) throw new Error("A review blocker is required before retrying delivery review");
    if (!state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.deliveryArtifactId || !state.developerEvidenceArtifactId || !state.leadSessionRef || !state.leadOutputArtifactId) throw new Error("An exact Developer delivery and Lead session are required before review");
  } });
  setHandler(repairDeliveryUpdate, async (rawInput) => {
    assertPayloadWithinLimit("delivery repair command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    const cycle = (state.repairCycle ?? 0) + 1;
    const planRevision = state.planRevision ?? state.revision;
    const developerAttempt = (state.developerAttempt ?? 0) + 1;
    const priorExecutionId = state.developerExecutionId!;
    const turnExecutionId = developerExecutionId(state.workflowId, planRevision, developerAttempt, "repair");
    const priorDelivery = { developerSessionRef: state.developerSessionRef!, reviewId: state.deliveryReviewId!, branchName: state.branchName!, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, reviewArtifact: state.deliveryReviewArtifact, blockingFindings: state.deliveryBlockingFindings ?? [], repairPlan: state.deliveryRepairPlan! };
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || (state.phase !== "repair_required" && state.phase !== "delivery_blocked")) throw new Error("Developer repair was superseded by another command");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: `Developer repair cycle ${cycle}`, lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: supervisedDeveloperTurns ? turnExecutionId : state.developerExecutionId, developerAttempt, developerTurnKind: "repair", ...recoveryFields("starting", null, "Starting the bounded Developer repair.", null), activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: state.revision + 1 } });
    });
    await projectIssueState(state);
    const artifactBackedReview = patched(artifactBackedReviewPatch);
    const repairInput = {
      taskId: validatedInput.issueId,
      companyId: validatedInput.companyId,
      workflowId: validatedInput.workflowId,
      projectId: validatedInput.projectId,
      projectRevisionId: validatedInput.projectRevisionId,
      planRevision,
      roleProfiles: validatedInput.roleProfiles,
      leadSessionRef: state.leadSessionRef!,
      developerSessionRef: priorDelivery.developerSessionRef,
      developerExecutionId: priorExecutionId,
      reviewId: priorDelivery.reviewId,
      cycle,
      repairCycleLimit: validatedInput.repairCycleLimit,
      branchName: priorDelivery.branchName,
      targetBaseSha: priorDelivery.targetBaseSha,
      subjectCommit: priorDelivery.subjectCommit,
      subjectTree: priorDelivery.subjectTree,
      repairAuthority: state.deliveryRepairAuthority ?? "delivery_review",
      ...(state.deliveryRepairAuthority === "delivery_review" && artifactBackedReview && priorDelivery.reviewArtifact
        ? { reviewArtifact: priorDelivery.reviewArtifact }
        : state.deliveryRepairPlanArtifactId && state.deliveryRepairPlanSha256
          ? { repairPlanArtifactId: state.deliveryRepairPlanArtifactId, repairPlanSha256: state.deliveryRepairPlanSha256, blockingFindings: priorDelivery.blockingFindings }
          : { blockingFindings: priorDelivery.blockingFindings, repairPlan: priorDelivery.repairPlan }),
    };
    let outcome: Awaited<ReturnType<typeof runDeveloperRepairSupervised>> | { status: "completed"; result: WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult; resultHash: string };
    try {
      outcome = await acquireExternalTurn(
        { operation: "developer_repair", role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: state.developerSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => supervisedDeveloperTurns
          ? runDeveloperRepairSupervised({ ...repairInput, developerTurnExecutionId: turnExecutionId, developerAttempt, turnKind: "repair", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : (runDeveloperRepair({ ...repairInput, ...(capacityRequestId ? { capacityRequestId } : {}) }) as unknown as Promise<WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult>).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
    } catch {
      let evidenceArtifactId: string | null = null;
      try { evidenceArtifactId = (await recordDeliveryBlocker({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, operation: "repair" })).artifactId; } catch { /* Keep the fixed state transition if blocker recording itself is unavailable. */ }
      state = repairInfrastructureBlockedState(state, cycle, validatedInput.repairCycleLimit, evidenceArtifactId);
      await projectIssueState(state);
      void command;
      return state;
    }
    if (outcome.status !== "completed") {
      await withStateMutation(() => {
        if (state.activeOperation?.commandId !== command.commandId) return;
        const allowedCommands = addRevisionCommand(outcome.status === "ownership_ambiguous" ? ["verify_developer_ownership", "cancel_issue"] : ["repair_delivery", "cancel_issue"]);
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands, pendingAction: outcome.summary, lastEventId: `${state.workflowId}:${state.revision + 1}`, ...recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : state.developerEvidenceArtifactId, activeOperation: null });
      });
      await projectIssueState(state);
      return state;
    }
    const result: WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult = outcome.result;
    if ("repairAttemptId" in result) {
      state = result.outcome === "completed"
        ? repairedDeliveryAwaitingFreshReviewState(state, result)
        : repairBlockedState(state, result, validatedInput.repairCycleLimit);
    } else {
      const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
      state = IssueWorkflowStateSchema.parse({ ...revisioned(state, nextPhase, result.outcome === "completed" ? "lead" : "human", result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], result.outcome === "completed" ? "Fresh Lead delivery review required" : "Member decision required"), developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: result.worktreePath, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, deliveryReviewSupersedesId: result.outcome === "completed" ? state.deliveryReviewId : state.deliveryReviewSupersedesId, deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId, deliveryReviewOutcome: result.outcome === "completed" ? null : state.deliveryReviewOutcome, deliveryReviewSummary: result.outcome === "completed" ? null : state.deliveryReviewSummary, ...(result.outcome === "completed" ? { deliveryBlockingFindings: [], deliveryRepairPlan: null } : {}) });
    }
    state = IssueWorkflowStateSchema.parse({ ...state, allowedCommands: addRevisionCommand(state.allowedCommands), ...recoveryFields("active", null, "Developer repair result claimed.", null), activeOperation: null });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "repair_required" && state.phase !== "delivery_blocked") throw new Error("Delivery repair is not available in the current phase");
    if (!state.deliveryReviewId || (!state.deliveryReviewArtifact && ((!state.deliveryRepairPlan && !state.deliveryRepairPlanArtifactId) || !(state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open")))) throw new Error("Open blocking findings and a bounded repair plan are required");
    if (state.phase === "delivery_blocked" && !state.deliveryRepairBlockerCode) throw new Error("A repair blocker is required before retrying delivery repair");
    if ((state.repairCycle ?? 0) >= validatedInput.repairCycleLimit) throw new Error("Delivery repair limit is exhausted");
    if (!state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.leadSessionRef) throw new Error("The prior Developer delivery must be preserved before repair");
  } });
  setHandler(recordDeliveryDecisionUpdate, async (rawInput) => {
    assertPayloadWithinLimit("delivery decision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    const decision = await recordDeliveryDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, actorUserId: command.actorUserId, note: command.note?.trim() || "Member decision recorded for blocked delivery" });
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: [], pendingAction: "Member decision recorded", lastEventId: `${state.workflowId}:${state.revision + 1}`, deliveryDecisionArtifactId: decision.artifactId, blocker: null, stateChangedAt: new Date().toISOString() });
    if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "delivery_blocked" || !state.allowedCommands.includes("record_delivery_decision")) throw new Error("A member decision is not available in the current phase");
  } });
  const runFinalReviewTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.releaseId || !state.deliveryReviewId || !state.ciRunId || !state.leadSessionRef || !state.leadOutputArtifactId || !state.developerExecutionId || !state.deliveryArtifactId || !state.developerEvidenceArtifactId || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("Exact release, pull request, delivery review, CI, Lead, and Developer evidence is required for final review");
    if (!(await runTargetBaseCheckpoint("pre_final_review"))) return state;
    let result;
    try {
      result = await acquireExternalTurn<FinalReviewActivityResult>(
        { operation: "final_review", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => finalReview({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, roleProfiles: validatedInput.roleProfiles, releaseId: state.releaseId!, deliveryReviewId: state.deliveryReviewId!, ciRunId: state.ciRunId!, ...(state.releaseRepository && state.baseBranch && state.pullRequestNumber ? { pullRequestNumber: state.pullRequestNumber, repository: state.releaseRepository, baseBranch: state.baseBranch } : {}), planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, developerExecutionId: state.developerExecutionId!, deliveryArtifactId: state.deliveryArtifactId!, evidenceArtifactId: state.developerEvidenceArtifactId!, ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}), branchName: state.branchName!, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (review) => review.leadExecutionId,
      );
    } catch (error) {
      const failure = permanentActivityFailure(error);
      const summary = failure?.summary ?? "Final review is temporarily unavailable; retry the exact review or request changes";
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["final_review", "request_delivery_changes", "cancel_issue"], pendingAction: summary, finalReviewFailureCode: "final_review_unavailable", blocker: failure?.category ? humanBlocker(failure.category, summary, [{ command: "final_review", label: "Retry final review", requiresNote: false, destructive: false }, { command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    let repairPlan = result.outcome === "blocking" ? {
      planArtifactId: result.repairPlanArtifactId,
      planSha256: result.repairPlanSha256,
      findings: result.findings,
    } : undefined;
    if (result.outcome === "blocking") {
      try {
        const planned = await acquireExternalTurn<DeliveryRepairPlanResult>(
          { operation: "delivery_repair_plan", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
          (capacityRequestId) => planDeliveryRepair({
          taskId: validatedInput.issueId,
          companyId: validatedInput.companyId,
          workflowId: validatedInput.workflowId,
          projectId: validatedInput.projectId,
          projectRevisionId: validatedInput.projectRevisionId,
          source: "final_review_blocking",
          leadSessionRef: state.leadSessionRef!,
          planRevision: state.planRevision ?? state.revision,
          releaseId: state.releaseId,
          deliveryReviewId: state.deliveryReviewId,
          finalReviewId: result.finalReviewId,
          ciRunId: state.ciRunId,
          evidenceArtifactIds: [result.evidenceArtifactId, result.opinionArtifactId],
          branchName: state.branchName!,
          worktreePath: state.worktreePath ?? ".",
          targetBaseSha: state.targetBaseSha!,
          subjectCommit: state.resultCommit!,
          subjectTree: state.resultTree!,
          findings: result.findings,
          ...(capacityRequestId ? { capacityRequestId } : {}),
          }),
          (plan) => plan.leadExecutionId,
        );
        repairPlan = { planArtifactId: planned.planArtifactId, planSha256: planned.planSha256, findings: planned.findings };
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["record_delivery_decision", "cancel_issue"], pendingAction: "Final-review repair planning failed; inspect the recorded evidence", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, finalReviewSummary: result.summary, finalReviewOpinionArtifactId: result.opinionArtifactId, finalReviewEvidenceArtifactId: result.evidenceArtifactId, finalReviewFindings: result.findings, blocker: humanBlocker("agent_exhausted", result.summary, [{ command: "record_delivery_decision", label: "Record delivery decision", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.reviewArtifact.artifactId, result.reviewArtifact.sha256, "delivery-review")), stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
    }
    const nextPhase = result.outcome === "approved" ? "accepted" : "repair_required";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: result.outcome === "approved" ? "human" : "lead", allowedCommands: result.outcome === "approved" ? ["accept_delivery", "request_delivery_changes", "cancel_issue"] : ["repair_delivery", "cancel_issue"], pendingAction: result.outcome === "approved" ? "Member acceptance required" : "Lead repair plan required", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, finalReviewSummary: result.summary, finalReviewOpinionArtifactId: result.opinionArtifactId, finalReviewEvidenceArtifactId: result.evidenceArtifactId, finalReviewFailureCode: null, finalReviewFindings: result.findings, finalReviewRepairPlanArtifactId: repairPlan?.planArtifactId ?? null, finalReviewRepairPlanSha256: repairPlan?.planSha256 ?? null, deliveryBlockingFindings: result.outcome === "blocking" ? repairPlan?.findings ?? result.findings : state.deliveryBlockingFindings, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan?.planArtifactId ?? null, deliveryRepairPlanSha256: repairPlan?.planSha256 ?? null, deliveryRepairAuthority: result.outcome === "blocking" ? "final_review" : null, blocker: result.outcome === "approved" ? humanBlocker("member_authorization", "Final delivery approval is required.", [{ command: "accept_delivery", label: "Accept delivery", requiresNote: false, destructive: false }, { command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }], evidencePointer(result.reviewArtifact.artifactId, result.reviewArtifact.sha256, "delivery-review")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  const runExactCiRepairTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.ciRepairPlanId || !state.ciRepairPlanArtifactId || !state.ciRepairPlanEvidenceArtifactId || !state.ciAttemptId || !state.ciRunId || !state.expectedHeadSha || !state.resultCommit || !state.resultTree || !state.developerExecutionId || !state.developerSessionRef || !state.branchName) throw new Error("The exact CI repair plan and prior Developer delivery are required");
    const ciRunId = state.ciRunId;
    const ciAttemptId = state.ciAttemptId;
    const repairPlanId = state.ciRepairPlanId;
    const repairPlanArtifactId = state.ciRepairPlanArtifactId;
    const repairPlanEvidenceArtifactId = state.ciRepairPlanEvidenceArtifactId;
    const failedHeadSha = state.expectedHeadSha;
    const priorDeveloperExecutionId = state.developerExecutionId;
    const priorDeveloperSessionRef = state.developerSessionRef;
    const branchName = state.branchName;
    const priorCommit = state.resultCommit;
    const priorTree = state.resultTree;
    const releaseId = state.releaseId;
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repairing", owner: "lead", allowedCommands: [], pendingAction: "Developer repairing the exact failed CI result", blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    try {
      const result = await acquireExternalTurn<WorkflowCiRepairActivityResult>(
        { operation: "ci_repair_execution", role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: priorDeveloperSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => runCiRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, ...(releaseId ? { releaseId } : {}), projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, ciRunId, ciAttemptId, repairPlanId, repairPlanArtifactId, repairPlanEvidenceArtifactId, failedHeadSha, priorDeveloperExecutionId, priorDeveloperSessionRef, branchName, priorCommit, priorTree, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (repair) => repair.developerExecutionId,
      );
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? addRevisionCommand(["review_delivery", "cancel_issue"]) : addRevisionCommand(["request_delivery_changes", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required after CI repair" : "CI repair is blocked", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.outcome === "completed" ? "clean" : "dirty", deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.summary, developerOutcome: result.outcome === "completed" ? "completed" : "blocked", deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId, releaseId: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, ciRepairDeveloperExecutionId: result.developerExecutionId, ciRepairDeveloperSessionRef: result.developerSessionRef, blocker: result.outcome === "blocked" ? humanBlocker("verification_unrecoverable", result.summary, [{ command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.attentionEvidenceArtifactId, result.attentionEvidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    } catch (error) {
      const failure = permanentActivityFailure(error);
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_required", owner: "human", allowedCommands: addRevisionCommand(["repair_ci", "cancel_issue"]), pendingAction: failure?.summary ?? "CI repair failed; retry the same exact repair", blocker: failure?.category ? humanBlocker(failure.category, failure.summary, [{ command: "repair_ci", label: "Retry CI repair", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    }
    await projectIssueState(state);
    return state;
  };
  const reconcileCiTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.releaseId || !state.expectedHeadSha) throw new Error("Exact release head is required for CI reconciliation");
    const attempt = (state.ciAttempt ?? 0) + 1;
    const expectedReleaseId = state.releaseId;
    const expectedHeadSha = state.expectedHeadSha;
    const expectedRevision = state.revision;
    let result;
    try {
      result = await reconcileCi({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, releaseId: state.releaseId, expectedHeadSha: state.expectedHeadSha, attemptNumber: attempt });
    } catch (error) {
      if (state.phase !== "ci_waiting" || state.revision !== expectedRevision || state.releaseId !== expectedReleaseId || state.expectedHeadSha !== expectedHeadSha) return state;
      const failure = permanentActivityFailure(error);
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ciAttempt: attempt, ciOutcome: "provider_unavailable", ciReason: "provider_failure_budget_exhausted", ciOwner: "human", ciRepairable: false, ciNextPollAt: null, phase: "delivery_blocked", owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], pendingAction: failure?.summary ?? "CI provider reconciliation failed", blocker: failure?.category ? humanBlocker(failure.category, failure.summary, [{ command: "reconcile_ci", label: "Retry CI reconciliation", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (state.phase !== "ci_waiting" || state.revision !== expectedRevision || state.releaseId !== expectedReleaseId || state.expectedHeadSha !== expectedHeadSha) return state;
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ciAttempt: result.attemptNumber, ciAttemptId: result.attemptId, ciRunId: result.runId, ciOutcome: result.outcome, ciReason: result.reason, ciOwner: result.owner, ciRepairable: result.repairable, ciEvidenceArtifactId: result.evidenceArtifactId, ciPolicyHash: result.policyHash, ciPropagationDeadline: result.propagationDeadline, ciOverallDeadline: result.overallDeadline, ciNextPollAt: result.nextPollAt, pendingAction: result.outcome === "waiting" || result.outcome === "rate_limited" ? "Waiting for required CI" : result.summary, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    if (result.outcome === "passed") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "final_review", owner: "lead", allowedCommands: [], pendingAction: "Final Lead review", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return runFinalReviewTurn();
    }
    if (result.outcome === "failed" && result.repairable && result.owner === "lead" && result.evidenceArtifactId && state.leadSessionRef && state.ciAttemptId) {
      const leadSessionRef = state.leadSessionRef;
      const ciAttemptId = state.ciAttemptId;
      const evidenceArtifactId = result.evidenceArtifactId;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_planning", owner: "lead", allowedCommands: [], pendingAction: "Lead diagnosis of exact-head CI failure", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await acquireExternalTurn<CiRepairPlanActivityResult>(
          { operation: "ci_repair_plan", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: leadSessionRef },
          (capacityRequestId) => planCiRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, leadSessionRef, ciRunId: result.runId, ciAttemptId, failedHeadSha: expectedHeadSha, evidenceArtifactId, requiredChecks: [], localVerification: [], ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (repairPlan) => repairPlan.leadExecutionId,
        );
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_repair_required", owner: "lead", allowedCommands: [], pendingAction: "Developer repairing the exact failed CI result", ciRepairPlanId: plan.planId, ciRepairPlanArtifactId: plan.planArtifactId, ciRepairPlanEvidenceArtifactId: plan.evidenceArtifactId, ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return runExactCiRepairTurn();
      } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(["request_delivery_changes", "cancel_issue"]), pendingAction: "Lead CI repair planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      await projectIssueState(state);
    } else if (!(result.owner === "system" && result.retryAt)) {
      const category: IssueBlocker["category"] = result.outcome === "provider_unavailable" ? "provider_connectivity_exhausted" : result.outcome === "stale_head" ? "target_drift" : "verification_unrecoverable";
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(["reconcile_ci", "cancel_issue"]), pendingAction: result.summary, blocker: humanBlocker(category, result.summary, [{ command: "reconcile_ci", label: "Retry CI reconciliation", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(result.evidenceArtifactId ?? undefined, result.evidenceArtifactSha256, "ci-evidence")), stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    }
    return state;
  };
  const reconcileMergeTurn = async (): Promise<IssueWorkflowState> => {
    const exactAcceptanceReceipts = patched(exactAcceptanceReceiptPatch);
    if (!state.releaseId || !state.expectedHeadSha || !state.acceptanceId) throw new Error("Exact accepted release head is required for merge reconciliation");
    const attempt = (state.mergeAttempt ?? 0) + 1;
    if (attempt > MAX_RECONCILIATION_ATTEMPTS) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "reconcile_merge", "cancel_issue"], pendingAction: "Merge reconciliation retry limit exhausted", mergeAttempt: attempt, mergeBlockerCode: "merge_reconciliation_exhausted", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    let result;
    try {
      result = await reconcileMerge({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, acceptanceId: state.acceptanceId });
    } catch {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "manual_merge", owner: "human", allowedCommands: ["reconcile_merge", "cancel_issue"], pendingAction: "GitHub merge state is temporarily unavailable", mergeAttempt: attempt, mergeOutcome: "provider_unavailable", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (exactAcceptanceReceipts && result.outcome === "merged" && (!result.mergeObservationId || !result.completionReceiptId || !result.mergedAt)) throw new Error("Merged reconciliation requires an immutable observation and completion receipt");
    const nextPhase = result.outcome === "merged" ? "done" : result.outcome === "open" || result.outcome === "provider_unavailable" ? "manual_merge" : "delivery_blocked";
    if (!exactAcceptanceReceipts) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "reconcile_merge", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "done" ? "Merged pull request confirmed" : "Pull request changed or closed without merge", mergeOutcome: result.outcome, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "reconcile_merge", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "done" ? "Merged pull request confirmed" : "Pull request changed or closed without merge", mergeAttempt: attempt, mergeOutcome: result.outcome, mergeObservationId: result.mergeObservationId, completionReceiptId: result.completionReceiptId, mergeRetryAt: result.retryAt, mergeBlockerCode: result.blockerCode ?? null, mergeBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, pullRequestNumber: result.pullRequestNumber || state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || state.pullRequestUrl, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  const runPublishTurn = async (): Promise<IssueWorkflowState> => {
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "releasing", owner: "lead", allowedCommands: [], pendingAction: "Publishing one exact draft pull request", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    if (!state.deliveryReviewId || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree) throw new Error("Approved exact delivery is required before publishing");
    if (!(await runTargetBaseCheckpoint("pre_release"))) return state;
    const typedReleaseResult = patched(typedReleaseResultPatch);
    const publishInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, reviewId: state.deliveryReviewId, developerExecutionId: state.developerExecutionId!, branchName: state.branchName, targetBaseSha: state.targetBaseSha, subjectCommit: state.resultCommit, subjectTree: state.resultTree, ...(state.releaseId ? { releaseId: state.releaseId } : {}) };
    const rawResult = await publishRelease((typedReleaseResult ? publishInput : { ...publishInput, planSummary: state.leadSummary ?? "Approved Forge plan", deliverySummary: state.deliverySummary ?? "Exact Developer delivery", verificationSummary: "Lead delivery review approved", ...(state.pullRequestNumber ? { expectedPullRequestNumber: state.pullRequestNumber } : {}) }) as PublishReleaseActivityInput);
    let result: PublishReleaseActivityResult = rawResult;
    if (!typedReleaseResult) {
      const legacy = rawResult as unknown as Omit<PublishReleaseActivityResult, "outcome" | "attempt"> & { baseDriftMerged?: boolean; baseDriftConflict?: boolean };
      result = { ...legacy, outcome: legacy.baseDriftConflict ? "base-drift-conflict" : legacy.baseDriftMerged ? "base-drift-merged" : "completed", attempt: 0 } as PublishReleaseActivityResult;
    }
    if (result.outcome === "blocked") {
      if (result.code === "stale-reviewed-revision") {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Fresh Lead review required for the exact Developer revision", deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseStatus: "blocked", releaseFailureCode: result.code, releaseFailureSummary: result.summary, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
      const retryable = isRetryableReleaseFailure(result.code);
      const waitingForRateLimit = result.code === "provider-rate-limited" && result.retryAt !== null;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: waitingForRateLimit ? "releasing" : "delivery_blocked", owner: waitingForRateLimit ? "lead" : "human", allowedCommands: waitingForRateLimit ? ["cancel_issue"] : [...(retryable ? ["publish_draft"] : []), "cancel_issue"], pendingAction: waitingForRateLimit ? "Waiting for GitHub rate-limit reset" : result.summary ?? "Release provider reconciliation requires attention", releaseStatus: waitingForRateLimit ? "reconciling" : "blocked", releaseFailureCode: result.code ?? "provider-unavailable", releaseFailureSummary: result.summary ?? "Release provider reconciliation requires attention", releaseRetryAt: result.retryAt ?? null, releaseOperationAttempt: result.attempt, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (result.outcome === "base-drift-conflict") {
      const legacyConflict = !patched(artifactBackedConflictPatch);
      if (!legacyConflict && !result.mergeConflictEvidence) throw ApplicationFailure.nonRetryable("Merge-conflict evidence is missing", "merge_conflict_evidence_missing");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: [], pendingAction: "Lead conflict-resolution plan", targetBaseSha: result.targetBaseSha ?? state.targetBaseSha, forwardMergeId: result.forwardMergeId ?? null, forwardMergePriorHead: result.priorHead ?? state.resultCommit, forwardMergeTargetBaseSha: result.targetBaseSha ?? state.targetBaseSha, ...(result.mergeConflictEvidence ? { mergeConflictEvidence: result.mergeConflictEvidence } : {}), ...(legacyConflict ? { forwardMergeConflictFiles: result.conflictFiles ?? [], forwardMergeConflictDiff: result.conflictDiff ?? null } : {}), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const plan = await acquireExternalTurn<MergeConflictPlanActivityResult>(
          { operation: "merge_conflict_plan", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
          (capacityRequestId) => {
            const legacyPlanInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, branchName: state.branchName!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, ...(state.mergeConflictEvidence ? { conflictEvidence: state.mergeConflictEvidence } : { conflictFiles: state.forwardMergeConflictFiles ?? [], conflictDiff: state.forwardMergeConflictDiff ?? "" }), ...(state.forwardMergeId ? { forwardMergeId: state.forwardMergeId } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) } as unknown as Parameters<typeof planMergeConflict>[0];
            return planMergeConflict(legacyPlanInput);
          },
          (result) => result.leadExecutionId,
        );
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Lead conflict-resolution planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      if (legacyConflict) continuationRequested = true;
      await projectIssueState(state);
      return state;
    }
    if (result.outcome === "base-drift-merged") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: addRevisionCommand(["review_delivery"]), pendingAction: "Fresh Lead review required after target-base forward merge", targetBaseSha: result.targetBaseSha ?? state.targetBaseSha, resultCommit: result.headSha, resultTree: result.headTree, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, acceptanceId: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    if (result.outcome !== "completed" || !result.releaseId || result.pullRequestNumber === null || result.pullRequestUrl === null) throw new Error("Release completion result is incomplete");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Waiting for required CI", releaseStatus: "draft", releaseFailureCode: null, releaseFailureSummary: null, releaseRetryAt: null, releaseOperationAttempt: result.attempt, releaseId: result.releaseId, releaseRepository: result.repository, baseBranch: result.baseBranch, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, expectedHeadSha: result.headSha, expectedHeadTree: result.headTree, ciAttempt: 0, ciOutcome: "waiting", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  setHandler(publishDraftUpdate, async (rawInput) => {
    StartPlanningInputSchema.parse(rawInput);
    return runPublishTurn();
  }, { validator(rawInput) { const command = StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision"); if (!(state.phase === "delivery_reviewed" || (state.phase === "delivery_blocked" && state.releaseStatus === "blocked" && state.allowedCommands.includes("publish_draft"))) || !state.deliveryReviewId) throw new Error("Draft publication is not available in the current phase"); } });
  setHandler(resolveMergeConflictUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "merge_conflict_required") throw new Error("Merge-conflict resolution is not available in the current phase");
    if (!state.mergeResolutionPlanArtifactId || !state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.forwardMergeId || !state.forwardMergePriorHead || !state.forwardMergePriorTree || !state.forwardMergeTargetBaseSha || !state.forwardMergeConflictArtifact || typeof state.forwardMergeConflictFileCount !== "number" || !state.targetBaseSha) throw new Error("A Lead conflict plan and owned Developer worktree are required");
    const planRevision = state.planRevision ?? state.revision;
    const developerAttempt = (state.developerAttempt ?? 0) + 1;
    const turnExecutionId = developerExecutionId(state.workflowId, planRevision, developerAttempt, "merge_conflict_resolution");
    const prior = { forwardMergeId: state.forwardMergeId, developerExecutionId: state.developerExecutionId, developerSessionRef: state.developerSessionRef, branchName: state.branchName, priorHead: state.forwardMergePriorHead, priorTree: state.forwardMergePriorTree, targetBaseSha: state.forwardMergeTargetBaseSha, expectedBaseSha: state.targetBaseSha, conflictArtifact: state.forwardMergeConflictArtifact, conflictFileCount: state.forwardMergeConflictFileCount, planArtifactId: state.mergeResolutionPlanArtifactId };
    await withStateMutation(() => {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_resolving", owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer resolving forward-merge conflicts", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: supervisedDeveloperTurns ? turnExecutionId : state.developerExecutionId, developerAttempt, developerTurnKind: "merge_conflict_resolution", ...recoveryFields("starting", null, "Starting Developer merge-conflict resolution.", null), activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: state.revision + 1 } });
    });
    await projectIssueState(state);
    try {
      const mergeInput = { taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision, ...prior };
      const outcome = await acquireExternalTurn(
        { operation: "merge_conflict_resolution", role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: prior.developerSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => supervisedDeveloperTurns
          ? resolveMergeConflictSupervised({ ...mergeInput, developerTurnExecutionId: turnExecutionId, developerAttempt, turnKind: "merge_conflict_resolution", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : resolveMergeConflict({ ...mergeInput, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
      if (outcome.status !== "completed") {
        const applied = await withStateMutation(() => {
          if (state.activeOperation?.commandId !== command.commandId) return false;
          const allowedCommands = outcome.status === "ownership_ambiguous" ? ["verify_developer_ownership", "cancel_issue"] as const : ["resolve_merge_conflict", "cancel_issue"] as const;
          state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands, pendingAction: outcome.summary, ...recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : state.developerEvidenceArtifactId, activeOperation: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
          return true;
        });
        if (applied) await projectIssueState(state);
        return state;
      }
      const result = outcome.result;
      await withStateMutation(() => {
        if (state.activeOperation?.commandId !== command.commandId) return;
        if ("outcome" in result && result.outcome === "verification_blocked") {
          state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: result.summary, targetBaseOutcome: "blocked", targetBaseBlockerCode: result.code, targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", developerEvidenceArtifactId: result.verificationArtifact.id, developerOutcome: "blocked", ...recoveryFields("active", null, "Developer merge result claimed; verification is blocked.", null), activeOperation: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
          return;
        }
        const successfulResult = result as Extract<typeof result, { deliveryArtifactId: string }>;
        state = applyTargetBaseRevalidation(state, { outcome: "revalidated", checkId: prior.forwardMergeId, checkpoint: state.targetBaseCheckpoint ?? "pre_release", expectedBaseSha: prior.expectedBaseSha, observedBaseSha: prior.targetBaseSha, priorHead: prior.priorHead, priorTree: prior.priorTree, headSha: successfulResult.resultCommit, headTree: successfulResult.resultTree, developerExecutionId: successfulResult.developerExecutionId, deliveryArtifact: { id: successfulResult.deliveryArtifactId, sha256: successfulResult.deliveryArtifactSha256, kind: "forward-merge-delivery" }, verificationArtifact: { id: successfulResult.verificationArtifactId, sha256: successfulResult.verificationArtifactSha256, kind: "forward-merge-verification" } });
        state = IssueWorkflowStateSchema.parse({ ...state, developerSessionRef: successfulResult.developerSessionRef, deliverySummary: successfulResult.summary, developerEvidenceArtifactId: successfulResult.verificationArtifactId, mergeResolutionDeveloperExecutionId: successfulResult.developerExecutionId, mergeResolutionDeveloperSessionRef: successfulResult.developerSessionRef, ...recoveryFields("active", null, "Developer merge-conflict result claimed.", null), activeOperation: null });
      });
    } catch {
      await withStateMutation(() => {
        if (state.activeOperation?.commandId !== command.commandId) return;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution is incomplete; retry the same owned turn", activeOperation: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      });
    }
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "merge_conflict_required" || !state.allowedCommands.includes("resolve_merge_conflict")) throw new Error("Merge-conflict resolution is not available in the current phase");
  } });
  const retryTargetBase = async (rawInput: StartPlanningInput, verificationOnly: boolean): Promise<IssueWorkflowState> => {
    const command = StartPlanningInputSchema.parse(rawInput);
    const checkpoint = state.targetBaseCheckpoint;
    if (command.expectedRevision !== state.revision || state.phase !== "delivery_blocked" || !checkpoint) throw new Error("Target-base reconciliation retry is not available in the current phase");
    if (verificationOnly && !["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(state.targetBaseBlockerCode ?? "")) throw new Error("Verification retry is not available for the current blocker");
    if (!verificationOnly && !state.targetBaseBlockerRetryable) throw new Error("Target-base reconciliation is not retryable");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: verificationOnly ? "Retrying pinned forward-merge verification" : "Retrying target-base reconciliation", lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    await runTargetBaseCheckpoint(checkpoint, verificationOnly);
    void command;
    return state;
  };
  setHandler(retryTargetBaseReconciliationUpdate, (rawInput) => retryTargetBase(rawInput, false));
  setHandler(retryForwardMergeVerificationUpdate, (rawInput) => retryTargetBase(rawInput, true));
  setHandler(reconcileCIUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || !["ci_waiting", "delivery_blocked"].includes(state.phase) || !state.allowedCommands.includes("reconcile_ci")) throw new Error("CI reconciliation is not available in the current phase");
    if (state.phase === "delivery_blocked") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Retrying CI reconciliation", ciNextPollAt: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
    }
    return reconcileCiTurn();
  });
  setHandler(repairCIUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "ci_repair_required") throw new Error("CI repair is not available in the current phase");
    if (state.ciRepairPlanId && state.ciRepairPlanArtifactId && state.ciRepairPlanEvidenceArtifactId && state.ciAttemptId && state.ciRunId && state.expectedHeadSha && state.resultCommit && state.resultTree && state.developerExecutionId && state.developerSessionRef && state.branchName) return runExactCiRepairTurn();
    if (!state.deliveryReviewId || !state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.leadSessionRef) throw new Error("The exact prior Developer delivery is required for CI repair");
    const cycle = (state.repairCycle ?? 0) + 1;
    if (cycle > validatedInput.repairCycleLimit) throw new Error("CI repair limit is exhausted");
    const priorDelivery = { leadSessionRef: state.leadSessionRef!, developerSessionRef: state.developerSessionRef!, developerExecutionId: state.developerExecutionId!, reviewId: state.deliveryReviewId!, worktreePath: state.worktreePath!, branchName: state.branchName!, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, ciOutcome: state.ciOutcome };
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer CI repair cycle ${cycle}`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    const ciFindings = (state.deliveryBlockingFindings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    const repairFindings = ciFindings.length ? ciFindings : [{ findingId: `ci_failure_${state.revision}`, severity: "blocking" as const, rationale: `Required CI did not pass: ${priorDelivery.ciOutcome ?? "failed"}`, evidenceRef: state.ciRunId ?? "CI reconciliation", disposition: "open" as const, repairInstruction: "Resolve the exact-head CI failure and rerun the required checks." }];
    const repairPlan = await acquireExternalTurn<DeliveryRepairPlanResult>(
      { operation: "delivery_repair_plan", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: priorDelivery.leadSessionRef, worktreePath: priorDelivery.worktreePath },
      (capacityRequestId) => planDeliveryRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, source: "ci_failure", leadSessionRef: priorDelivery.leadSessionRef, planRevision: state.planRevision ?? state.revision, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId, ciRunId: state.ciRunId, evidenceArtifactIds: [state.developerEvidenceArtifactId, state.finalReviewEvidenceArtifactId].filter((id): id is string => Boolean(id)), branchName: priorDelivery.branchName, worktreePath: priorDelivery.worktreePath, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, findings: repairFindings, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (plan) => plan.leadExecutionId,
    );
    const result = await acquireExternalTurn<WorkflowDeveloperRepairResult>(
      { operation: "developer_repair", role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: priorDelivery.developerSessionRef, worktreePath: priorDelivery.worktreePath },
      (capacityRequestId) => runDeveloperRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: priorDelivery.leadSessionRef, developerSessionRef: priorDelivery.developerSessionRef, developerExecutionId: priorDelivery.developerExecutionId, reviewId: priorDelivery.reviewId, repairAuthority: "ci_failure", cycle, repairCycleLimit: validatedInput.repairCycleLimit, worktreePath: priorDelivery.worktreePath, branchName: priorDelivery.branchName, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, blockingFindings: repairFindings, repairPlanArtifactId: repairPlan.planArtifactId, repairPlanSha256: repairPlan.planSha256, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (repair) => repair.developerExecutionId,
    );
    const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required" : "Member decision required", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: state.worktreePath, branchName: result.branchName, targetBaseSha: result.subject.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.outcome === "completed" ? result.deliveryArtifactId : state.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.outcome === "completed" ? result.summary : state.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, activeOperation: null, deliveryReviewId: result.outcome === "completed" ? null : state.deliveryReviewId, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan.planArtifactId, deliveryRepairPlanSha256: repairPlan.planSha256, deliveryRepairAuthority: result.outcome === "completed" ? null : "ci_failure", releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) { const command = StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision"); if (state.phase !== "ci_repair_required" || !state.developerExecutionId) throw new Error("CI repair is not available in the current phase"); } });
  setHandler(finalReviewUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || (state.phase !== "final_review" && !(state.phase === "delivery_blocked" && state.finalReviewFailureCode === "final_review_unavailable"))) throw new Error("Final review is not available in the current phase");
    return runFinalReviewTurn();
  });
  const accept = async (rawInput: PlanCommandInput, decision: "accept" | "request_changes"): Promise<IssueWorkflowState> => {
    const command = PlanCommandInputSchema.parse(rawInput);
    const exactAcceptanceReceipts = patched(exactAcceptanceReceiptPatch);
    const requestChangesFromBlockingReview = decision === "request_changes" && state.phase === "repair_required" && state.finalReviewOutcome === "blocking";
    const preIntentProviderRetry = decision === "accept" && state.phase === "delivery_blocked" && (state.acceptanceId ?? null) === null && state.acceptanceBlockerCode === "provider_unavailable" && state.allowedCommands.includes("accept_delivery");
    if (command.expectedRevision !== state.revision || (decision === "accept" ? state.phase !== "accepted" && !preIntentProviderRetry : state.phase !== "accepted" && !requestChangesFromBlockingReview)) throw new Error("Delivery acceptance is not available in the current phase");
    if (!state.releaseId || !state.finalReviewId || !state.ciRunId || !state.expectedHeadSha || !state.expectedHeadTree) throw new Error("Exact final review, CI, release, and pinned GitHub evidence is required for acceptance");
    if (exactAcceptanceReceipts && (!state.deliveryReviewId || !state.pullRequestNumber || !state.releaseRepository || !state.baseBranch || !state.targetBaseSha || !state.leadSessionRef)) throw new Error("Exact final review, CI, release, and pinned GitHub evidence is required for acceptance");
    if (!(await runTargetBaseCheckpoint("pre_acceptance"))) return state;
    const result = exactAcceptanceReceipts
      ? await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId!, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, pullRequestNumber: state.pullRequestNumber!, repository: state.releaseRepository!, baseBranch: state.baseBranch!, baseSha: state.targetBaseSha!, leadSessionRef: state.leadSessionRef!, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision, ...(command.note !== undefined ? { note: command.note } : {}) })
      : await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, releaseId: state.releaseId, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision } as unknown as AcceptDeliveryActivityInput);
    if (!exactAcceptanceReceipts) {
      const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "requested_changes" ? "repair_required" : "cancelled";
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "repair_required" ? "Lead repair plan required" : "Issue cancelled", acceptanceId: result.acceptanceId, acceptedHeadSha: result.status === "accepted" ? state.expectedHeadSha : null, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    let memberRepairPlan: { planArtifactId: string; planSha256: string; findings: typeof state.deliveryBlockingFindings } | undefined;
    if (decision === "request_changes" && result.status === "requested_changes") {
      const note = command.note?.trim() || "Member requested changes to the exact delivery";
      const finding = { findingId: `member_requested_changes_${state.revision}`, severity: "blocking" as const, rationale: note, evidenceRef: result.reasonArtifactId ?? "member acceptance decision", disposition: "open" as const, repairInstruction: note };
      try {
        const planned = await acquireExternalTurn<DeliveryRepairPlanResult>(
          { operation: "delivery_repair_plan", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
          (capacityRequestId) => planDeliveryRepair({
          taskId: validatedInput.issueId,
          companyId: validatedInput.companyId,
          workflowId: validatedInput.workflowId,
          projectId: validatedInput.projectId,
          projectRevisionId: validatedInput.projectRevisionId,
          source: "member_requested_changes",
          leadSessionRef: state.leadSessionRef!,
          planRevision: state.planRevision ?? state.revision,
          releaseId: state.releaseId,
          deliveryReviewId: state.deliveryReviewId,
          finalReviewId: state.finalReviewId,
          ciRunId: state.ciRunId,
          acceptanceId: result.acceptanceId,
          reasonArtifactId: result.reasonArtifactId ?? null,
          evidenceArtifactIds: [state.finalReviewEvidenceArtifactId, state.finalReviewOpinionArtifactId, ...(result.reasonArtifactId ? [result.reasonArtifactId] : [])].filter((id): id is string => Boolean(id)),
          branchName: state.branchName ?? "delivery",
          worktreePath: state.worktreePath ?? ".",
          targetBaseSha: state.targetBaseSha!,
          subjectCommit: state.expectedHeadSha!,
          subjectTree: state.expectedHeadTree!,
          findings: [finding],
          ...(capacityRequestId ? { capacityRequestId } : {}),
          }),
          (plan) => plan.leadExecutionId,
        );
        memberRepairPlan = planned;
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Member-requested repair planning failed; inspect the recorded evidence", acceptanceId: result.acceptanceId, acceptanceStatus: result.status, acceptanceReasonArtifactId: result.reasonArtifactId ?? null, acceptanceBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
    }
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "pending_ready" ? "ready_reconciliation" : result.status === "requested_changes" ? "repair_required" : result.status === "blocked" ? "delivery_blocked" : "cancelled";
    const preIntentProviderFailure = result.status === "blocked" && result.acceptanceId === null && result.outcome === "provider_unavailable";
    const clearReviewAuthority = decision === "request_changes" && result.status === "requested_changes" && memberRepairPlan ? { releaseId: null, releaseRepository: null, baseBranch: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciAttempt: 0, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, finalReviewSummary: null, finalReviewOpinionArtifactId: null, finalReviewEvidenceArtifactId: null, finalReviewFailureCode: null, finalReviewFindings: [], finalReviewRepairPlanArtifactId: null, finalReviewRepairPlanSha256: null, acceptanceId: null, acceptanceStatus: null, acceptanceAttempt: 0, acceptanceRetryAt: null, acceptanceBlockerCode: null, acceptanceBlockerEvidenceArtifactId: null, acceptanceReasonArtifactId: null, acceptedAt: null, readyAt: null, acceptedHeadSha: null, mergeAttempt: 0, mergeRetryAt: null, mergeObservationId: null, mergeBlockerCode: null, mergeBlockerEvidenceArtifactId: null, completionReceiptId: null, mergeOutcome: null, deliveryRepairAuthority: "member_requested_changes" as const } : {};
    state = IssueWorkflowStateSchema.parse({ ...state, ...clearReviewAuthority, revision: state.revision + 1, phase: nextPhase, owner: nextPhase === "repair_required" ? "lead" : "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ready_reconciliation" ? ["reconcile_acceptance", "cancel_issue"] : nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextPhase === "delivery_blocked" ? (preIntentProviderFailure ? ["accept_delivery", "cancel_issue"] : result.acceptanceId ? ["reconcile_merge", "request_delivery_changes", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"]) : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ready_reconciliation" ? "Reconciling ready-for-review" : nextPhase === "repair_required" ? "Lead repair plan required" : nextPhase === "delivery_blocked" ? (preIntentProviderFailure ? "GitHub acceptance evidence unavailable; retry acceptance" : result.blockerSummary ?? "Delivery is blocked") : "Issue cancelled", acceptanceId: clearReviewAuthority.acceptanceId !== undefined ? clearReviewAuthority.acceptanceId : result.acceptanceId, acceptanceStatus: clearReviewAuthority.acceptanceStatus !== undefined ? clearReviewAuthority.acceptanceStatus : result.status, acceptanceAttempt: clearReviewAuthority.acceptanceAttempt !== undefined ? clearReviewAuthority.acceptanceAttempt : (state.acceptanceAttempt ?? 0) + 1, acceptanceRetryAt: clearReviewAuthority.acceptanceRetryAt !== undefined ? clearReviewAuthority.acceptanceRetryAt : result.retryAt ?? null, acceptanceBlockerCode: clearReviewAuthority.acceptanceBlockerCode !== undefined ? clearReviewAuthority.acceptanceBlockerCode : result.blockerCode ?? null, acceptanceBlockerEvidenceArtifactId: clearReviewAuthority.acceptanceBlockerEvidenceArtifactId !== undefined ? clearReviewAuthority.acceptanceBlockerEvidenceArtifactId : result.evidenceArtifactId ?? null, acceptanceReasonArtifactId: clearReviewAuthority.acceptanceReasonArtifactId !== undefined ? clearReviewAuthority.acceptanceReasonArtifactId : result.reasonArtifactId ?? state.acceptanceReasonArtifactId ?? null, acceptedAt: clearReviewAuthority.acceptedAt !== undefined ? clearReviewAuthority.acceptedAt : (decision === "accept" && exactAcceptanceReceipts ? result.acceptedAt ?? null : null), readyAt: clearReviewAuthority.readyAt !== undefined ? clearReviewAuthority.readyAt : result.readyAt ?? null, acceptedHeadSha: clearReviewAuthority.acceptedHeadSha !== undefined ? clearReviewAuthority.acceptedHeadSha : (decision === "accept" ? state.expectedHeadSha : null), pullRequestNumber: clearReviewAuthority.pullRequestNumber !== undefined ? clearReviewAuthority.pullRequestNumber : result.pullRequestNumber ?? state.pullRequestNumber, pullRequestUrl: clearReviewAuthority.pullRequestUrl !== undefined ? clearReviewAuthority.pullRequestUrl : result.pullRequestUrl ?? state.pullRequestUrl, deliveryBlockingFindings: memberRepairPlan?.findings ?? state.deliveryBlockingFindings, deliveryRepairPlan: memberRepairPlan ? null : state.deliveryRepairPlan, deliveryRepairPlanArtifactId: memberRepairPlan?.planArtifactId ?? state.deliveryRepairPlanArtifactId, deliveryRepairPlanSha256: memberRepairPlan?.planSha256 ?? state.deliveryRepairPlanSha256, deliveryRepairAuthority: memberRepairPlan ? "member_requested_changes" : state.deliveryRepairAuthority, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  const reconcileAcceptanceTurn = async (): Promise<IssueWorkflowState> => {
    if (!state.acceptanceId) throw new Error("Acceptance reconciliation requires an acceptance intent");
    if ((state.acceptanceAttempt ?? 0) >= MAX_RECONCILIATION_ATTEMPTS) {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Ready reconciliation retry limit exhausted", acceptanceBlockerCode: "acceptance_reconciliation_exhausted", acceptanceRetryAt: null, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return state;
    }
    const result = await reconcileAcceptance({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, acceptanceId: state.acceptanceId });
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "blocked" ? "delivery_blocked" : "ready_reconciliation";
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ready_reconciliation" ? ["reconcile_acceptance", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ready_reconciliation" ? "Waiting for ready-for-review" : (result.blockerSummary ?? "Ready reconciliation is blocked"), acceptanceStatus: result.status, acceptanceAttempt: (state.acceptanceAttempt ?? 0) + 1, acceptanceRetryAt: result.retryAt, acceptanceBlockerCode: result.blockerCode ?? null, acceptanceBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, acceptedAt: result.acceptedAt, readyAt: result.readyAt, pullRequestNumber: result.pullRequestNumber || state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || state.pullRequestUrl, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  };
  setHandler(acceptDeliveryUpdate, (rawInput) => accept(rawInput, "accept"));
  setHandler(requestDeliveryChangesUpdate, (rawInput) => accept(rawInput, "request_changes"));
  setHandler(reconcileAcceptanceUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "ready_reconciliation" || !state.acceptanceId) throw new Error("Acceptance reconciliation is not available in the current phase");
    return reconcileAcceptanceTurn();
  });
  setHandler(reconcileMergeUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || state.phase !== "manual_merge") throw new Error("Merge reconciliation is not available in the current phase");
    return reconcileMergeTurn();
  });
  const cancelQueuedCapacity = async (): Promise<void> => {
    if (!state.capacity || !["queued", "rate_limited"].includes(state.capacity.status)) return;
    await cancelCapacity({ requestId: state.capacity.requestId, reason: "workflow phase changed" });
    state = IssueWorkflowStateSchema.parse({ ...state, capacity: null, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
  };
  const cancelCurrentCapacity = async (): Promise<{ status: "cancelled" | "ownership_ambiguous"; executionId?: string | undefined }> => {
    if (!state.capacity) return { status: "cancelled" };
    if (["queued", "rate_limited"].includes(state.capacity.status)) {
      await cancelQueuedCapacity();
      return { status: "cancelled" };
    }
    if (state.capacity.status === "active" || state.capacity.status === "ownership_ambiguous") {
      return cancelCapacityExecution({ requestId: state.capacity.requestId });
    }
    return { status: "ownership_ambiguous" };
  };
  const preserveAmbiguousCapacity = async (): Promise<void> => {
    if (!state.capacity) return;
    const capacity = { ...state.capacity, status: "ownership_ambiguous" as const, position: null, reason: null, retryAt: null };
    const blocker = { category: "ownership_ambiguous" as const, summary: "Forge cannot prove the cancelled external process is terminal.", nextAction: "Verify ownership before releasing capacity.", resumeOperation: state.capacity.operation };
    state = IssueWorkflowStateSchema.parse({ ...state, capacity, capacityBlocker: blocker, owner: "human", allowedCommands: [], pendingAction: "External ownership verification required", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
  };
  const settleCancelledCapacity = async (executionId: string): Promise<"settled" | "ambiguous" | "none"> => {
    if (!state.capacity) return "none";
    const request = await inspectCapacity({ requestId: state.capacity.requestId });
    if (request.status === "active" && request.executionId === executionId) {
      await finalizeCapacity({ requestId: request.id, expectedExecutionId: executionId, terminalReason: "cancelled" });
      state = IssueWorkflowStateSchema.parse({ ...state, capacity: null, capacityBlocker: null, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return "settled";
    }
    if (request.status === "ownership_ambiguous" || request.status === "active") {
      const capacity = { ...state.capacity, status: "ownership_ambiguous" as const, position: null, reason: null, retryAt: null };
      const blocker = { category: "ownership_ambiguous" as const, summary: "Forge cannot prove the cancelled external process is terminal.", nextAction: "Verify ownership before releasing capacity.", resumeOperation: state.capacity.operation };
      state = IssueWorkflowStateSchema.parse({ ...state, capacity, capacityBlocker: blocker, owner: "human", allowedCommands: [], pendingAction: "External ownership verification required", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      return "ambiguous";
    }
    return "none";
  };
  setHandler(cancelIssueUpdate, async (rawInput) => {
    if (captureInitialProjectionState) await condition(() => initialProjectionComplete);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || ["done", "cancelled"].includes(state.phase)) throw new Error("Issue cancellation is not available in the current phase");
    let ownershipAmbiguous = false;
    if (state.developerExecutionId && ["starting", "active", "reconnecting", "result_pending_claim", "cancellation_requested", "cancelling", "ownership_ambiguous"].includes(state.developerRecoveryStatus ?? "")) {
      const cancellation = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId: state.developerExecutionId });
      if (cancellation.status === "completed_before_cancellation") {
        if (!applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before issue cancellation.")) throw new Error("Completed Developer result is invalid");
        await projectIssueState(state);
        return state;
      }
      if (!["cancelled", "cancelled_confirmed", "interrupted"].includes(cancellation.status)) {
        const summary = "summary" in cancellation ? cancellation.summary : "Forge could not confirm Developer termination.";
        ownershipAmbiguous = true;
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(["verify_developer_ownership", "cancel_issue"]), pendingAction: summary, ...recoveryFields("ownership_ambiguous", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
      if (state.capacity) await settleCancelledCapacity(state.developerExecutionId);
    } else {
      const cancellation = await cancelCurrentCapacity();
      if (cancellation.executionId) await settleCancelledCapacity(cancellation.executionId);
      ownershipAmbiguous = cancellation.status === "ownership_ambiguous";
      if (ownershipAmbiguous) await preserveAmbiguousCapacity();
    }
    let acceptanceStatus = state.acceptanceStatus;
    let acceptanceReasonArtifactId = state.acceptanceReasonArtifactId;
    if (state.acceptanceId && state.releaseId && state.deliveryReviewId && state.finalReviewId && state.ciRunId && state.pullRequestNumber && state.releaseRepository && state.baseBranch && state.targetBaseSha && state.expectedHeadSha && state.expectedHeadTree && state.leadSessionRef) {
      const result = await acceptDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectRevisionId: validatedInput.projectRevisionId, releaseId: state.releaseId, deliveryReviewId: state.deliveryReviewId, finalReviewId: state.finalReviewId, ciRunId: state.ciRunId, actorUserId: command.actorUserId, pullRequestNumber: state.pullRequestNumber, repository: state.releaseRepository, baseBranch: state.baseBranch, baseSha: state.targetBaseSha, leadSessionRef: state.leadSessionRef, expectedHeadSha: state.expectedHeadSha, expectedHeadTree: state.expectedHeadTree, decision: "cancel", ...(command.note !== undefined ? { note: command.note } : {}) });
      acceptanceStatus = result.status;
      acceptanceReasonArtifactId = result.reasonArtifactId ?? acceptanceReasonArtifactId;
    } else if (command.note?.trim()) {
      const decision = await recordDeliveryDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, actorUserId: command.actorUserId, note: command.note });
      state = IssueWorkflowStateSchema.parse({ ...state, deliveryDecisionArtifactId: decision.artifactId });
    }
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "cancelled", owner: "human", allowedCommands: reviseContinueEnabled ? ["continue_work"] : [], pendingAction: ownershipAmbiguous ? "Issue cancelled; operator must verify external ownership" : "Issue cancelled", acceptanceStatus, acceptanceReasonArtifactId, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    return state;
  });
  setHandler(cancelDevelopmentUpdate, async (rawInput) => {
    assertPayloadWithinLimit("cancel development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (!patched(durableCapacityPatch)) {
      if (commandAlreadyProcessed(command.commandId)) return state;
      if (!state.developerExecutionId) {
        await withStateMutation(() => {
          if (state.revision !== command.expectedRevision || state.phase !== "development") throw new Error("Developer cancellation was superseded by another command");
          state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null });
          markCommandProcessed(command.commandId);
          if (shouldContinueAsNew(state.revision)) continuationRequested = true;
        });
        await projectIssueState(state);
        return state;
      }
      const executionId = state.developerExecutionId;
      await withStateMutation(() => {
        if (state.revision !== command.expectedRevision || state.phase !== "development") throw new Error("Developer cancellation was superseded by another command");
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: [], pendingAction: "Cancelling Developer turn", lastEventId: `${state.workflowId}:${state.revision + 1}`, ...recoveryFields("cancellation_requested", null, "Cancellation was sent to the recorded Developer supervisor.", state.developerLastHeartbeatAt ?? null), activeOperation: null });
        markCommandProcessed(command.commandId);
      });
      await projectIssueState(state);
      const result = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId });
      await withStateMutation(() => {
        if (result.status === "completed_before_cancellation") {
          if (!applyCompletedDeveloperResult(result.result, "Developer result won the cancellation race and was claimed.")) throw new Error("Completed Developer result is invalid");
          return;
        }
        const cancelled = result.status === "cancelled" || result.status === "cancelled_confirmed";
        const interrupted = result.status === "interrupted";
        const ambiguous = result.status === "ownership_ambiguous" || result.status === "termination_failed";
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(cancelled || interrupted ? ["retry_development", "cancel_issue"] : ambiguous ? ["verify_developer_ownership", "cancel_issue"] : ["retry_development", "cancel_issue"]), pendingAction: cancelled ? "Developer turn cancelled; preserved work is available for retry" : interrupted ? result.summary : ambiguous ? result.summary : "Developer completed before cancellation; retry is disabled until the result is reconciled", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerOutcome: null, ...recoveryFields(cancelled ? "cancelled" : interrupted ? "interrupted" : ambiguous ? "ownership_ambiguous" : "result_pending_claim", "reasonCode" in result ? result.reasonCode : null, cancelled ? "Developer termination was confirmed; the worktree was preserved." : "summary" in result ? result.summary : "The Developer result won the cancellation race.", state.developerLastHeartbeatAt ?? null), activeOperation: null });
        if (shouldContinueAsNew(state.revision)) continuationRequested = true;
      });
      await projectIssueState(state);
      void command;
      return state;
    }
    if (commandAlreadyProcessed(command.commandId)) return state;
    const executionId = state.developerExecutionId;
    const hasCapacityOwnership = state.capacity !== null;
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || state.phase !== "development") throw new Error("Developer cancellation was superseded by another command");
      state = IssueWorkflowStateSchema.parse({
        ...state,
        revision: state.revision + 1,
        phase: executionId || hasCapacityOwnership ? "delivery_blocked" : "ready_for_development",
        owner: executionId || hasCapacityOwnership ? "human" : "lead",
        allowedCommands: executionId || hasCapacityOwnership ? [] : ["start_development", "cancel_issue"],
        pendingAction: executionId || hasCapacityOwnership ? "Cancelling Developer turn" : "Start development",
        lastEventId: `${state.workflowId}:${state.revision + 1}`,
        ...(executionId || hasCapacityOwnership ? recoveryFields("cancellation_requested", null, "Cancellation was sent to the recorded Developer supervisor.", state.developerLastHeartbeatAt ?? null) : {}),
        activeOperation: null,
      });
      markCommandProcessed(command.commandId);
      if (!executionId && !hasCapacityOwnership && shouldContinueAsNew(state.revision)) continuationRequested = true;
    });
    await projectIssueState(state);
    if (!executionId && !hasCapacityOwnership) return state;
    if (!executionId) {
      const cancellation = await cancelCurrentCapacity();
      if (cancellation.status === "ownership_ambiguous") {
        await preserveAmbiguousCapacity();
      } else {
        await withStateMutation(() => {
          state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${state.workflowId}:${state.revision + 1}`, activeOperation: null });
        });
      }
      await projectIssueState(state);
      return state;
    }
    const result = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId });
    await withStateMutation(() => {
      if (result.status === "completed_before_cancellation") {
        if (!applyCompletedDeveloperResult(result.result, "Developer result won the cancellation race and was claimed.")) throw new Error("Completed Developer result is invalid");
        return;
      }
      const cancelled = result.status === "cancelled" || result.status === "cancelled_confirmed";
      const interrupted = result.status === "interrupted";
      const ambiguous = result.status === "ownership_ambiguous" || result.status === "termination_failed";
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(cancelled || interrupted ? ["retry_development", "cancel_issue"] : ambiguous ? ["verify_developer_ownership", "cancel_issue"] : ["retry_development", "cancel_issue"]), pendingAction: cancelled ? "Developer turn cancelled; preserved work is available for retry" : interrupted ? result.summary : ambiguous ? result.summary : "Developer completed before cancellation; retry is disabled until the result is reconciled", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerOutcome: null, ...recoveryFields(cancelled ? "cancelled" : interrupted ? "interrupted" : ambiguous ? "ownership_ambiguous" : "result_pending_claim", "reasonCode" in result ? result.reasonCode : null, cancelled ? "Developer termination was confirmed; the worktree was preserved." : "summary" in result ? result.summary : "The Developer result won the cancellation race.", state.developerLastHeartbeatAt ?? null), activeOperation: null });
      if (shouldContinueAsNew(state.revision)) continuationRequested = true;
    });
    if (["cancelled", "cancelled_confirmed", "interrupted"].includes(result.status) && state.capacity) await settleCancelledCapacity(executionId);
    if ((result.status === "ownership_ambiguous" || result.status === "termination_failed") && state.capacity) await preserveAmbiguousCapacity();
    await projectIssueState(state);
    void command;
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (state.phase !== "development") throw new Error("Developer cancellation is not available in the current phase");
  } });
  setHandler(revisePlanUpdate, async (rawInput) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanRevisionCommandSchema.parse(rawInput);
    if (state.phase === "development") {
      const active = state.developerExecutionId ? { executionId: state.developerExecutionId } : await findActiveDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId });
      if (!active) throw new Error("Developer ownership is unavailable for plan revision");
      const cancellation = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId: active.executionId });
      if (cancellation.status === "completed_before_cancellation") {
        if (!applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before plan revision.")) throw new Error("Completed Developer result is invalid");
        await projectIssueState(state);
        return state;
      }
      if (!["cancelled", "cancelled_confirmed", "interrupted"].includes(cancellation.status)) {
        const summary = "summary" in cancellation ? cancellation.summary : "Developer ownership must be precisely cancelled before plan revision";
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(["verify_developer_ownership", "cancel_issue"]), pendingAction: summary, ...recoveryFields("ownership_ambiguous", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
    }
    const prepared = await preparePlanRevision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, requestRevision: state.revision, actorUserId: command.actorUserId, reason: command.reason, worktreeDisposition: command.worktreeDisposition, ...(command.worktreeDisposition === "new" ? { exactBaseSha: command.exactBaseSha } : {}), ...(state.developerExecutionId ? { developerExecutionId: state.developerExecutionId } : {}) });
    if (prepared.status === "blocked") {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: addRevisionCommand(["revise_plan", "cancel_issue"]), pendingAction: "Plan revision is blocked", blockerCode: prepared.blockerCode, revisionRequestId: prepared.revisionRequestId, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    } else {
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", blockerCode: null, revisionRequestId: prepared.revisionRequestId, revisedExecutionCoordinates: prepared.coordinates, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    }
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = PlanRevisionCommandSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_blocked", "delivery_ready", "delivery_reviewed", "repair_required"].includes(state.phase)) throw new Error("Plan revision is not available in the current phase");
  } });
  setHandler(continueWorkUpdate, async (rawInput) => {
    const command = ContinueWorkCommandSchema.parse(rawInput);
    const successorTaskId = `${validatedInput.issueId}-successor-${state.revision}`;
    const successorWorkflowId = `${validatedInput.workflowId}-successor-${state.revision}`;
    const intentId = `intent_${validatedInput.workflowId}_${state.revision}`;
    const successor = await createSuccessor({ predecessorTaskId: validatedInput.issueId, predecessorWorkflowId: validatedInput.workflowId, acceptedRevision: state.revision, successorTaskId, successorWorkflowId, companyId: validatedInput.companyId, projectId: validatedInput.projectId, actorUserId: command.actorUserId, reason: command.reason, intentId });
    state = IssueWorkflowStateSchema.parse({ ...state, successorTaskId: successor.successorTaskId, successorReference: successor, allowedCommands: [], pendingAction: "Successor created", lastEventId: `${state.workflowId}:${state.revision + 1}`, revision: state.revision + 1 });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = ContinueWorkCommandSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (!["done", "cancelled", "failed"].includes(state.phase)) throw new Error("Continue work is only available after a terminal issue state");
    if (!state.allowedCommands.includes("continue_work")) throw new Error("Continue work is not available in the current phase");
  } });
  setHandler(verifyDeveloperOwnershipUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return state;
    const executionId = state.developerExecutionId!;
    await withStateMutation(() => {
      if (state.revision !== command.expectedRevision || state.developerRecoveryStatus !== "ownership_ambiguous") throw new Error("Developer ownership verification was superseded by another command");
      markCommandProcessed(command.commandId);
    });
    const observation = await observeDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId });
    await withStateMutation(() => {
      const allowedCommands = observation.status === "active" ? ["cancel_development", "cancel_issue"] as const : observation.status === "interrupted" ? ["retry_development", "cancel_issue"] as const : observation.status === "result_ready" ? ["retry_development", "cancel_issue"] as const : ["verify_developer_ownership", "cancel_issue"] as const;
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: observation.status === "active" ? "development" : "delivery_blocked", owner: observation.status === "active" ? "lead" : "human", allowedCommands, pendingAction: observation.summary, lastEventId: `${state.workflowId}:${state.revision + 1}`, ...recoveryFields(observation.status === "result_ready" ? "result_pending_claim" : observation.status, observation.reasonCode, observation.summary, observation.lastHeartbeatAt) });
    });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== state.revision || state.developerRecoveryStatus !== "ownership_ambiguous" || !state.developerExecutionId) throw new Error("Developer ownership verification is not available");
  } });
  setHandler(rejectPlanUpdate, async (rawInput) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    const capacityCancellation = state.phase === "development" && state.developerExecutionId ? { status: "cancelled" as const } : await cancelCurrentCapacity();
    if (state.phase === "development") {
      const cancellation = await cancelDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, executionId: state.developerExecutionId! });
      if (cancellation.status === "completed_before_cancellation") {
        if (!applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before plan revision.")) throw new Error("Completed Developer result is invalid");
        await projectIssueState(state);
        return state;
      }
      if (cancellation.status !== "cancelled" && cancellation.status !== "cancelled_confirmed") {
        const summary = "summary" in cancellation ? cancellation.summary : "Developer ownership must be precisely cancelled before plan revision";
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["verify_developer_ownership", "cancel_issue"], pendingAction: summary, ...recoveryFields("ownership_ambiguous", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await projectIssueState(state);
        return state;
      }
      if (state.capacity) await settleCancelledCapacity(state.developerExecutionId!);
    } else if (capacityCancellation.status === "ownership_ambiguous") {
      await preserveAmbiguousCapacity();
      return state;
    }
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${state.workflowId}:${state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null, blocker: null, stateChangedAt: new Date().toISOString() });
    const decision = await recordPlanDecision({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision: state.revision - 1, actorUserId: command.actorUserId, decision: "reject", note: `${command.note ?? "Member requested an explicit plan revision"}; worktree=${command.worktreeDecision ?? "new"}; exactBase=${command.exactBaseSha ?? "recorded-current-base"}` });
    state = IssueWorkflowStateSchema.parse({ ...state, decisionId: decision.decisionId, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
    await projectIssueState(state);
    return state;
  }, { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_blocked", "delivery_ready", "delivery_reviewed", "repair_required"].includes(state.phase)) throw new Error("Plan revision is not available in the current phase");
    if (!state.planMaterial) throw new Error("Routine plans do not require revision");
    if (state.phase === "development" && !state.developerExecutionId) throw new Error("Active Developer execution is unavailable for cancellation");
  } });
  const resumeCapacityOperation = async (operation: CapacityOperation): Promise<IssueWorkflowState> => {
    if (operation === "lead_planning") {
      const result = await acquireExternalTurn<LeadPlanningResult>(
        { operation, role: "lead", profileId: validatedInput.roleProfiles.lead },
        (capacityRequestId) => runLeadPlanning({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.revision, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (value) => value.leadExecutionId,
      );
      state = IssueWorkflowStateSchema.parse({ ...state, ...result, planRevision: state.revision, planMaterial: result.material, materialCategories: result.materialCategories, supplementalReviewUsed: false, phase: result.material ? "approval" : "ready_for_development", owner: result.material ? "human" : "lead", allowedCommands: result.material ? ["approve_plan", "reject_plan", "cancel_issue"] : ["start_development", "cancel_issue"], pendingAction: result.material ? "Approve final plan" : "Start development", lastEventId: `${state.workflowId}:${state.revision + 1}`, revision: state.revision + 1 });
      await projectIssueState(state);
      return state;
    }
    if (operation === "developer_execution") {
      const result = await acquireExternalTurn<WorkflowDeveloperExecutionResult>(
        { operation, role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: state.developerSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => runDeveloperExecution({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, supersedesExecutionId: state.developerExecutionId ?? undefined, reuseWorktree: Boolean(state.worktreePath), ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (value) => value.developerExecutionId,
      );
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Resolve Developer blocker", lastEventId: `${state.workflowId}:${state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome });
      await projectIssueState(state);
      return state;
    }
    if (operation === "supplemental_review") {
      if (state.phase !== "approval" || !state.planMaterial || !state.leadOutputArtifactId || !state.leadEvidenceArtifactId || !state.leadSessionRef || !validatedInput.roleProfiles.reviewer) throw new Error("Supplemental review prerequisites changed; start the review command again");
      const review = await acquireExternalTurn<SupplementalReviewResult>(
        { operation, role: "reviewer", profileId: validatedInput.roleProfiles.reviewer },
        (capacityRequestId) => runSupplementalReview({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.planRevision ?? state.revision, leadOutputArtifactId: state.leadOutputArtifactId!, leadEvidenceArtifactId: state.leadEvidenceArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.executionId,
      );
      const consolidated = await acquireExternalTurn<LeadPlanningResult>(
        { operation: "lead_consolidation", role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef },
        (capacityRequestId) => consolidateLeadPlan({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.revision + 1, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.leadExecutionId,
      );
      state = IssueWorkflowStateSchema.parse({ ...state, ...consolidated, revision: state.revision + 1, phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue"], pendingAction: "Approve final plan", lastEventId: `${state.workflowId}:${state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, planMaterial: consolidated.material, materialCategories: consolidated.materialCategories, planRevision: state.planRevision ?? state.revision });
      await projectIssueState(state);
      return state;
    }
    if (operation === "lead_consolidation") {
      if (state.phase !== "approval" || !state.planMaterial || !state.leadOutputArtifactId || !state.leadSessionRef || !state.supplementalReviewArtifactId) throw new Error("Lead consolidation prerequisites changed; request supplemental review again");
      const consolidated = await acquireExternalTurn<LeadPlanningResult>(
        { operation, role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef },
        (capacityRequestId) => consolidateLeadPlan({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, imageArtifactIds: validatedInput.imageArtifactIds, roleProfiles: validatedInput.roleProfiles, revision: state.revision + 1, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, supplementalReviewArtifactId: state.supplementalReviewArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.leadExecutionId,
      );
      state = IssueWorkflowStateSchema.parse({ ...state, ...consolidated, revision: state.revision + 1, phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue"], pendingAction: "Approve final plan", lastEventId: `${state.workflowId}:${state.revision + 1}`, supplementalReviewUsed: true, planMaterial: consolidated.material, materialCategories: consolidated.materialCategories, planRevision: state.planRevision ?? state.revision });
      await projectIssueState(state);
      return state;
    }
    if (operation === "delivery_review") {
      if (state.phase !== "reviewing_delivery" || !state.developerExecutionId || !state.developerSessionRef || !state.worktreePath || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.deliveryArtifactId || !state.developerEvidenceArtifactId || !state.leadSessionRef || !state.leadOutputArtifactId || !validatedInput.roleProfiles.lead) throw new Error("Delivery review prerequisites changed; start delivery review again");
      const result = await acquireExternalTurn<WorkflowDeliveryReviewResult>(
        { operation, role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => reviewDelivery({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadOutputArtifactId: state.leadOutputArtifactId!, worktreePath: state.worktreePath!, branchName: state.branchName!, subject: { planRevision: state.planRevision ?? state.revision, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, developerExecutionId: state.developerExecutionId!, deliveryArtifactId: state.deliveryArtifactId!, developerEvidenceArtifactId: state.developerEvidenceArtifactId!, leadSessionRef: state.leadSessionRef!, developerSessionRef: state.developerSessionRef! }, supersedesReviewId: state.deliveryReviewSupersedesId ?? null, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (review) => review.outcome === "completed" ? review.review.leadExecutionId : review.executionId,
      );
      state = result.outcome === "blocked" ? reviewBlockedState(state, result) : repairRequiredState(state, result, validatedInput.repairCycleLimit);
      await projectIssueState(state);
      return state;
    }
    if (operation === "developer_repair") {
      const cycle = (state.repairCycle ?? 0) + 1;
      if (state.phase !== "repair_required" || cycle > validatedInput.repairCycleLimit || !state.deliveryReviewId || (!state.deliveryReviewArtifact && (!state.deliveryRepairPlan || !(state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open"))) || !state.developerExecutionId || !state.developerSessionRef || !state.branchName || !state.targetBaseSha || !state.resultCommit || !state.resultTree || !state.leadSessionRef || !validatedInput.roleProfiles.developer) throw new Error("Developer repair prerequisites changed; start delivery repair again");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer repair cycle ${cycle}`, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      const result = await acquireExternalTurn<WorkflowDeveloperRepairResult>(
        { operation, role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: state.developerSessionRef, worktreePath: state.worktreePath },
        (capacityRequestId) => runDeveloperRepair({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, planRevision: state.planRevision ?? state.revision, roleProfiles: validatedInput.roleProfiles, leadSessionRef: state.leadSessionRef!, developerSessionRef: state.developerSessionRef!, developerExecutionId: state.developerExecutionId!, reviewId: state.deliveryReviewId!, repairAuthority: state.deliveryRepairAuthority ?? "delivery_review", cycle, repairCycleLimit: validatedInput.repairCycleLimit, ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}), branchName: state.branchName!, targetBaseSha: state.targetBaseSha!, subjectCommit: state.resultCommit!, subjectTree: state.resultTree!, ...(state.deliveryReviewArtifact ? { reviewArtifact: state.deliveryReviewArtifact } : state.deliveryRepairPlanArtifactId && state.deliveryRepairPlanSha256 ? { repairPlanArtifactId: state.deliveryRepairPlanArtifactId, repairPlanSha256: state.deliveryRepairPlanSha256 } : { blockingFindings: state.deliveryBlockingFindings ?? [], repairPlan: state.deliveryRepairPlan! }), ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (repair) => repair.developerExecutionId,
      );
      state = result.outcome === "completed" ? repairedDeliveryAwaitingFreshReviewState(state, result) : repairBlockedState(state, result, validatedInput.repairCycleLimit);
      await projectIssueState(state);
      return state;
    }
    if (operation === "merge_conflict_plan") {
      if (state.phase !== "merge_conflict_reviewing" || !state.leadSessionRef || !state.leadOutputArtifactId || !state.worktreePath || !state.branchName || !state.forwardMergeId || !state.forwardMergePriorHead || !state.forwardMergeTargetBaseSha || !state.forwardMergeConflictArtifact || typeof state.forwardMergeConflictFileCount !== "number" || !validatedInput.roleProfiles.lead) throw new Error("Conflict-plan prerequisites changed; publish the draft again to revalidate the merge");
      try {
        const plan = await acquireExternalTurn<MergeConflictPlanActivityResult>(
          { operation, role: "lead", profileId: validatedInput.roleProfiles.lead, sessionRef: state.leadSessionRef, worktreePath: state.worktreePath },
          (capacityRequestId) => planMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, projectId: validatedInput.projectId, projectRevisionId: validatedInput.projectRevisionId, briefArtifactId: validatedInput.briefArtifactId, planRevision: state.planRevision ?? state.revision, leadSessionRef: state.leadSessionRef!, leadOutputArtifactId: state.leadOutputArtifactId!, worktreePath: state.worktreePath!, branchName: state.branchName!, forwardMergeId: state.forwardMergeId!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, conflictArtifact: state.forwardMergeConflictArtifact!, conflictFileCount: state.forwardMergeConflictFileCount!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (result) => result.leadExecutionId,
        );
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${state.workflowId}:${state.revision + 1}` });
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Lead conflict-resolution planning failed; inspect the recorded evidence", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      await projectIssueState(state);
      return state;
    }
    if (operation === "merge_conflict_resolution") {
      if (state.phase !== "merge_conflict_required" || !state.mergeResolutionPlanArtifactId || !state.developerExecutionId || !state.developerSessionRef || !state.worktreePath || !state.branchName || !state.forwardMergeId || !state.forwardMergePriorHead || !state.forwardMergeTargetBaseSha || !state.forwardMergeConflictArtifact || typeof state.forwardMergeConflictFileCount !== "number" || !validatedInput.roleProfiles.developer) throw new Error("Conflict-resolution prerequisites changed; revalidate the Lead plan and Developer worktree");
      state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_resolving", owner: "lead", allowedCommands: [], pendingAction: "Developer resolving forward-merge conflicts", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      await projectIssueState(state);
      try {
        const result = await acquireExternalTurn<Awaited<ReturnType<typeof resolveMergeConflict>>>(
          { operation, role: "developer", profileId: validatedInput.roleProfiles.developer, sessionRef: state.developerSessionRef, worktreePath: state.worktreePath },
          (capacityRequestId) => resolveMergeConflict({ taskId: validatedInput.issueId, companyId: validatedInput.companyId, workflowId: validatedInput.workflowId, planRevision: state.planRevision ?? state.revision, forwardMergeId: state.forwardMergeId!, developerExecutionId: state.developerExecutionId!, developerSessionRef: state.developerSessionRef!, worktreePath: state.worktreePath!, branchName: state.branchName!, priorHead: state.forwardMergePriorHead!, targetBaseSha: state.forwardMergeTargetBaseSha!, conflictArtifact: state.forwardMergeConflictArtifact!, conflictFileCount: state.forwardMergeConflictFileCount!, planArtifactId: state.mergeResolutionPlanArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (resolution) => resolution.developerExecutionId,
        );
        if ("outcome" in result && result.outcome === "verification_blocked") {
          state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "delivery_blocked", owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: result.summary, targetBaseOutcome: "blocked", targetBaseBlockerCode: result.code, targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", developerEvidenceArtifactId: result.verificationArtifact.id, developerOutcome: "blocked", lastEventId: `${state.workflowId}:${state.revision + 1}` });
        } else {
          const successfulResult = result as Extract<typeof result, { deliveryArtifactId: string }>;
          state = applyTargetBaseRevalidation(state, { outcome: "revalidated", checkId: state.forwardMergeId!, checkpoint: state.targetBaseCheckpoint ?? "pre_release", expectedBaseSha: state.targetBaseSha!, observedBaseSha: state.forwardMergeTargetBaseSha!, priorHead: state.forwardMergePriorHead!, priorTree: state.forwardMergePriorTree!, headSha: successfulResult.resultCommit, headTree: successfulResult.resultTree, developerExecutionId: successfulResult.developerExecutionId, deliveryArtifact: { id: successfulResult.deliveryArtifactId, sha256: successfulResult.deliveryArtifactSha256, kind: "forward-merge-delivery" }, verificationArtifact: { id: successfulResult.verificationArtifactId, sha256: successfulResult.verificationArtifactSha256, kind: "forward-merge-verification" } });
          state = IssueWorkflowStateSchema.parse({ ...state, developerSessionRef: successfulResult.developerSessionRef, deliverySummary: successfulResult.summary, developerEvidenceArtifactId: successfulResult.verificationArtifactId, mergeResolutionDeveloperExecutionId: successfulResult.developerExecutionId, mergeResolutionDeveloperSessionRef: successfulResult.developerSessionRef });
        }
      } catch {
        state = IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution is incomplete; retry the same owned turn", lastEventId: `${state.workflowId}:${state.revision + 1}` });
      }
      await projectIssueState(state);
      return state;
    }
    if (operation === "final_review") return runFinalReviewTurn();
    throw new Error(`Capacity retry for ${operation} requires the original phase command to revalidate its inputs`);
  };
  setHandler(retryCapacityUpdate, async (rawInput) => {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== state.revision || !state.capacityBlocker || !state.allowedCommands.includes("retry_capacity")) throw new Error("Capacity retry is not available in the current state");
    if (state.capacityBlocker.category === "ownership_ambiguous") await reconcileCapacityOwnership({});
    if (state.capacity) {
      const request = await inspectCapacity({ requestId: state.capacity.requestId });
      if (["active", "ownership_ambiguous"].includes(request.status)) throw new Error("Capacity ownership must be reconciled before retry");
    }
    const operation = state.capacityBlocker.resumeOperation;
    const nextPhase = operation === "lead_planning" ? "planning" : operation === "developer_execution" ? "development" : operation === "delivery_review" ? "reviewing_delivery" : operation === "developer_repair" ? "repair_required" : operation === "final_review" ? "final_review" : operation === "merge_conflict_resolution" ? "merge_conflict_required" : operation === "merge_conflict_plan" ? "merge_conflict_reviewing" : "approval";
    const nextCommands = nextPhase === "planning" ? [] : nextPhase === "development" ? ["cancel_development", "cancel_issue"] : nextPhase === "reviewing_delivery" ? [] : nextPhase === "final_review" ? [] : nextPhase === "repair_required" ? ["cancel_issue"] : nextPhase === "merge_conflict_required" ? ["cancel_issue"] : nextPhase === "merge_conflict_reviewing" ? ["cancel_issue"] : ["cancel_issue"];
    state = IssueWorkflowStateSchema.parse({ ...state, capacity: null, capacityBlocker: null, phase: nextPhase, owner: nextPhase === "approval" ? "human" : "lead", allowedCommands: nextCommands, pendingAction: `Retry ${operation.replaceAll("_", " ")}`, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
    await projectIssueState(state);
    void command;
    return resumeCapacityOperation(operation);
  });
  setHandler(recordProgressUpdate, async (rawInput) => {
    assertPayloadWithinLimit("recordProgress command", rawInput);
    const command = RecordProgressInputSchema.parse(rawInput);
    const next = IssueWorkflowStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      allowedCommands: continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      lastEventId: `${state.workflowId}:${state.revision + 1}`,
      continuationCount: state.continuationCount,
      lastSummaryHash: command.summaryHash,
    });
    state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    if (shouldContinueAsNew(next.revision)) continuationRequested = true;
    await projectIssueState(next);
    return next;
  }, {
    validator(rawInput) {
      const command = RecordProgressInputSchema.parse(rawInput);
      if (command.expectedRevision !== state.revision) throw new Error("Stale workflow revision");
      if (state.phase !== "planning") throw new Error("Progress can only be recorded during Planning");
    },
  });
  assertPayloadWithinLimit("Issue Workflow result", state);
  // Continue-As-New carries the last business revision into a fresh run. The
  // previous run already projected that revision, so emitting it again with a
  // different continuationCount would correctly look like conflicting
  // authoritative history to the projection boundary.
  if (!continuation) await projectIssueState(captureInitialProjectionState ? initialProjectionState : state);
  initialProjectionComplete = true;
  while (true) {
    if (state.phase === "cancelled" || state.phase === "done") return state;
    if (state.phase === "releasing" && state.releaseRetryAt) {
      const delay = Math.max(0, Date.parse(state.releaseRetryAt) - Date.now());
      if (delay > 0) await sleep(delay);
      if (state.phase === "releasing") await runPublishTurn();
      continue;
    }
    if (state.phase === "ci_waiting") {
      const sleepingRevision = state.revision;
      const sleepingReleaseId = state.releaseId;
      const sleepingHeadSha = state.expectedHeadSha;
      const pollAt = state.ciNextPollAt ? isoEpochMillis(state.ciNextPollAt) : Date.now();
      const delay = Math.max(0, pollAt - Date.now());
      if (delay > 0) await sleep(delay);
      if (state.phase !== "ci_waiting" || state.revision !== sleepingRevision || state.releaseId !== sleepingReleaseId || state.expectedHeadSha !== sleepingHeadSha) continue;
      await reconcileCiTurn();
      continue;
    }
    if (state.phase === "ready_reconciliation") {
      await sleepUntil(state.acceptanceRetryAt);
      if (state.phase === "ready_reconciliation") await reconcileAcceptanceTurn();
      continue;
    }
    if (state.phase === "manual_merge") {
      await sleepUntil(state.mergeRetryAt);
      if (state.phase === "manual_merge") await reconcileMergeTurn();
      continue;
    }
    await condition(() => (continuationRequested && allHandlersFinished()) || (state.phase === "releasing" && Boolean(state.releaseRetryAt)) || state.phase === "ci_waiting" || state.phase === "ready_reconciliation" || state.phase === "manual_merge");
    if (continuationRequested && allHandlersFinished()) {
      if (stateMutationLocked || state.activeOperation !== null) continue;
      const compact = compactStateForContinuation(state);
      assertContinuationStateWithinLimit(compact);
      await continueAsNew<typeof issueWorkflow>({ ...validatedInput, continuationState: compact, continueAsNewAfter: continueAfter });
    }
  }
}
