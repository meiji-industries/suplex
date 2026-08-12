import { z } from "zod";
import { ReleaseFailureCodeSchema } from "../release-failures.js";

import { DecisionIdempotencyKeySchema, MaterialityEvidenceSubjectSchema, PlanBlockerSubjectSchema, PlanDecisionSubjectSchema, PlanMaterialCategorySchema, PlanSubjectSchema, SupplementalReviewSubjectSchema, type MaterialityEvidenceSubject, type PlanBlockerSubject, type PlanDecisionSubject, type PlanMaterialCategory, type PlanSubject, type SupplementalReviewSubject } from "../plan-governance.js";
import { CapacityBlockerSchema, WorkflowCapacityStateSchema } from "../capacity-contracts.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const DeliveryReviewSubjectSchema = z.object({
  planRevision: z.number().int().nonnegative(),
  targetBaseSha: sha,
  subjectCommit: sha,
  subjectTree: sha,
  developerExecutionId: durableId,
  deliveryArtifactId: durableId,
  developerEvidenceArtifactId: durableId,
  leadSessionRef: durableId,
  developerSessionRef: durableId,
}).strict();
export type DeliveryReviewSubject = z.infer<typeof DeliveryReviewSubjectSchema>;

export const DeliveryOperationBlockCodeSchema = z.enum([
  "invalid-output", "correction-exhausted", "session-conflict", "authentication-required",
  "rate-limited", "process-failed", "evidence-too-large", "subject-changed",
  "repair-incomplete", "repair-scope", "worktree-unsafe", "repair-cap-exhausted",
]);
export type DeliveryOperationBlockCode = z.infer<typeof DeliveryOperationBlockCodeSchema>;
export const DeliveryWorkflowBlockCodeSchema = z.union([
  DeliveryOperationBlockCodeSchema,
  z.enum(["review-infrastructure-failure", "repair-infrastructure-failure"]),
]);
export type DeliveryWorkflowBlockCode = z.infer<typeof DeliveryWorkflowBlockCodeSchema>;
const blockSummary = z.string().min(1).max(500);

export const TargetBaseCheckpointSchema = z.enum(["pre_release", "pre_final_review", "pre_acceptance"]);
export type TargetBaseCheckpoint = z.infer<typeof TargetBaseCheckpointSchema>;

export const TargetBaseBlockerCodeSchema = z.enum([
  "authentication_required",
  "provider_unavailable",
  "remote_identity_mismatch",
  "base_rewritten",
  "base_advanced_again",
  "worktree_ownership_mismatch",
  "worktree_dirty",
  "merge_state_ownership_mismatch",
  "merge_failed",
  "conflict_evidence_too_large",
  "artifact_unavailable",
  "verification_failed",
  "verification_timed_out",
  "verification_evidence_too_large",
]);
export type TargetBaseBlockerCode = z.infer<typeof TargetBaseBlockerCodeSchema>;

export const TargetBaseArtifactKindSchema = z.enum(["forward-merge-conflict", "forward-merge-verification", "forward-merge-delivery"]);
export const ArtifactReferenceSchema = z.object({ id: durableId, sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: TargetBaseArtifactKindSchema }).strict();
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const ReconcileTargetBaseActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectRevisionId: durableId,
  checkpoint: TargetBaseCheckpointSchema,
  developerExecutionId: durableId,
  expectedBaseSha: sha,
  expectedHeadSha: sha,
  expectedHeadTree: sha,
  forwardMergeId: durableId.optional(),
  verificationOnly: z.boolean().optional(),
  deliveryReviewId: durableId.optional(),
  ciRunId: durableId.optional(),
  finalReviewId: durableId.optional(),
  acceptanceId: durableId.optional(),
  releaseId: durableId.optional(),
}).strict();

const noDriftResult = z.object({
  outcome: z.literal("no_drift"),
  checkId: durableId,
  checkpoint: TargetBaseCheckpointSchema,
  expectedBaseSha: sha,
  observedBaseSha: sha,
  headSha: sha,
  headTree: sha,
}).strict();
const revalidatedResult = z.object({
  outcome: z.literal("revalidated"),
  checkId: durableId,
  checkpoint: TargetBaseCheckpointSchema,
  expectedBaseSha: sha,
  observedBaseSha: sha,
  priorHead: sha,
  priorTree: sha,
  headSha: sha,
  headTree: sha,
  developerExecutionId: durableId,
  deliveryArtifact: ArtifactReferenceSchema,
  verificationArtifact: ArtifactReferenceSchema,
}).strict();
const conflictResult = z.object({
  outcome: z.literal("conflict"),
  checkId: durableId,
  checkpoint: TargetBaseCheckpointSchema,
  expectedBaseSha: sha,
  observedBaseSha: sha,
  priorHead: sha,
  priorTree: sha,
  conflictFileCount: z.number().int().min(1).max(128),
  conflictArtifact: ArtifactReferenceSchema,
}).strict();
const blockedResult = z.object({
  outcome: z.literal("blocked"),
  checkId: durableId,
  checkpoint: TargetBaseCheckpointSchema,
  code: TargetBaseBlockerCodeSchema,
  owner: z.enum(["human", "provider", "lead"]),
  retryable: z.boolean(),
  summary: z.string().min(1).max(500),
  evidenceArtifact: ArtifactReferenceSchema.optional(),
  observedBaseSha: sha.optional(),
  priorHead: sha.optional(),
  priorTree: sha.optional(),
  resultHead: sha.optional(),
  resultTree: sha.optional(),
}).strict();
export const ReconcileTargetBaseActivityResultSchema = z.discriminatedUnion("outcome", [noDriftResult, revalidatedResult, conflictResult, blockedResult]);
export type ReconcileTargetBaseActivityInput = z.infer<typeof ReconcileTargetBaseActivityInputSchema>;
export type ReconcileTargetBaseActivityResult = z.infer<typeof ReconcileTargetBaseActivityResultSchema>;
const exactSha = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const RevisedExecutionCoordinatesSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("reuse"), revisionRequestId: durableId, developerExecutionId: durableId, branchName: z.string().min(1).max(256), baseSha: exactSha, headSha: exactSha, treeSha: exactSha, dirtyState: z.literal("clean") }).strict(),
  z.object({ disposition: z.literal("new"), revisionRequestId: durableId, exactBaseSha: exactSha }).strict(),
]);
export type RevisedExecutionCoordinates = z.infer<typeof RevisedExecutionCoordinatesSchema>;

export const SuccessorReferenceSchema = z.object({
  successorTaskId: durableId,
  successorWorkflowId: durableId,
  predecessorTaskId: durableId,
  projectRevisionId: durableId,
  creationRevision: z.number().int().nonnegative(),
}).strict();

export const DurableArtifactKindSchema = z.enum([
  "task-brief",
  "task-image",
  "agent-evidence",
  "attention-evidence",
  "decision-blocker",
  "lead-plan",
  "developer-delivery",
  "delivery-review",
  "delivery-repair-plan",
  "developer-repair",
  "ci-evidence",
  "merge-conflict-evidence",
  "merge-conflict-plan",
  "merge-conflict-resolution",
  "plan-revision-reason",
  "continuation-reason",
]);

export const DurableArtifactReferenceSchema = z.object({
  artifactId: durableId,
  companyId: durableId,
  kind: DurableArtifactKindSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive().max(8 * 1024 * 1024),
  mimeType: z.string().min(1).max(120),
});

export type DurableArtifactReference = z.infer<typeof DurableArtifactReferenceSchema>;

export function normalizeSafeSummary(value: unknown): string {
  const normalized = String(value).replace(/[\r\n]+/g, " ").trim();
  if (!normalized) return "The operation requires operator attention.";
  let result = "";
  for (const character of normalized) {
    const candidate = result + character;
    if (new TextEncoder().encode(candidate).byteLength > 240) break;
    result = candidate;
  }
  return result || "The operation requires operator attention.";
}

export const SafeSummarySchema = z.string().min(1).superRefine((value, context) => {
  if (/\r|\n/.test(value)) context.addIssue({ code: "custom", message: "Safe summaries must be one line" });
  if (new TextEncoder().encode(value).byteLength > 240) context.addIssue({ code: "custom", message: "Safe summaries are limited to 240 UTF-8 bytes" });
});

export const ActiveOperationSchema = z.object({
  commandId: durableId,
  kind: z.enum(["lead_planning", "development", "delivery_review", "repair", "release", "conflict_plan", "ci", "final_review"]),
  startedRevision: z.number().int().nonnegative(),
}).nullable();

export type ActiveOperation = z.infer<typeof ActiveOperationSchema>;

export const DeveloperRecoveryStatusSchema = z.enum(["starting", "active", "reconnecting", "result_pending_claim", "cancellation_requested", "cancelling", "interrupted", "cancelled", "ownership_ambiguous", "failed"]);
export type DeveloperRecoveryStatus = z.infer<typeof DeveloperRecoveryStatusSchema>;

const DeveloperRecoveryFields = {
  developerAttempt: z.number().int().positive().optional(),
  developerTurnKind: z.enum(["implementation", "repair", "merge_conflict_resolution"]).optional(),
  developerRecoveryStatus: DeveloperRecoveryStatusSchema.nullable().optional(),
  developerRecoveryReasonCode: z.string().max(100).nullable().optional(),
  developerRecoverySummary: SafeSummarySchema.nullable().optional(),
  developerLastHeartbeatAt: z.string().datetime().nullable().optional(),
};

export const DeliveryFindingSchema = z.object({
  findingId: durableId,
  severity: z.enum(["blocking", "advisory"]),
  rationale: z.string().min(1).max(8_000),
  evidenceRef: z.string().min(1).max(2_000),
  disposition: z.enum(["open", "accepted", "repaired"]),
  repairInstruction: z.string().max(8_000).nullable(),
});

export const DeliveryReviewSchema = z.object({
  kind: z.literal("delivery_review"),
  summary: z.string().min(1).max(2_000),
  outcome: z.enum(["approved", "blocking"]),
  findings: z.array(DeliveryFindingSchema).max(64),
  repairPlan: z.string().max(12_000).nullable(),
}).superRefine((value, context) => {
  const findingIds = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    if (findingIds.has(finding.findingId)) context.addIssue({ code: "custom", path: ["findings", index, "findingId"], message: "Finding IDs must be unique within a review" });
    findingIds.add(finding.findingId);
  }
  const openBlocking = value.findings.some((finding) => finding.severity === "blocking" && finding.disposition === "open");
  if (value.outcome === "blocking" && !openBlocking) context.addIssue({ code: "custom", path: ["findings"], message: "A blocking review must contain an open blocking finding" });
  if (value.outcome === "approved" && openBlocking) context.addIssue({ code: "custom", path: ["outcome"], message: "An approved review cannot contain an open blocking finding" });
});

export type DeliveryFinding = z.infer<typeof DeliveryFindingSchema>;
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>;

export const CiRepairPlanSchema = z.object({
  kind: z.literal("ci-repair-plan"),
  ciRunId: durableId,
  ciAttemptId: durableId,
  failedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  rootCause: z.string().min(1).max(2_000),
  failedChecks: z.array(z.object({ name: z.string().min(1).max(200), evidenceArtifactId: durableId, diagnosis: z.string().min(1).max(2_000) }).strict()).min(1),
  steps: z.array(z.object({ number: z.number().int().positive(), instruction: z.string().min(1).max(2_000), verification: z.string().min(1).max(1_000) }).strict()).min(1),
  localVerification: z.array(z.string().min(1).max(500)).min(1),
  unresolvedQuestions: z.array(z.string().min(1).max(1_000)).max(0),
}).strict().superRefine((value, context) => {
  value.steps.forEach((step, index) => { if (step.number !== index + 1) context.addIssue({ code: "custom", path: ["steps", index, "number"], message: "Repair step numbers must be contiguous" }); });
});
export type CiRepairPlan = z.infer<typeof CiRepairPlanSchema>;

export const MergeConflictPlanSchema = z.object({
  kind: z.literal("merge_conflict_plan"),
  summary: z.string().min(1).max(2_000),
  resolutions: z.array(z.object({ file: z.string().min(1).max(1_000), resolution: z.string().min(1).max(8_000), number: z.number().int().positive().optional(), intendedResult: z.string().min(1).max(4_000).optional(), issueInvariant: z.string().min(1).max(4_000).optional(), baseInvariant: z.string().min(1).max(4_000).optional(), compatibilityConcern: z.string().min(1).max(4_000).optional() })).min(1).max(128),
  verificationStrategy: z.string().min(1).max(12_000),
  unresolvedQuestions: z.array(z.string().max(2_000)).max(16).length(0),
});

export type MergeConflictPlan = z.infer<typeof MergeConflictPlanSchema>;

export const IssuePhaseSchema = z.enum(["backlog", "planning", "supplemental_review", "plan_consolidation", "approval", "blocked", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done", "delivery_blocked", "cancelled", "failed"]);
export type IssuePhase = z.infer<typeof IssuePhaseSchema>;
export const IssueLeadOutputKindSchema = z.enum(["plan", "decision_blocker"]);
export const IssueCommandSchema = z.enum(["start_planning", "request_supplemental_review", "approve_plan", "request_plan_revision", "reject_plan", "respond_plan_blocker", "revise_plan", "record_progress", "start_development", "retry_development", "cancel_development", "verify_developer_ownership", "review_delivery", "repair_delivery", "record_delivery_decision", "publish_draft", "resolve_merge_conflict", "retry_target_base_reconciliation", "retry_forward_merge_verification", "reconcile_ci", "repair_ci", "final_review", "accept_delivery", "request_delivery_changes", "reconcile_acceptance", "cancel_issue", "reconcile_merge", "continue_work", "retry_capacity"]);
export type IssueCommand = z.infer<typeof IssueCommandSchema>;
export const IssuePlanDecisionSchema = z.enum(["approve", "request_revision", "reject"]);
export const AttentionCategorySchema = z.enum(["member_authorization", "member_decision", "agent_contradiction", "agent_exhausted", "unsafe_recovery", "provider_ambiguity", "provider_authentication", "provider_connectivity_exhausted", "verification_unrecoverable", "target_drift", "capacity_exhausted"]);
export type AttentionCategory = z.infer<typeof AttentionCategorySchema>;
export const IssueBlockerActionSchema = z.object({ command: IssueCommandSchema, label: z.string().min(1).max(120), requiresNote: z.boolean(), destructive: z.boolean() });
export type IssueBlockerAction = z.infer<typeof IssueBlockerActionSchema>;
export const ArtifactPointerSchema = z.object({ artifactId: durableId, sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["attention-evidence", "lead-plan", "decision-blocker", "delivery-review", "developer-delivery", "developer-repair", "ci-evidence", "merge-conflict-plan", "merge-conflict-resolution"]) });
export type ArtifactPointer = z.infer<typeof ArtifactPointerSchema>;
export const IssueBlockerRetrySchema = z.object({ attempt: z.number().int().nonnegative(), retryAt: z.string().datetime().nullable(), exhausted: z.boolean() });
export const IssueBlockerSchema = z.object({ category: AttentionCategorySchema, summary: SafeSummarySchema, unblockOwner: z.enum(["human", "lead", "developer", "system"]), actions: z.array(IssueBlockerActionSchema).min(1).max(3), evidence: ArtifactPointerSchema, createdAt: z.string().datetime(), retry: IssueBlockerRetrySchema.nullable() });
export type IssueBlocker = z.infer<typeof IssueBlockerSchema>;
export const RepairAuthoritySchema = z.enum(["delivery_review", "final_review", "ci_failure", "member_requested_changes"]);
export const IssueContinuationStateSchema = z.object({
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(IssueCommandSchema),
  pendingAction: z.string().max(200).nullable(),
  blockerCode: z.string().max(128).nullable().optional(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  blocker: IssueBlockerSchema.nullable().optional(),
  stateChangedAt: z.string().datetime().optional(),
  activeOperation: ActiveOperationSchema.optional(),
  processedCommandIds: z.array(durableId).max(64).optional(),
  ...DeveloperRecoveryFields,
  capacity: WorkflowCapacityStateSchema.nullable().optional(),
  capacityBlocker: CapacityBlockerSchema.nullable().optional(),
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: SafeSummarySchema.nullable().optional(),
  originalPlanSubject: PlanSubjectSchema.nullable().optional(),
  finalPlanSubject: PlanSubjectSchema.nullable().optional(),
  materialityEvidence: MaterialityEvidenceSubjectSchema.nullable().optional(),
  supplementalReviewSubject: SupplementalReviewSubjectSchema.nullable().optional(),
  supplementalReviewArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  leadReviewResponseArtifactId: durableId.nullable().optional(),
  leadReviewResponseArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  planDecisionReceipt: z.object({ idempotencyKey: DecisionIdempotencyKeySchema, decisionId: durableId, decision: z.enum(["approve", "request_revision"]), subjectHash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  planBlockerSubject: PlanBlockerSubjectSchema.nullable().optional(),
  planBlockerResponseReceipt: z.object({ idempotencyKey: DecisionIdempotencyKeySchema, responseId: durableId, blockerSubjectHash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  planRevision: z.number().int().nonnegative().nullable().optional(),
  planMaterial: z.boolean().nullable().optional(),
  preservedWorktreeCompatibility: z.boolean().nullable().optional(),
  materialCategories: z.array(PlanMaterialCategorySchema).max(6).optional(),
  supplementalReviewUsed: z.boolean().optional(),
  supplementalReviewArtifactId: durableId.nullable().optional(),
  decisionId: durableId.nullable().optional(),
  developerExecutionId: durableId.nullable().optional(),
  developerSessionRef: durableId.nullable().optional(),
  worktreePath: z.string().max(1_000).nullable().optional(),
  branchName: z.string().max(256).nullable().optional(),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  currentStep: z.number().int().positive().nullable().optional(),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  dirtyState: z.enum(["clean", "dirty"]).nullable().optional(),
  deliveryArtifactId: durableId.nullable().optional(),
  deliveryArtifact: DurableArtifactReferenceSchema.optional(),
  developerEvidenceArtifactId: durableId.nullable().optional(),
  developerEvidenceArtifact: DurableArtifactReferenceSchema.optional(),
  deliverySummary: SafeSummarySchema.nullable().optional(),
  developerOutcome: z.enum(["completed", "blocked"]).nullable().optional(),
  deliveryReviewId: durableId.nullable().optional(),
  deliveryReviewAttemptId: durableId.nullable().optional(),
  deliveryReviewBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryReviewBlockerSummary: blockSummary.nullable().optional(),
  deliveryReviewBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryReviewSupersedesId: durableId.nullable().optional(),
  deliveryReviewArtifact: DurableArtifactReferenceSchema.optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: SafeSummarySchema.nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  deliveryRepairPlan: z.string().max(12_000).nullable().optional(),
  deliveryRepairPlanArtifactId: durableId.nullable().optional(),
  deliveryRepairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  deliveryRepairAuthority: RepairAuthoritySchema.nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
  deliveryRepairAttemptId: durableId.nullable().optional(),
  deliveryRepairBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryRepairBlockerSummary: blockSummary.nullable().optional(),
  deliveryRepairBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergePriorTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeConflictEvidence: DurableArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFiles: z.array(z.string().max(1_000)).max(128).optional(),
  forwardMergeConflictDiff: z.string().max(80_000).nullable().optional(),
  targetBaseCheckId: durableId.nullable().optional(),
  targetBaseCheckpoint: TargetBaseCheckpointSchema.nullable().optional(),
  targetBaseOutcome: z.enum(["no_drift", "revalidated", "conflict", "blocked"]).nullable().optional(),
  targetBaseBlockerCode: TargetBaseBlockerCodeSchema.nullable().optional(),
  targetBaseBlockerOwner: z.enum(["human", "provider", "lead"]).nullable().optional(),
  targetBaseBlockerRetryable: z.boolean().nullable().optional(),
  targetBaseBlockerSummary: z.string().max(500).nullable().optional(),
  forwardMergeConflictArtifact: ArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFileCount: z.number().int().nonnegative().max(128).nullable().optional(),
  mergeResolutionPlanId: durableId.nullable().optional(),
  mergeResolutionPlanArtifactId: durableId.nullable().optional(),
  mergeResolutionLeadExecutionId: durableId.nullable().optional(),
  mergeResolutionLeadSessionRef: durableId.nullable().optional(),
  mergeResolutionDeveloperExecutionId: durableId.nullable().optional(),
  mergeResolutionDeveloperSessionRef: durableId.nullable().optional(),
  releaseId: durableId.nullable().optional(),
  releaseRepository: z.string().max(256).nullable().optional(),
  baseBranch: z.string().max(256).nullable().optional(),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  pullRequestUrl: z.string().url().max(2_000).nullable().optional(),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  expectedHeadTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  ciRunId: durableId.nullable().optional(),
  ciAttempt: z.number().int().nonnegative().optional(),
  ciOutcome: z.enum(["waiting", "passed", "failed", "missing_required", "cancelled", "timed_out", "non_success", "stale_head", "rate_limited", "provider_unavailable", "invalid_provider_response"]).nullable().optional(),
  ciReason: z.string().max(128).nullable().optional(),
  ciOwner: z.enum(["system", "lead", "human"]).nullable().optional(),
  ciRepairable: z.boolean().optional(),
  ciAttemptId: durableId.nullable().optional(),
  ciEvidenceArtifactId: durableId.nullable().optional(),
  ciPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  ciPropagationDeadline: z.string().datetime().nullable().optional(),
  ciOverallDeadline: z.string().datetime().nullable().optional(),
  ciRepairPlanId: durableId.nullable().optional(),
  ciRepairPlanArtifactId: durableId.nullable().optional(),
  ciRepairPlanEvidenceArtifactId: durableId.nullable().optional(),
  ciRepairPlanSummary: z.string().max(2_000).nullable().optional(),
  ciRepairLeadExecutionId: durableId.nullable().optional(),
  ciRepairLeadSessionRef: durableId.nullable().optional(),
  ciRepairDeveloperExecutionId: durableId.nullable().optional(),
  ciRepairDeveloperSessionRef: durableId.nullable().optional(),
  ciNextPollAt: z.string().datetime().nullable().optional(),
  finalReviewId: durableId.nullable().optional(),
  finalReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  finalReviewSummary: z.string().max(2_000).nullable().optional(),
  finalReviewOpinionArtifactId: durableId.nullable().optional(),
  finalReviewEvidenceArtifactId: durableId.nullable().optional(),
  finalReviewFailureCode: z.literal("final_review_unavailable").nullable().optional(),
  finalReviewFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  finalReviewRepairPlanArtifactId: durableId.nullable().optional(),
  finalReviewRepairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  acceptanceId: durableId.nullable().optional(),
  acceptanceStatus: z.enum(["pending_ready", "accepted", "requested_changes", "cancelled", "blocked"]).nullable().optional(),
  acceptanceAttempt: z.number().int().nonnegative().optional(),
  acceptanceRetryAt: z.string().datetime().nullable().optional(),
  acceptanceBlockerCode: durableId.nullable().optional(),
  acceptanceBlockerEvidenceArtifactId: durableId.nullable().optional(),
  acceptanceReasonArtifactId: durableId.nullable().optional(),
  acceptedAt: z.string().datetime().nullable().optional(),
  readyAt: z.string().datetime().nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeAttempt: z.number().int().nonnegative().optional(),
  mergeRetryAt: z.string().datetime().nullable().optional(),
  mergeObservationId: durableId.nullable().optional(),
  mergeBlockerCode: durableId.nullable().optional(),
  mergeBlockerEvidenceArtifactId: durableId.nullable().optional(),
  completionReceiptId: durableId.nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed_head", "changed_base", "provider_unavailable"]).nullable().optional(),
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
  releaseStatus: z.enum(["reconciling", "draft", "blocked"]).nullable().optional(),
  releaseFailureCode: ReleaseFailureCodeSchema.nullable().optional(),
  releaseFailureSummary: z.string().max(500).nullable().optional(),
  releaseRetryAt: z.string().datetime().nullable().optional(),
  releaseOperationAttempt: z.number().int().nonnegative().nullable().optional(),
  revisionRequestId: durableId.nullable().optional(),
  revisedExecutionCoordinates: RevisedExecutionCoordinatesSchema.nullable().optional(),
  successorReference: SuccessorReferenceSchema.nullable().optional(),
});

export const IssueWorkflowInputWithContinuationSchema = z.object({
  continuationState: IssueContinuationStateSchema.optional(),
  continueAsNewAfter: z.number().int().min(0).max(10_000).optional(),
});

export const IssueWorkflowInputSchema = z.object({
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  briefSha256: z.string().regex(/^[a-f0-9]{64}$/),
  imageArtifactIds: z.array(durableId).max(32),
  // A compact identity marker lets a start retry prove it refers to the same
  // creation request without putting task content in Temporal history.
  requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  predecessorTaskId: durableId.optional(),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  supplementalReview: z.boolean(),
  repairCycleLimit: z.number().int().min(0).max(5).default(2),
}).merge(IssueWorkflowInputWithContinuationSchema);

export const IssueWorkflowStateSchema = z.object({
  workflowId: durableId,
  companyId: durableId,
  projectId: durableId,
  issueId: durableId,
  projectRevisionId: durableId,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(IssueCommandSchema),
  pendingAction: z.string().max(200).nullable(),
  blockerCode: z.string().max(128).nullable().optional(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  blocker: IssueBlockerSchema.nullable().optional(),
  stateChangedAt: z.string().datetime().optional(),
  activeOperation: ActiveOperationSchema.optional(),
  processedCommandIds: z.array(durableId).max(64).optional(),
  ...DeveloperRecoveryFields,
  capacity: WorkflowCapacityStateSchema.nullable().optional(),
  capacityBlocker: CapacityBlockerSchema.nullable().optional(),
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: SafeSummarySchema.nullable().optional(),
  originalPlanSubject: PlanSubjectSchema.nullable().optional(),
  finalPlanSubject: PlanSubjectSchema.nullable().optional(),
  materialityEvidence: MaterialityEvidenceSubjectSchema.nullable().optional(),
  supplementalReviewSubject: SupplementalReviewSubjectSchema.nullable().optional(),
  supplementalReviewArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  leadReviewResponseArtifactId: durableId.nullable().optional(),
  leadReviewResponseArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  planDecisionReceipt: z.object({ idempotencyKey: DecisionIdempotencyKeySchema, decisionId: durableId, decision: z.enum(["approve", "request_revision"]), subjectHash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  planBlockerSubject: PlanBlockerSubjectSchema.nullable().optional(),
  planBlockerResponseReceipt: z.object({ idempotencyKey: DecisionIdempotencyKeySchema, responseId: durableId, blockerSubjectHash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  planRevision: z.number().int().nonnegative().nullable().optional(),
  planMaterial: z.boolean().nullable().optional(),
  preservedWorktreeCompatibility: z.boolean().nullable().optional(),
  materialCategories: z.array(PlanMaterialCategorySchema).max(6).optional(),
  supplementalReviewUsed: z.boolean().optional(),
  supplementalReviewArtifactId: durableId.nullable().optional(),
  decisionId: durableId.nullable().optional(),
  developerExecutionId: durableId.nullable().optional(),
  developerSessionRef: durableId.nullable().optional(),
  worktreePath: z.string().max(1_000).nullable().optional(),
  branchName: z.string().max(256).nullable().optional(),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  currentStep: z.number().int().positive().nullable().optional(),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  dirtyState: z.enum(["clean", "dirty"]).nullable().optional(),
  deliveryArtifactId: durableId.nullable().optional(),
  deliveryArtifact: DurableArtifactReferenceSchema.optional(),
  developerEvidenceArtifactId: durableId.nullable().optional(),
  developerEvidenceArtifact: DurableArtifactReferenceSchema.optional(),
  deliverySummary: SafeSummarySchema.nullable().optional(),
  developerOutcome: z.enum(["completed", "blocked"]).nullable().optional(),
  deliveryReviewId: durableId.nullable().optional(),
  deliveryReviewAttemptId: durableId.nullable().optional(),
  deliveryReviewBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryReviewBlockerSummary: blockSummary.nullable().optional(),
  deliveryReviewBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryReviewSupersedesId: durableId.nullable().optional(),
  deliveryReviewArtifact: DurableArtifactReferenceSchema.optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: SafeSummarySchema.nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  deliveryRepairPlan: z.string().max(12_000).nullable().optional(),
  deliveryRepairPlanArtifactId: durableId.nullable().optional(),
  deliveryRepairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  deliveryRepairAuthority: RepairAuthoritySchema.nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
  deliveryRepairAttemptId: durableId.nullable().optional(),
  deliveryRepairBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryRepairBlockerSummary: blockSummary.nullable().optional(),
  deliveryRepairBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergePriorTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeConflictEvidence: DurableArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFiles: z.array(z.string().max(1_000)).max(128).optional(),
  forwardMergeConflictDiff: z.string().max(80_000).nullable().optional(),
  targetBaseCheckId: durableId.nullable().optional(),
  targetBaseCheckpoint: TargetBaseCheckpointSchema.nullable().optional(),
  targetBaseOutcome: z.enum(["no_drift", "revalidated", "conflict", "blocked"]).nullable().optional(),
  targetBaseBlockerCode: TargetBaseBlockerCodeSchema.nullable().optional(),
  targetBaseBlockerOwner: z.enum(["human", "provider", "lead"]).nullable().optional(),
  targetBaseBlockerRetryable: z.boolean().nullable().optional(),
  targetBaseBlockerSummary: z.string().max(500).nullable().optional(),
  forwardMergeConflictArtifact: ArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFileCount: z.number().int().nonnegative().max(128).nullable().optional(),
  mergeResolutionPlanId: durableId.nullable().optional(),
  mergeResolutionPlanArtifactId: durableId.nullable().optional(),
  mergeResolutionLeadExecutionId: durableId.nullable().optional(),
  mergeResolutionLeadSessionRef: durableId.nullable().optional(),
  mergeResolutionDeveloperExecutionId: durableId.nullable().optional(),
  mergeResolutionDeveloperSessionRef: durableId.nullable().optional(),
  releaseId: durableId.nullable().optional(),
  releaseRepository: z.string().max(256).nullable().optional(),
  baseBranch: z.string().max(256).nullable().optional(),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  pullRequestUrl: z.string().url().max(2_000).nullable().optional(),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  expectedHeadTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  ciRunId: durableId.nullable().optional(),
  ciAttempt: z.number().int().nonnegative().optional(),
  ciOutcome: z.enum(["waiting", "passed", "failed", "missing_required", "cancelled", "timed_out", "non_success", "stale_head", "rate_limited", "provider_unavailable", "invalid_provider_response"]).nullable().optional(),
  ciReason: z.string().max(128).nullable().optional(),
  ciOwner: z.enum(["system", "lead", "human"]).nullable().optional(),
  ciRepairable: z.boolean().optional(),
  ciAttemptId: durableId.nullable().optional(),
  ciEvidenceArtifactId: durableId.nullable().optional(),
  ciPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  ciPropagationDeadline: z.string().datetime().nullable().optional(),
  ciOverallDeadline: z.string().datetime().nullable().optional(),
  ciRepairPlanId: durableId.nullable().optional(),
  ciRepairPlanArtifactId: durableId.nullable().optional(),
  ciRepairPlanEvidenceArtifactId: durableId.nullable().optional(),
  ciRepairPlanSummary: z.string().max(2_000).nullable().optional(),
  ciRepairLeadExecutionId: durableId.nullable().optional(),
  ciRepairLeadSessionRef: durableId.nullable().optional(),
  ciRepairDeveloperExecutionId: durableId.nullable().optional(),
  ciRepairDeveloperSessionRef: durableId.nullable().optional(),
  ciNextPollAt: z.string().datetime().nullable().optional(),
  finalReviewId: durableId.nullable().optional(),
  finalReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  finalReviewSummary: z.string().max(2_000).nullable().optional(),
  finalReviewOpinionArtifactId: durableId.nullable().optional(),
  finalReviewEvidenceArtifactId: durableId.nullable().optional(),
  finalReviewFailureCode: z.literal("final_review_unavailable").nullable().optional(),
  finalReviewFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  finalReviewRepairPlanArtifactId: durableId.nullable().optional(),
  finalReviewRepairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  acceptanceId: durableId.nullable().optional(),
  acceptanceStatus: z.enum(["pending_ready", "accepted", "requested_changes", "cancelled", "blocked"]).nullable().optional(),
  acceptanceAttempt: z.number().int().nonnegative().optional(),
  acceptanceRetryAt: z.string().datetime().nullable().optional(),
  acceptanceBlockerCode: durableId.nullable().optional(),
  acceptanceBlockerEvidenceArtifactId: durableId.nullable().optional(),
  acceptanceReasonArtifactId: durableId.nullable().optional(),
  acceptedAt: z.string().datetime().nullable().optional(),
  readyAt: z.string().datetime().nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeAttempt: z.number().int().nonnegative().optional(),
  mergeRetryAt: z.string().datetime().nullable().optional(),
  mergeObservationId: durableId.nullable().optional(),
  mergeBlockerCode: durableId.nullable().optional(),
  mergeBlockerEvidenceArtifactId: durableId.nullable().optional(),
  completionReceiptId: durableId.nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed_head", "changed_base", "provider_unavailable"]).nullable().optional(),
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
  releaseStatus: z.enum(["reconciling", "draft", "blocked"]).nullable().optional(),
  releaseFailureCode: ReleaseFailureCodeSchema.nullable().optional(),
  releaseFailureSummary: z.string().max(500).nullable().optional(),
  releaseRetryAt: z.string().datetime().nullable().optional(),
  releaseOperationAttempt: z.number().int().nonnegative().nullable().optional(),
  revisionRequestId: durableId.nullable().optional(),
  revisedExecutionCoordinates: RevisedExecutionCoordinatesSchema.nullable().optional(),
  successorReference: SuccessorReferenceSchema.nullable().optional(),
}).superRefine((state, context) => {
  if (state.blocker?.unblockOwner !== "human") return;
  if (state.owner !== "human") context.addIssue({ code: "custom", path: ["owner"], message: "Human blockers require human ownership" });
  if (state.blocker.retry && !state.blocker.retry.exhausted && state.blocker.retry.retryAt !== null) context.addIssue({ code: "custom", path: ["blocker", "retry"], message: "Retryable blockers cannot be surfaced as human attention" });
  for (const action of state.blocker.actions) {
    if (!state.allowedCommands.includes(action.command)) context.addIssue({ code: "custom", path: ["allowedCommands"], message: "Blocker actions must be legal in the current state" });
    if (action.destructive !== (action.command === "cancel_issue")) context.addIssue({ code: "custom", path: ["blocker", "actions"], message: "Only issue cancellation is destructive" });
    if (["reject_plan", "record_delivery_decision", "request_delivery_changes"].includes(action.command) && !action.requiresNote) context.addIssue({ code: "custom", path: ["blocker", "actions"], message: "This action requires a note" });
  }
});

export function buildInitialIssueWorkflowState(input: IssueWorkflowInput & { stateChangedAt?: string }): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    workflowId: input.workflowId,
    companyId: input.companyId,
    projectId: input.projectId,
    issueId: input.issueId,
    projectRevisionId: input.projectRevisionId,
    ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    ...(input.predecessorTaskId ? { predecessorTaskId: input.predecessorTaskId } : {}),
    phase: "backlog",
    revision: 0,
    owner: "human",
    allowedCommands: ["start_planning"],
    pendingAction: "Start planning",
    lastEventId: `${input.workflowId}:0`,
    continuationCount: 0,
    lastSummaryHash: null,
    repairCycle: 0,
    blocker: null,
    stateChangedAt: input.stateChangedAt ?? new Date().toISOString(),
    activeOperation: null,
    processedCommandIds: [],
  });
}

export const createInitialIssueWorkflowState = buildInitialIssueWorkflowState;

export const IssueProjectionEventSchema = z.object({
  schemaVersion: z.literal(1),
  runId: durableId,
  eventId: durableId,
  state: IssueWorkflowStateSchema,
}).superRefine((event, context) => {
  if (event.eventId !== event.state.lastEventId) context.addIssue({ code: "custom", path: ["eventId"], message: "Projection event ID must match state.lastEventId" });
});

export type IssueProjectionEvent = z.infer<typeof IssueProjectionEventSchema>;

export const StartPlanningInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  commandId: durableId.optional().default("legacy-command"),
});

export const RecordProgressInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/),
  commandId: durableId.optional().default("legacy-command"),
});

export const PlanCommandInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  commandId: durableId.optional().default("legacy-command"),
  note: z.string().max(4_000).optional(),
  worktreeDecision: z.enum(["reuse", "new"]).optional(),
  exactBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  decision: z.enum(["accept", "request_changes", "cancel"]).optional(),
  subject: z.union([PlanDecisionSubjectSchema, SupplementalReviewSubjectSchema, PlanBlockerSubjectSchema]).optional(),
  idempotencyKey: DecisionIdempotencyKeySchema.optional(),
  noteStagingRef: durableId.optional(),
  noteSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  blockerSubject: PlanBlockerSubjectSchema.optional(),
  expectedWorkflowRevision: z.number().int().nonnegative().optional(),
  answerStagingRef: durableId.optional(),
  answerSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const RevisionCommandBaseSchema = z.object({ expectedRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000) }).strict();
export const PlanRevisionCommandSchema = z.discriminatedUnion("worktreeDisposition", [
  RevisionCommandBaseSchema.extend({ worktreeDisposition: z.literal("reuse") }).strict(),
  RevisionCommandBaseSchema.extend({ worktreeDisposition: z.literal("new"), exactBaseSha: exactSha }).strict(),
]);
export const ContinueWorkCommandSchema = z.object({ expectedRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000) }).strict();
export const WorkflowPlanDecisionCommandSchema = z.object({
  actorUserId: durableId,
  decision: z.enum(["approve", "request_revision"]),
  subject: PlanDecisionSubjectSchema,
  noteStagingRef: durableId,
  noteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: DecisionIdempotencyKeySchema,
}).strict();

export const WorkflowPlanBlockerResponseCommandSchema = z.object({
  actorUserId: durableId,
  subject: PlanBlockerSubjectSchema,
  expectedWorkflowRevision: z.number().int().nonnegative(),
  answerStagingRef: durableId,
  answerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: DecisionIdempotencyKeySchema,
}).strict();

export type IssueWorkflowInput = z.input<typeof IssueWorkflowInputSchema>;
export type IssueWorkflowState = z.infer<typeof IssueWorkflowStateSchema>;
export type StartPlanningInput = z.input<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.input<typeof RecordProgressInputSchema>;
export type PlanCommandInput = z.input<typeof PlanCommandInputSchema>;
export type PlanRevisionCommand = z.infer<typeof PlanRevisionCommandSchema>;
export type ContinueWorkCommand = z.infer<typeof ContinueWorkCommandSchema>;
export type WorkflowPlanDecisionCommand = z.infer<typeof WorkflowPlanDecisionCommandSchema>;
export type WorkflowPlanBlockerResponseCommand = z.infer<typeof WorkflowPlanBlockerResponseCommandSchema>;

const DeliveryReviewActivityInputCoreSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  planRevision: z.number().int().nonnegative(),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  leadOutputArtifactId: durableId,
  subject: DeliveryReviewSubjectSchema,
  worktreePath: z.string().min(1).max(1_000),
  branchName: z.string().min(1).max(256),
  reviewKind: z.enum(["delivery", "final"]).optional(),
  releaseId: durableId.optional(),
  ciRunId: durableId.optional(),
  supersedesReviewId: durableId.nullable().default(null),
  deliveryReviewId: durableId.optional(),
  capacityRequestId: durableId.optional(),
}).strict().superRefine((value, context) => {
  if (value.reviewKind === "final" && !value.deliveryReviewId) context.addIssue({ code: "custom", path: ["deliveryReviewId"], message: "Final review requires the exact delivery review" });
});

export const DeliveryReviewActivityInputSchema = DeliveryReviewActivityInputCoreSchema;

type ParsedDeliveryReviewActivityInput = z.infer<typeof DeliveryReviewActivityInputSchema>;
export type DeliveryReviewActivityInput = Omit<ParsedDeliveryReviewActivityInput, "supersedesReviewId"> & { supersedesReviewId?: string | null };
export type DeliveryReviewServiceInput = DeliveryReviewActivityInput;

export const DeliveryReviewActivityResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    attemptId: durableId,
    correctionAttempts: z.number().int().min(0).max(1),
    subject: DeliveryReviewSubjectSchema,
    review: z.object({
      reviewId: durableId,
      leadExecutionId: durableId,
      leadSessionRef: durableId,
      opinionArtifactId: durableId,
      evidenceArtifactId: durableId,
      opinion: z.enum(["approved", "blocking"]),
      summary: z.string().min(1).max(2_000),
      repairPlan: z.string().max(12_000).nullable(),
      repairPlanArtifactId: durableId.nullable().optional(),
      repairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
      findings: z.array(DeliveryFindingSchema).max(64),
      supersedesReviewId: durableId.nullable(),
      reviewArtifact: DurableArtifactReferenceSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    outcome: z.literal("blocked"),
    attemptId: durableId,
    code: DeliveryOperationBlockCodeSchema,
    summary: blockSummary,
    evidenceArtifactId: durableId,
    executionId: durableId,
    sessionRef: durableId,
    correctionAttempts: z.number().int().min(0).max(1),
    subject: DeliveryReviewSubjectSchema,
  }).strict(),
]);
export type DeliveryReviewActivityResult = z.infer<typeof DeliveryReviewActivityResultSchema>;

export const DeveloperRepairActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  planRevision: z.number().int().nonnegative(),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  leadSessionRef: durableId,
  developerSessionRef: durableId,
  developerExecutionId: durableId,
  reviewId: durableId,
  repairAuthority: RepairAuthoritySchema.default("delivery_review"),
  reviewArtifact: DurableArtifactReferenceSchema.optional(),
  cycle: z.number().int().positive(),
  repairCycleLimit: z.number().int().min(0).max(5),
  worktreePath: z.string().min(1).max(1_000),
  branchName: z.string().min(1).max(256),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  blockingFindings: z.array(DeliveryFindingSchema).max(64),
  repairPlan: z.string().min(1).max(12_000).optional(),
  repairPlanArtifactId: durableId.optional(),
  repairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  capacityRequestId: durableId.optional(),
}).superRefine((value, context) => {
  if (!value.repairPlan && !value.repairPlanArtifactId) context.addIssue({ code: "custom", path: ["repairPlanArtifactId"], message: "A verified repair-plan artifact is required" });
  if (value.repairPlanArtifactId && !value.repairPlanSha256) context.addIssue({ code: "custom", path: ["repairPlanSha256"], message: "The repair-plan artifact hash is required" });
});

const repairSubject = DeliveryReviewSubjectSchema;
export const DeveloperRepairActivityResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    repairAttemptId: durableId,
    cycle: z.number().int().positive(),
    reviewId: durableId,
    subject: repairSubject,
    developerExecutionId: durableId,
    developerSessionRef: durableId,
    worktreePath: z.string().min(1).max(1_000),
    branchName: z.string().min(1).max(256),
    resultCommit: sha,
    resultTree: sha,
    dirtyState: z.literal("clean"),
    deliveryArtifactId: durableId,
    evidenceArtifactId: durableId,
    summary: z.string().min(1).max(2_000),
  }).strict(),
  z.object({
    outcome: z.literal("blocked"),
    repairAttemptId: durableId,
    cycle: z.number().int().positive(),
    reviewId: durableId,
    subject: repairSubject,
    code: DeliveryOperationBlockCodeSchema,
    summary: blockSummary,
    evidenceArtifactId: durableId,
    developerExecutionId: durableId,
    developerSessionRef: durableId,
    worktreePath: z.string().min(1).max(1_000),
    branchName: z.string().min(1).max(256),
    resultCommit: sha.nullable(),
    resultTree: sha.nullable(),
    dirtyState: z.enum(["clean", "dirty"]).nullable(),
  }).strict(),
]);
export type DeveloperRepairActivityResult = z.infer<typeof DeveloperRepairActivityResultSchema>;

export const DeliveryDecisionActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  actorUserId: durableId,
  note: z.string().min(1).max(4_000),
});

export interface LeadPlanningActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  imageArtifactIds: string[];
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
  revision: number;
  revisionRequestId?: string;
  resumeLeadSessionRef?: string;
  capacityRequestId?: string;
  leadSessionRef?: string;
  revisionNoteArtifactId?: string;
  revisionNoteSha256?: string;
  memberResponseArtifactId?: string;
  memberResponseSha256?: string;
}

export interface LeadPlanningResult {
  leadSessionRef: string;
  leadExecutionId: string;
  leadEvidenceArtifactId: string;
  leadEvidenceArtifactSha256?: string;
  leadOutputArtifactId: string;
  leadOutputArtifactSha256?: string;
  leadOutputKind: "plan" | "decision_blocker";
  leadSummary: string;
  materialCategories: PlanMaterialCategory[];
  material: boolean;
  preservedWorktreeCompatibility?: boolean | null;
  planSubject?: PlanSubject;
  materialityEvidence?: MaterialityEvidenceSubject;
  blockerSubject?: PlanBlockerSubject;
  leadReviewResponseArtifactId?: string;
  leadReviewResponseArtifactSha256?: string;
}

export interface SupplementalReviewActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  imageArtifactIds: string[];
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
  revision: number;
  leadOutputArtifactId: string;
  leadEvidenceArtifactId: string;
  capacityRequestId?: string;
  evidenceManifestArtifactId?: string;
  evidenceManifestSha256?: string;
  primaryLeadSessionRef?: string;
  originalPlanSubject?: PlanSubject;
}

export interface SupplementalReviewResult {
  reviewId: string;
  reviewArtifactId: string;
  evidenceArtifactId: string;
  executionId: string;
  sessionRef: string;
  summary: string;
  subject?: SupplementalReviewSubject;
  reviewArtifactSha256?: string;
  evidenceManifestArtifactId?: string;
  evidenceManifestSha256?: string;
}

export interface ConsolidateLeadPlanActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  imageArtifactIds: string[];
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
  revision: number;
  leadSessionRef: string;
  leadOutputArtifactId: string;
  supplementalReviewArtifactId: string;
  capacityRequestId?: string;
  evidenceManifestArtifactId?: string;
  evidenceManifestSha256?: string;
  originalPlanSubject?: PlanSubject;
}

export interface PlanDecisionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  planRevision: number;
  actorUserId: string;
  decision: "approve" | "request_revision" | "reject";
  note?: string;
  revisionRequestId?: string;
  subject?: PlanDecisionSubject;
  noteStagingRef?: string;
  noteSha256?: string;
  idempotencyKey?: string;
}

export interface PlanBlockerResponseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  blockerSubject: PlanBlockerSubject;
  expectedWorkflowRevision: number;
  answerStagingRef: string;
  answerSha256: string;
  idempotencyKey: string;
}

export const PreparePlanRevisionActivityInputSchema = z.object({
  taskId: durableId, companyId: durableId, workflowId: durableId, projectId: durableId, projectRevisionId: durableId,
  requestRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000),
  worktreeDisposition: z.enum(["reuse", "new"]), exactBaseSha: exactSha.optional(), developerExecutionId: durableId.optional(),
}).strict().superRefine((value, context) => {
  if (value.worktreeDisposition === "new" && !value.exactBaseSha) context.addIssue({ code: "custom", path: ["exactBaseSha"], message: "New worktrees require an exact base SHA" });
  if (value.worktreeDisposition === "reuse" && value.exactBaseSha) context.addIssue({ code: "custom", path: ["exactBaseSha"], message: "Reuse does not accept an exact base SHA" });
});
export type PreparePlanRevisionActivityInput = z.infer<typeof PreparePlanRevisionActivityInputSchema>;
export const PreparePlanRevisionActivityResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), revisionRequestId: durableId, coordinates: RevisedExecutionCoordinatesSchema }).strict(),
  z.object({ status: z.literal("blocked"), revisionRequestId: durableId, blockerCode: z.string().min(1).max(128) }).strict(),
]);
export type PreparePlanRevisionActivityResult = z.infer<typeof PreparePlanRevisionActivityResultSchema>;
export const CreateSuccessorActivityInputSchema = z.object({
  predecessorTaskId: durableId, predecessorWorkflowId: durableId, acceptedRevision: z.number().int().nonnegative(), successorTaskId: durableId,
  successorWorkflowId: durableId, companyId: durableId, projectId: durableId, actorUserId: durableId, reason: z.string().trim().min(1).max(4_000),
  intentId: durableId,
}).strict();
export type CreateSuccessorActivityInput = z.infer<typeof CreateSuccessorActivityInputSchema>;
export const CreateSuccessorActivityResultSchema = SuccessorReferenceSchema;
export type CreateSuccessorActivityResult = z.infer<typeof CreateSuccessorActivityResultSchema>;

export interface DeveloperExecutionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  planRevision: number;
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
  leadSessionRef: string;
  leadOutputArtifactId: string;
  revisionRequestId?: string;
  executionId?: string;
  developerExecutionId?: string;
  developerAttempt?: number;
  turnKind?: DeveloperTurnKind;
  finalPlanSubject?: PlanSubject;
  materialityEvidence?: MaterialityEvidenceSubject;
  approvalDecisionId?: string;
  supersedesExecutionId?: string | undefined;
  reuseWorktree?: boolean | undefined;
  capacityRequestId?: string;
}

export interface DeveloperExecutionResult {
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  currentStep: number | null;
  resultCommit: string | null;
  resultTree: string | null;
  dirtyState: "clean" | "dirty";
  deliveryArtifactId: string;
  deliveryArtifactSha256?: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256?: string;
  attentionEvidenceArtifactId?: string;
  attentionEvidenceSha256?: string;
  deliverySummary: string;
  outcome: "completed" | "blocked";
}

export type WorkflowDeveloperExecutionResult = Omit<DeveloperExecutionResult, "worktreePath">;

export type DeveloperTurnKind = "implementation" | "repair" | "merge_conflict_resolution";

export interface DeveloperSupervisorActivityIdentity {
  developerTurnExecutionId: string;
  developerAttempt: number;
  turnKind: DeveloperTurnKind;
}

export type DeveloperTurnActivityOutcome<T> =
  | { status: "completed"; result: T; resultHash: string }
  | { status: "interrupted"; developerExecutionId: string; reasonCode: string; summary: string; lastHeartbeatAt: string | null }
  | { status: "ownership_ambiguous"; developerExecutionId: string; reasonCode: string; summary: string; lastHeartbeatAt: string | null }
  | { status: "failed"; developerExecutionId: string; reasonCode: string; summary: string; evidenceArtifactId: string | null };

export type SupervisedDeveloperExecutionActivityInput = Omit<DeveloperExecutionActivityInput, "executionId"> & DeveloperSupervisorActivityIdentity;
export type SupervisedDeveloperRepairActivityInput = WorkflowDeveloperRepairActivityInput & DeveloperSupervisorActivityIdentity;
export type SupervisedMergeConflictResolutionActivityInput = WorkflowMergeConflictResolutionActivityInput & DeveloperSupervisorActivityIdentity;

export type DeveloperCancellationResult =
  | { status: "cancelled" }
  | { status: "cancelled_confirmed"; executionId: string; exitCode: number | null; exitSignal: string | null; evidenceArtifactId: string | null }
  | { status: "completed_before_cancellation"; executionId: string; result: unknown; resultHash: string }
  | { status: "interrupted" | "ownership_ambiguous"; executionId: string; reasonCode: string; summary: string }
  | { status: "termination_failed"; executionId: string; reasonCode: string; summary: string; evidenceArtifactId: string | null };

export interface DeveloperOwnershipObservation {
  executionId: string;
  status: "active" | "result_ready" | "interrupted" | "ownership_ambiguous";
  reasonCode: string | null;
  summary: string;
  lastHeartbeatAt: string | null;
}

export interface DeveloperCancellationActivityInput {
  taskId: string;
  companyId: string;
  executionId: string;
}

export type DeliveryReviewResult = DeliveryReviewActivityResult;

/** Workflow-safe review input. The activity resolves the worktree from durable execution state. */
export type WorkflowDeliveryReviewActivityInput = Omit<DeliveryReviewActivityInput, "worktreePath"> & { worktreePath?: string };

export const DeliveryRepairPlanInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  source: z.enum(["ci_failure", "final_review_blocking", "member_requested_changes"]),
  leadSessionRef: durableId,
  planRevision: z.number().int().nonnegative(),
  releaseId: durableId.nullable().optional(),
  deliveryReviewId: durableId.nullable().optional(),
  finalReviewId: durableId.nullable().optional(),
  ciRunId: durableId.nullable().optional(),
  acceptanceId: durableId.nullable().optional(),
  reasonArtifactId: durableId.nullable().optional(),
  evidenceArtifactIds: z.array(durableId).max(32),
  branchName: z.string().min(1).max(256),
  worktreePath: z.string().min(1).max(1_000),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  findings: z.array(DeliveryFindingSchema).min(1).max(64),
  capacityRequestId: durableId.optional(),
});

export type DeliveryRepairPlanActivityInput = z.infer<typeof DeliveryRepairPlanInputSchema>;

export const DeliveryRepairPlanResultSchema = z.object({
  planId: durableId,
  leadExecutionId: durableId,
  planArtifactId: durableId,
  planSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceArtifactId: durableId,
  leadSessionRef: durableId,
  summary: z.string().min(1).max(2_000),
  findings: z.array(DeliveryFindingSchema).max(64),
});

export type DeliveryRepairPlanResult = z.infer<typeof DeliveryRepairPlanResultSchema>;

export interface DeveloperRepairActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  planRevision: number;
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
  leadSessionRef: string;
  developerSessionRef: string;
  developerExecutionId: string;
  reviewId: string;
  repairAuthority?: z.infer<typeof RepairAuthoritySchema>;
  reviewArtifact?: DurableArtifactReference;
  cycle: number;
  repairCycleLimit: number;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  blockingFindings: DeliveryFinding[];
  repairPlan?: string;
  repairPlanArtifactId?: string;
  repairPlanSha256?: string;
  capacityRequestId?: string;
}

export interface LegacyDeveloperRepairResult {
  developerExecutionId: string;
  developerSessionRef: string;
  supersedesExecutionId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  resultCommit: string;
  resultTree: string;
  dirtyState: "clean" | "dirty";
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  deliverySummary: string;
  outcome: "completed" | "blocked";
  cycle: number;
}

export type DeveloperRepairResult = DeveloperRepairActivityResult | LegacyDeveloperRepairResult;
export type WorkflowDeveloperRepairResult =
  | Omit<Extract<DeveloperRepairActivityResult, { outcome: "completed" }>, "worktreePath">
  | Omit<Extract<DeveloperRepairActivityResult, { outcome: "blocked" }>, "worktreePath">;

/** Workflow-safe repair input. Findings and the worktree remain in durable artifacts/database state. */
export type WorkflowDeveloperRepairActivityInput = Omit<DeveloperRepairActivityInput, "worktreePath" | "blockingFindings" | "repairPlan"> & {
  worktreePath?: string;
  blockingFindings?: DeliveryFinding[];
  repairPlan?: string;
};

export interface DeliveryDecisionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  note: string;
}

export interface PublishReleaseActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  reviewId: string;
  developerExecutionId: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  planSummary?: string;
  deliverySummary?: string;
  verificationSummary?: string;
  releaseId?: string;
}

const PublishReleaseIdentitySchema = z.object({
  repository: z.string().max(256),
  branchName: z.string().max(256),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  headTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  reused: z.boolean(),
  attempt: z.number().int().nonnegative(),
});
export const PublishReleaseActivityResultSchema = z.discriminatedUnion("outcome", [
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("completed"), releaseId: durableId, baseBranch: z.string().min(1).max(256), pullRequestNumber: z.number().int().positive(), pullRequestUrl: z.string().url().max(2_000), isDraft: z.literal(true), targetBaseSha: sha.optional() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("blocked"), releaseId: durableId.nullable(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.boolean(), code: ReleaseFailureCodeSchema, summary: z.string().max(500), retryAt: z.string().datetime().nullable(), evidenceArtifactId: durableId.nullable(), evidenceArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("base-drift-merged"), releaseId: z.null(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.literal(false), baseDriftMerged: z.literal(true), targetBaseSha: sha, priorHead: sha, forwardMergeId: durableId.optional(), mergeCommit: sha.optional(), tree: sha.optional() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("base-drift-conflict"), releaseId: z.null(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.literal(false), baseDriftConflict: z.literal(true), targetBaseSha: sha, priorHead: sha, forwardMergeId: durableId.optional(), mergeConflictEvidence: DurableArtifactReferenceSchema.optional(), conflictFiles: z.array(z.string().max(1_000)).max(128).optional(), conflictDiff: z.string().max(80_000).optional() }),
]);
export type PublishReleaseActivityResult = z.infer<typeof PublishReleaseActivityResultSchema>;

export interface MergeConflictPlanActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  planRevision: number;
  forwardMergeId: string;
  leadSessionRef: string;
  leadOutputArtifactId: string;
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictArtifact: ArtifactReference;
  conflictFileCount: number;
  capacityRequestId?: string;
}

export type WorkflowMergeConflictPlanActivityInput = Omit<MergeConflictPlanActivityInput, "worktreePath"> & {
  worktreePath?: string;
};

export interface MergeConflictPlanActivityResult {
  planId: string;
  planArtifactId: string;
  evidenceArtifactId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  summary: string;
}

export interface MergeConflictResolutionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  planRevision: number;
  forwardMergeId: string;
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictArtifact: ArtifactReference;
  conflictFileCount: number;
  planArtifactId: string;
  capacityRequestId?: string;
}

export type WorkflowMergeConflictResolutionActivityInput = Omit<MergeConflictResolutionActivityInput, "worktreePath"> & {
  worktreePath?: string;
};

export interface MergeConflictResolutionActivitySuccess {
  developerExecutionId: string;
  developerSessionRef: string;
  resultCommit: string;
  resultTree: string;
  deliveryArtifactId: string;
  deliveryArtifactSha256: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256: string;
  verificationArtifactId: string;
  verificationArtifactSha256: string;
  summary: string;
}

export interface MergeConflictResolutionVerificationBlocked {
  outcome: "verification_blocked";
  developerExecutionId: string;
  developerSessionRef: string;
  resultCommit: string;
  resultTree: string;
  evidenceArtifactId: string;
  verificationArtifact: ArtifactReference;
  code: "verification_failed" | "verification_timed_out" | "verification_evidence_too_large";
  summary: string;
}

export type MergeConflictResolutionActivityResult = MergeConflictResolutionActivitySuccess | MergeConflictResolutionVerificationBlocked;

export interface ReconcileCiActivityInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  expectedHeadSha: string;
  attemptNumber: number;
}

export interface ReconcileCiActivityResult {
  runId: string;
  attemptId: string;
  attemptNumber: number;
  expectedHeadSha: string;
  observedHeadSha: string | null;
  evidenceArtifactId: string | null;
  evidenceArtifactSha256?: string;
  outcome: "waiting" | "passed" | "failed" | "missing_required" | "cancelled" | "timed_out" | "non_success" | "stale_head" | "rate_limited" | "provider_unavailable" | "invalid_provider_response";
  reason: string;
  owner: "system" | "lead" | "human" | null;
  repairable: boolean;
  summary: string;
  retryAt: string | null;
  nextPollAt: string | null;
  policyHash: string;
  propagationDeadline: string | null;
  overallDeadline: string | null;
}

export interface CiRepairPlanActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  leadSessionRef: string;
  ciRunId: string;
  ciAttemptId: string;
  failedHeadSha: string;
  evidenceArtifactId: string;
  requiredChecks: string[];
  localVerification: string[];
  capacityRequestId?: string;
}

export interface CiRepairPlanActivityResult {
  planId: string;
  planArtifactId: string;
  evidenceArtifactId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  summary: string;
}

export interface CiRepairActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  releaseId?: string;
  projectId: string;
  projectRevisionId: string;
  ciRunId: string;
  ciAttemptId: string;
  repairPlanId: string;
  repairPlanArtifactId: string;
  repairPlanEvidenceArtifactId: string;
  failedHeadSha: string;
  priorDeveloperExecutionId: string;
  priorDeveloperSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorCommit: string;
  priorTree: string;
  capacityRequestId?: string;
}

export interface CiRepairActivityResult {
  repairId: string;
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorCommit: string;
  priorTree: string;
  resultCommit: string | null;
  resultTree: string | null;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  attentionEvidenceArtifactId?: string;
  attentionEvidenceSha256?: string;
  summary: string;
  outcome: "completed" | "blocked";
}

export type WorkflowCiRepairActivityInput = Omit<CiRepairActivityInput, "worktreePath"> & { worktreePath?: string };
export type WorkflowCiRepairActivityResult = Omit<CiRepairActivityResult, "worktreePath">;

export interface FinalReviewActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
  releaseId: string;
  deliveryReviewId: string;
  ciRunId: string;
  pullRequestNumber?: number;
  repository?: string;
  baseBranch?: string;
  planRevision: number;
  leadSessionRef: string;
  leadOutputArtifactId: string;
  developerExecutionId: string;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  capacityRequestId?: string;
}

export type WorkflowFinalReviewActivityInput = Omit<FinalReviewActivityInput, "worktreePath"> & { worktreePath?: string };

export type WorkflowDeliveryReviewResult = DeliveryReviewActivityResult;

export interface FinalReviewActivityResult {
  finalReviewId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  evidenceArtifactSha256?: string;
  reviewArtifact: DurableArtifactReference;
  outcome: "approved" | "blocking";
  summary: string;
  findings: DeliveryFinding[];
  repairPlan: string | null;
  repairPlanArtifactId: string | null;
  repairPlanSha256: string | null;
}

export interface AcceptDeliveryActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectRevisionId: string;
  releaseId: string;
  deliveryReviewId: string;
  finalReviewId: string;
  ciRunId: string;
  actorUserId: string;
  pullRequestNumber: number;
  repository: string;
  baseBranch: string;
  baseSha: string;
  leadSessionRef: string;
  expectedHeadSha: string;
  expectedHeadTree: string;
  note?: string;
}

export interface AcceptDeliveryActivityResult {
  acceptanceId: string | null;
  status: "pending_ready" | "accepted" | "requested_changes" | "cancelled" | "blocked";
  outcome?: "pending_ready" | "ready" | "changed" | "closed" | "merged_early" | "provider_unavailable";
  retryAt?: string | null;
  readyAt?: string | null;
  acceptedAt?: string | null;
  blockerCode?: string;
  blockerSummary?: string;
  evidenceArtifactId?: string | null;
  evidenceArtifactSha256?: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  reasonArtifactId?: string | null;
}

export interface ReconcileAcceptanceActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  acceptanceId: string;
}

export interface ReconcileAcceptanceActivityResult {
  acceptanceId: string;
  status: "pending_ready" | "accepted" | "blocked";
  outcome: "pending_ready" | "ready" | "changed" | "closed" | "merged_early" | "provider_unavailable";
  retryAt: string | null;
  readyAt: string | null;
  acceptedAt: string;
  blockerCode?: string;
  blockerSummary?: string;
  evidenceArtifactId?: string | null;
  evidenceArtifactSha256?: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface ReconcileMergeActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  acceptanceId: string;
}

export interface ReconcileMergeActivityResult {
  outcome: "open" | "merged" | "closed_without_merge" | "changed_head" | "changed_base" | "provider_unavailable";
  pullRequestNumber: number;
  pullRequestUrl: string;
  mergeObservationId: string | null;
  completionReceiptId: string | null;
  observedAt: string;
  mergedAt: string | null;
  retryAt: string | null;
  blockerCode?: string;
  blockerSummary?: string;
  evidenceArtifactId?: string | null;
  evidenceArtifactSha256?: string;
}

export interface IssueActivities {
  projectIssueState(event: IssueProjectionEvent): Promise<IssueWorkflowState>;
  runLeadPlanning(input: LeadPlanningActivityInput): Promise<LeadPlanningResult>;
  findActiveDeveloperExecution(input: { taskId: string; companyId: string; workflowId: string }): Promise<{ executionId: string; sessionRef: string } | null>;
  cancelDeveloperExecution(input: DeveloperCancellationActivityInput): Promise<DeveloperCancellationResult>;
  observeDeveloperExecution(input: DeveloperCancellationActivityInput): Promise<DeveloperOwnershipObservation>;
  preparePlanRevision(input: PreparePlanRevisionActivityInput): Promise<PreparePlanRevisionActivityResult>;
  authorizePlanRevision(input: { taskId: string; companyId: string; workflowId: string; revisionRequestId: string; planRevision: number }): Promise<void>;
  createSuccessor(input: CreateSuccessorActivityInput): Promise<CreateSuccessorActivityResult>;
  runSupplementalReview(input: SupplementalReviewActivityInput): Promise<SupplementalReviewResult>;
  consolidateLeadPlan(input: ConsolidateLeadPlanActivityInput): Promise<LeadPlanningResult>;
  planDeliveryRepair(input: DeliveryRepairPlanActivityInput): Promise<DeliveryRepairPlanResult>;
  runDeveloperExecution(input: DeveloperExecutionActivityInput): Promise<WorkflowDeveloperExecutionResult>;
  runDeveloperExecutionSupervised(input: SupervisedDeveloperExecutionActivityInput): Promise<DeveloperTurnActivityOutcome<WorkflowDeveloperExecutionResult>>;
  reviewDelivery(input: WorkflowDeliveryReviewActivityInput): Promise<WorkflowDeliveryReviewResult>;
  runDeveloperRepair(input: WorkflowDeveloperRepairActivityInput): Promise<WorkflowDeveloperRepairResult>;
  runDeveloperRepairSupervised(input: SupervisedDeveloperRepairActivityInput): Promise<DeveloperTurnActivityOutcome<WorkflowDeveloperRepairResult>>;
  recordPlanDecision(input: PlanDecisionActivityInput): Promise<{ decisionId: string; subjectHash?: string; duplicate?: boolean; noteArtifactId?: string; noteArtifactSha256?: string }>;
  recordPlanBlockerResponse(input: PlanBlockerResponseActivityInput): Promise<{ responseId: string; subjectHash: string; duplicate?: boolean; answerArtifactId?: string; answerArtifactSha256?: string }>;
  recordDeliveryDecision(input: DeliveryDecisionActivityInput): Promise<{ artifactId: string }>;
  cancelCapacityExecution(input: { requestId: string }): Promise<{ status: "cancelled" | "ownership_ambiguous"; executionId?: string | undefined; reason?: string | undefined }>;
  publishRelease(input: PublishReleaseActivityInput): Promise<PublishReleaseActivityResult>;
  reconcileTargetBase(input: ReconcileTargetBaseActivityInput): Promise<ReconcileTargetBaseActivityResult>;
  reconcileCi(input: ReconcileCiActivityInput): Promise<ReconcileCiActivityResult>;
  planCiRepair(input: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult>;
  runCiRepair(input: WorkflowCiRepairActivityInput): Promise<WorkflowCiRepairActivityResult>;
  finalReview(input: WorkflowFinalReviewActivityInput): Promise<FinalReviewActivityResult>;
  acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }): Promise<AcceptDeliveryActivityResult>;
  reconcileAcceptance(input: ReconcileAcceptanceActivityInput): Promise<ReconcileAcceptanceActivityResult>;
  reconcileMerge(input: ReconcileMergeActivityInput): Promise<ReconcileMergeActivityResult>;
  planMergeConflict(input: WorkflowMergeConflictPlanActivityInput): Promise<MergeConflictPlanActivityResult>;
  resolveMergeConflict(input: WorkflowMergeConflictResolutionActivityInput): Promise<MergeConflictResolutionActivityResult>;
  resolveMergeConflictSupervised(input: SupervisedMergeConflictResolutionActivityInput): Promise<DeveloperTurnActivityOutcome<MergeConflictResolutionActivityResult>>;
  requestCapacity(input: import("../capacity-contracts.js").CapacityRequestInput): Promise<import("../capacity-contracts.js").CapacityRequestSnapshot>;
  tryAcquireCapacity(input: { requestId: string; expectedWorkflowRevision: number }): Promise<import("../capacity-contracts.js").CapacityAdmissionResult>;
  inspectCapacity(input: { requestId: string }): Promise<import("../capacity-contracts.js").CapacityRequestSnapshot>;
  requeueCapacity(input: { requestId: string; now?: string }): Promise<import("../capacity-contracts.js").CapacityRequestSnapshot>;
  cancelCapacity(input: { requestId: string; reason?: string }): Promise<import("../capacity-contracts.js").CapacityRequestSnapshot>;
  finalizeCapacity(input: { requestId: string; expectedExecutionId: string; terminalReason: import("../capacity-contracts.js").CapacityTerminalReason }): Promise<import("../capacity-contracts.js").CapacityRequestSnapshot>;
  rateLimitCapacity(input: { requestId: string; executionId: string; retryAt?: string }): Promise<import("../capacity-contracts.js").CapacityRequestSnapshot>;
  reconcileCapacityOwnership(input?: { now?: string }): Promise<import("../capacity-contracts.js").CapacityReconciliationResult[]>;
}

export interface DeliveryBlockerActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  operation: "review" | "repair";
}

export interface DeliveryBlockerActivityResult {
  artifactId: string;
}

export interface DeliveryBlockerActivities {
  recordDeliveryBlocker(input: DeliveryBlockerActivityInput): Promise<DeliveryBlockerActivityResult>;
}
