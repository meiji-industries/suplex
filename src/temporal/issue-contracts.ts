import { z } from "zod";
import { ReleaseFailureCodeSchema } from "../release-failures.js";

import { PlanMaterialCategorySchema, type PlanMaterialCategory } from "../plan-governance.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const DurableArtifactKindSchema = z.enum([
  "task-brief",
  "task-image",
  "agent-evidence",
  "lead-plan",
  "developer-delivery",
  "delivery-review",
  "developer-repair",
  "ci-evidence",
  "merge-conflict-evidence",
  "merge-conflict-plan",
  "merge-conflict-resolution",
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
  resolutions: z.array(z.object({ file: z.string().min(1).max(1_000), resolution: z.string().min(1).max(8_000) })).min(1).max(128),
  verificationStrategy: z.string().min(1).max(12_000),
  unresolvedQuestions: z.array(z.string().max(2_000)).max(16).length(0),
});

export type MergeConflictPlan = z.infer<typeof MergeConflictPlanSchema>;

export const IssuePhaseSchema = z.enum(["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "manual_merge", "done", "delivery_blocked", "cancelled", "failed"]);
export const IssueLeadOutputKindSchema = z.enum(["plan", "decision_blocker"]);
export const IssueCommandSchema = z.enum(["start_planning", "request_supplemental_review", "approve_plan", "reject_plan", "record_progress", "start_development", "retry_development", "cancel_development", "review_delivery", "repair_delivery", "record_delivery_decision", "publish_draft", "resolve_merge_conflict", "reconcile_ci", "repair_ci", "final_review", "accept_delivery", "request_delivery_changes", "cancel_issue", "reconcile_merge", "continue_work"]);
export const IssuePlanDecisionSchema = z.enum(["approve", "reject"]);
export const IssueContinuationStateSchema = z.object({
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(IssueCommandSchema),
  pendingAction: z.string().max(200).nullable(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  activeOperation: ActiveOperationSchema.optional(),
  processedCommandIds: z.array(durableId).max(64).optional(),
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: SafeSummarySchema.nullable().optional(),
  planRevision: z.number().int().nonnegative().nullable().optional(),
  planMaterial: z.boolean().nullable().optional(),
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
  deliveryReviewArtifact: DurableArtifactReferenceSchema.optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: SafeSummarySchema.nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  deliveryRepairPlan: z.string().max(12_000).nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeConflictEvidence: DurableArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFiles: z.array(z.string().max(1_000)).max(128).optional(),
  forwardMergeConflictDiff: z.string().max(80_000).nullable().optional(),
  mergeResolutionPlanId: durableId.nullable().optional(),
  mergeResolutionPlanArtifactId: durableId.nullable().optional(),
  mergeResolutionLeadExecutionId: durableId.nullable().optional(),
  mergeResolutionLeadSessionRef: durableId.nullable().optional(),
  mergeResolutionDeveloperExecutionId: durableId.nullable().optional(),
  mergeResolutionDeveloperSessionRef: durableId.nullable().optional(),
  releaseId: durableId.nullable().optional(),
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
  acceptanceId: durableId.nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed", "provider_unavailable"]).nullable().optional(),
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
  releaseStatus: z.enum(["reconciling", "draft", "blocked"]).nullable().optional(),
  releaseFailureCode: ReleaseFailureCodeSchema.nullable().optional(),
  releaseFailureSummary: z.string().max(500).nullable().optional(),
  releaseRetryAt: z.string().datetime().nullable().optional(),
  releaseOperationAttempt: z.number().int().nonnegative().nullable().optional(),
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
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  activeOperation: ActiveOperationSchema.optional(),
  processedCommandIds: z.array(durableId).max(64).optional(),
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: SafeSummarySchema.nullable().optional(),
  planRevision: z.number().int().nonnegative().nullable().optional(),
  planMaterial: z.boolean().nullable().optional(),
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
  deliveryReviewArtifact: DurableArtifactReferenceSchema.optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: SafeSummarySchema.nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  deliveryRepairPlan: z.string().max(12_000).nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeConflictEvidence: DurableArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFiles: z.array(z.string().max(1_000)).max(128).optional(),
  forwardMergeConflictDiff: z.string().max(80_000).nullable().optional(),
  mergeResolutionPlanId: durableId.nullable().optional(),
  mergeResolutionPlanArtifactId: durableId.nullable().optional(),
  mergeResolutionLeadExecutionId: durableId.nullable().optional(),
  mergeResolutionLeadSessionRef: durableId.nullable().optional(),
  mergeResolutionDeveloperExecutionId: durableId.nullable().optional(),
  mergeResolutionDeveloperSessionRef: durableId.nullable().optional(),
  releaseId: durableId.nullable().optional(),
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
  acceptanceId: durableId.nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed", "provider_unavailable"]).nullable().optional(),
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
  releaseStatus: z.enum(["reconciling", "draft", "blocked"]).nullable().optional(),
  releaseFailureCode: ReleaseFailureCodeSchema.nullable().optional(),
  releaseFailureSummary: z.string().max(500).nullable().optional(),
  releaseRetryAt: z.string().datetime().nullable().optional(),
  releaseOperationAttempt: z.number().int().nonnegative().nullable().optional(),
});

export function buildInitialIssueWorkflowState(input: IssueWorkflowInput): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    workflowId: input.workflowId,
    companyId: input.companyId,
    projectId: input.projectId,
    issueId: input.issueId,
    projectRevisionId: input.projectRevisionId,
    ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    phase: "backlog",
    revision: 0,
    owner: "human",
    allowedCommands: ["start_planning"],
    pendingAction: "Start planning",
    lastEventId: `${input.workflowId}:0`,
    continuationCount: 0,
    lastSummaryHash: null,
    repairCycle: 0,
  });
}

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
});

export type IssueWorkflowInput = z.input<typeof IssueWorkflowInputSchema>;
export type IssueWorkflowState = z.infer<typeof IssueWorkflowStateSchema>;
export type StartPlanningInput = z.input<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.input<typeof RecordProgressInputSchema>;
export type PlanCommandInput = z.input<typeof PlanCommandInputSchema>;

export const DeliveryReviewActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  planRevision: z.number().int().nonnegative(),
  roleProfiles: z.object({ lead: durableId.optional(), developer: durableId.optional(), reviewer: durableId.optional() }),
  leadSessionRef: durableId,
  leadOutputArtifactId: durableId,
  developerExecutionId: durableId,
  deliveryArtifactId: durableId,
  evidenceArtifactId: durableId,
  worktreePath: z.string().min(1).max(1_000).optional(),
  branchName: z.string().min(1).max(256),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  reviewKind: z.enum(["delivery", "final"]).optional(),
  releaseId: durableId.optional(),
  ciRunId: durableId.optional(),
});

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
  reviewArtifact: DurableArtifactReferenceSchema.optional(),
  cycle: z.number().int().positive(),
  repairCycleLimit: z.number().int().min(0).max(5),
  worktreePath: z.string().min(1).max(1_000).optional(),
  branchName: z.string().min(1).max(256),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  subjectTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  blockingFindings: z.array(DeliveryFindingSchema).max(64),
  repairPlan: z.string().min(1).max(12_000),
});

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
}

export interface LeadPlanningResult {
  leadSessionRef: string;
  leadExecutionId: string;
  leadEvidenceArtifactId: string;
  leadOutputArtifactId: string;
  leadOutputKind: "plan" | "decision_blocker";
  leadSummary: string;
  materialCategories: PlanMaterialCategory[];
  material: boolean;
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
}

export interface SupplementalReviewResult {
  reviewId: string;
  reviewArtifactId: string;
  evidenceArtifactId: string;
  executionId: string;
  sessionRef: string;
  summary: string;
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
}

export interface PlanDecisionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  planRevision: number;
  actorUserId: string;
  decision: "approve" | "reject";
  note: string;
}

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
  executionId?: string;
  supersedesExecutionId?: string | undefined;
  reuseWorktree?: boolean | undefined;
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
  evidenceArtifactId: string;
  deliverySummary: string;
  outcome: "completed" | "blocked";
}

export type WorkflowDeveloperExecutionResult = Omit<DeveloperExecutionResult, "worktreePath">;

export interface DeveloperCancellationActivityInput {
  taskId: string;
  companyId: string;
  executionId: string;
}

export interface DeliveryReviewActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  planRevision: number;
  roleProfiles: { lead?: string | undefined; developer?: string | undefined; reviewer?: string | undefined };
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
  reviewKind?: "delivery" | "final" | undefined;
  releaseId?: string | undefined;
  ciRunId?: string | undefined;
}

/** Workflow-safe review input. The activity resolves the worktree from durable execution state. */
export type WorkflowDeliveryReviewActivityInput = Omit<DeliveryReviewActivityInput, "worktreePath"> & { worktreePath?: string };

export interface DeliveryReviewResult {
  reviewId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  reviewArtifact?: DurableArtifactReference;
  outcome: "approved" | "blocking";
  summary: string;
  repairPlan: string | null;
  findings: DeliveryFinding[];
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
}

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
  reviewArtifact?: DurableArtifactReference;
  cycle: number;
  repairCycleLimit: number;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  subjectCommit: string;
  subjectTree: string;
  blockingFindings: DeliveryFinding[];
  repairPlan: string;
}

export interface DeveloperRepairResult {
  developerExecutionId: string;
  developerSessionRef: string;
  supersedesExecutionId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  resultCommit: string | null;
  resultTree: string | null;
  dirtyState: "clean" | "dirty";
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  deliverySummary: string;
  outcome: "completed" | "blocked";
  cycle: number;
}

export type WorkflowDeveloperRepairResult = Omit<DeveloperRepairResult, "worktreePath">;

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
}

const PublishReleaseIdentitySchema = z.object({
  repository: z.string().max(256),
  branchName: z.string().max(256),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  headTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  reused: z.boolean(),
  attempt: z.number().int().nonnegative(),
});
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
export const PublishReleaseActivityResultSchema = z.discriminatedUnion("outcome", [
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("completed"), releaseId: durableId, pullRequestNumber: z.number().int().positive(), pullRequestUrl: z.string().url().max(2_000), isDraft: z.literal(true), targetBaseSha: sha.optional() }),
  PublishReleaseIdentitySchema.extend({ outcome: z.literal("blocked"), releaseId: durableId.nullable(), pullRequestNumber: z.null(), pullRequestUrl: z.null(), isDraft: z.boolean(), code: ReleaseFailureCodeSchema, summary: z.string().max(500), retryAt: z.string().datetime().nullable(), evidenceArtifactId: durableId.nullable() }),
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
  forwardMergeId?: string;
  leadSessionRef: string;
  leadOutputArtifactId: string;
  conflictEvidence?: DurableArtifactReference;
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictFiles: string[];
  conflictDiff: string;
}

export type WorkflowMergeConflictPlanActivityInput = Omit<MergeConflictPlanActivityInput, "worktreePath" | "conflictFiles" | "conflictDiff"> & {
  worktreePath?: string;
  conflictFiles?: string[];
  conflictDiff?: string;
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
  developerExecutionId: string;
  developerSessionRef: string;
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictFiles: string[];
  planArtifactId: string;
}

export type WorkflowMergeConflictResolutionActivityInput = Omit<MergeConflictResolutionActivityInput, "worktreePath" | "conflictFiles"> & {
  worktreePath?: string;
  conflictFiles?: string[];
};

export interface MergeConflictResolutionActivityResult {
  developerExecutionId: string;
  developerSessionRef: string;
  resultCommit: string;
  resultTree: string;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
  summary: string;
}

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
  ciRunId: string;
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
}

export type WorkflowFinalReviewActivityInput = Omit<FinalReviewActivityInput, "worktreePath"> & { worktreePath?: string };

export type WorkflowDeliveryReviewResult = Omit<DeliveryReviewResult, "repairPlan" | "findings"> & {
  reviewArtifact: DurableArtifactReference;
};

export interface FinalReviewActivityResult {
  finalReviewId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  reviewArtifact: DurableArtifactReference;
  outcome: "approved" | "blocking";
  summary: string;
}

export interface AcceptDeliveryActivityInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  finalReviewId: string;
  ciRunId: string;
  actorUserId: string;
  expectedHeadSha: string;
  expectedHeadTree: string;
}

export interface AcceptDeliveryActivityResult {
  acceptanceId: string;
  status: "accepted" | "requested_changes" | "cancelled";
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface ReconcileMergeActivityInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  expectedHeadSha: string;
}

export interface ReconcileMergeActivityResult {
  outcome: "open" | "merged" | "closed_without_merge" | "changed" | "provider_unavailable";
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface IssueActivities {
  projectIssueState(event: IssueProjectionEvent): Promise<IssueWorkflowState>;
  runLeadPlanning(input: LeadPlanningActivityInput): Promise<LeadPlanningResult>;
  runSupplementalReview(input: SupplementalReviewActivityInput): Promise<SupplementalReviewResult>;
  consolidateLeadPlan(input: ConsolidateLeadPlanActivityInput): Promise<LeadPlanningResult>;
  recordPlanDecision(input: PlanDecisionActivityInput): Promise<{ decisionId: string }>;
  runDeveloperExecution(input: DeveloperExecutionActivityInput): Promise<WorkflowDeveloperExecutionResult>;
  reviewDelivery(input: WorkflowDeliveryReviewActivityInput): Promise<WorkflowDeliveryReviewResult>;
  runDeveloperRepair(input: WorkflowDeveloperRepairActivityInput): Promise<WorkflowDeveloperRepairResult>;
  recordDeliveryDecision(input: DeliveryDecisionActivityInput): Promise<{ artifactId: string }>;
  cancelDeveloperExecution(input: DeveloperCancellationActivityInput): Promise<{ status: "cancelled" | "ownership_ambiguous"; reason?: string | undefined }>;
  publishRelease(input: PublishReleaseActivityInput): Promise<PublishReleaseActivityResult>;
  reconcileCi(input: ReconcileCiActivityInput): Promise<ReconcileCiActivityResult>;
  planCiRepair(input: CiRepairPlanActivityInput): Promise<CiRepairPlanActivityResult>;
  runCiRepair(input: WorkflowCiRepairActivityInput): Promise<WorkflowCiRepairActivityResult>;
  finalReview(input: WorkflowFinalReviewActivityInput): Promise<FinalReviewActivityResult>;
  acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }): Promise<AcceptDeliveryActivityResult>;
  reconcileMerge(input: ReconcileMergeActivityInput): Promise<ReconcileMergeActivityResult>;
  planMergeConflict(input: WorkflowMergeConflictPlanActivityInput): Promise<MergeConflictPlanActivityResult>;
  resolveMergeConflict(input: WorkflowMergeConflictResolutionActivityInput): Promise<MergeConflictResolutionActivityResult>;
}
