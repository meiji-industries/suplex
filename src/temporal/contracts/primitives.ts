import { z } from "zod";
export { ISSUE_PHASES, IssuePhaseSchema } from "../../issue-phases.js";
import { IssuePhaseSchema } from "../../issue-phases.js";
export { LeadResumeDescriptorSchema } from "../../lead-contracts.js";
export type { LeadPlanningActivityInput, LeadPlanningResult } from "../../lead-contracts.js";
import { durableId, exactSha } from "../../commands/inputs.js";
import { IssueCommandSchema } from "../../commands/registry.js";
export { durableId, exactSha } from "../../commands/inputs.js";
export { IssueCommandSchema, type IssueCommand } from "../../commands/registry.js";

// moved to src/commands/inputs.ts — re-exported for compatibility
export { ContinueWorkCommandSchema, PlanCommandInputSchema, PlanRevisionCommandSchema, RecordProgressInputSchema, ResolveDecisionBlockerInputSchema, StartPlanningInputSchema } from "../../commands/inputs.js";
export type { ContinueWorkCommand, PlanCommandInput, PlanRevisionCommand, RecordProgressInput, ResolveDecisionBlockerInput, StartPlanningInput } from "../../commands/inputs.js";

export const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);

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
  "repair-incomplete", "repair-scope", "worktree-unsafe", "repair-cap-exhausted", "preflight-failed",
]);
export type DeliveryOperationBlockCode = z.infer<typeof DeliveryOperationBlockCodeSchema>;
export const DeliveryWorkflowBlockCodeSchema = z.union([
  DeliveryOperationBlockCodeSchema,
  z.enum(["review-infrastructure-failure", "repair-infrastructure-failure"]),
]);
export type DeliveryWorkflowBlockCode = z.infer<typeof DeliveryWorkflowBlockCodeSchema>;
export const blockSummary = z.string().min(1).max(500);

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

export const TargetBaseArtifactKindSchema = z.enum(["developer-delivery", "forward-merge-conflict", "forward-merge-verification", "forward-merge-delivery"]);
export const ArtifactReferenceSchema = z.object({ id: durableId, kind: TargetBaseArtifactKindSchema }).strict();
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
  developerEvidenceArtifactId: durableId.optional(),
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
  byteSize: z.number().int().positive().max(8 * 1024 * 1024),
  mimeType: z.string().min(1).max(120),
});

export type DurableArtifactReference = z.infer<typeof DurableArtifactReferenceSchema>;

export function normalizeSafeSummary(value: unknown, maxBytes = 240): string {
  const normalized = String(value).replace(/[\r\n]+/g, " ").trim();
  if (!normalized) return "The operation requires operator attention.";
  const suffix = "…";
  const encoder = new TextEncoder();
  if (encoder.encode(normalized).byteLength <= maxBytes) return normalized;
  const budget = maxBytes - encoder.encode(suffix).byteLength;
  let result = "";
  for (const character of normalized) {
    const candidate = result + character;
    if (encoder.encode(candidate).byteLength > budget) break;
    result = candidate;
  }
  return result ? `${result.trimEnd()}${suffix}` : suffix;
}

// A summary is display text: normalise whitespace and truncate, never reject — a long or multi-line message must not fail a turn.
export function toSafeSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || "(no details)";
  const encoder = new TextEncoder();
  if (encoder.encode(normalized).byteLength <= 240) return normalized;
  const suffix = "…";
  const budget = 240 - encoder.encode(suffix).byteLength;
  let bounded = "";
  for (const character of normalized) {
    if (encoder.encode(bounded + character).byteLength > budget) break;
    bounded += character;
  }
  return `${bounded.trimEnd()}${suffix}`;
}

export const SafeSummarySchema = z.string().transform(toSafeSummary);

export const ActiveOperationSchema = z.object({
  commandId: durableId,
  kind: z.enum(["lead_planning", "development", "delivery_review", "repair", "release", "conflict_plan", "ci", "final_review"]),
  startedRevision: z.number().int().nonnegative(),
}).nullable();

export type ActiveOperation = z.infer<typeof ActiveOperationSchema>;

export const DeveloperRecoveryStatusSchema = z.enum(["starting", "active", "reconnecting", "result_pending_claim", "cancellation_requested", "cancelling", "interrupted", "cancelled", "failed"]);
export type DeveloperRecoveryStatus = z.infer<typeof DeveloperRecoveryStatusSchema>;

export const DeveloperRecoveryFields = {
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
  rationale: z.string().min(1),
  evidenceRef: z.string().min(1),
  disposition: z.enum(["open", "accepted", "repaired"]),
  repairInstruction: z.string().nullable(),
});

export const DeliveryReviewSchema = z.object({
  kind: z.literal("delivery_review"),
  summary: z.string().min(1),
  outcome: z.enum(["approved", "blocking"]),
  findings: z.array(DeliveryFindingSchema),
  repairPlan: z.string().nullable(),
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
  rootCause: z.string().min(1),
  failedChecks: z.array(z.object({ name: z.string().min(1), evidenceArtifactId: durableId, diagnosis: z.string().min(1) }).strict()).min(1),
  steps: z.array(z.object({ number: z.number().int().positive(), instruction: z.string().min(1), verification: z.string().min(1) }).strict()).min(1),
  localVerification: z.array(z.string().min(1)).min(1),
  unresolvedQuestions: z.array(z.string().min(1)).max(0),
  // "rerun" means the failure is not caused by this delivery: re-run the failed provider jobs instead of editing code.
  disposition: z.enum(["repair", "rerun"]).default("repair"),
}).strict().superRefine((value, context) => {
  value.steps.forEach((step, index) => { if (step.number !== index + 1) context.addIssue({ code: "custom", path: ["steps", index, "number"], message: "Repair step numbers must be contiguous" }); });
});
export type CiRepairPlan = z.infer<typeof CiRepairPlanSchema>;

export const MergeConflictPlanSchema = z.object({
  kind: z.literal("merge_conflict_plan"),
  summary: z.string().min(1),
  resolutions: z.array(z.object({ file: z.string().min(1), resolution: z.string().min(1), number: z.number().int().positive().optional(), intendedResult: z.string().min(1).optional(), issueInvariant: z.string().min(1).optional(), baseInvariant: z.string().min(1).optional(), compatibilityConcern: z.string().min(1).optional() })).min(1),
  verificationStrategy: z.string().min(1),
  unresolvedQuestions: z.array(z.string()).length(0),
});

export type MergeConflictPlan = z.infer<typeof MergeConflictPlanSchema>;

export type IssuePhase = z.infer<typeof IssuePhaseSchema>;
export const IssueLeadOutputKindSchema = z.enum(["plan", "decision_blocker"]);
export const IssuePlanDecisionSchema = z.enum(["approve", "request_revision", "reject"]);
export const AttentionCategorySchema = z.enum(["member_authorization", "member_decision", "agent_contradiction", "agent_exhausted", "unsafe_recovery", "provider_ambiguity", "provider_authentication", "provider_connectivity_exhausted", "verification_unrecoverable", "target_drift", "capacity_exhausted"]);
export type AttentionCategory = z.infer<typeof AttentionCategorySchema>;
export const IssueBlockerActionSchema = z.object({ command: IssueCommandSchema, label: z.string().min(1).max(120), requiresNote: z.boolean(), destructive: z.boolean() });
export type IssueBlockerAction = z.infer<typeof IssueBlockerActionSchema>;
export const ArtifactPointerSchema = z.object({ artifactId: durableId, kind: z.enum(["attention-evidence", "lead-plan", "decision-blocker", "delivery-review", "developer-delivery", "developer-repair", "ci-evidence", "merge-conflict-plan", "merge-conflict-resolution"]) });
export type ArtifactPointer = z.infer<typeof ArtifactPointerSchema>;
export const IssueBlockerRetrySchema = z.object({ attempt: z.number().int().nonnegative(), retryAt: z.string().datetime().nullable(), exhausted: z.boolean() });
export const IssueBlockerSchema = z.object({ category: AttentionCategorySchema, summary: SafeSummarySchema, unblockOwner: z.enum(["human", "lead", "developer", "system"]), actions: z.array(IssueBlockerActionSchema).min(1).max(3), evidence: ArtifactPointerSchema, createdAt: z.string().datetime(), retry: IssueBlockerRetrySchema.nullable() });
export type IssueBlocker = z.infer<typeof IssueBlockerSchema>;
export const RepairAuthoritySchema = z.enum(["delivery_review", "final_review", "ci_failure", "member_requested_changes"]);
