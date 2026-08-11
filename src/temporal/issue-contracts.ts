import { z } from "zod";

import { PlanMaterialCategorySchema, type PlanMaterialCategory } from "../plan-governance.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

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

export const MergeConflictPlanSchema = z.object({
  kind: z.literal("merge_conflict_plan"),
  summary: z.string().min(1).max(2_000),
  resolutions: z.array(z.object({ file: z.string().min(1).max(1_000), resolution: z.string().min(1).max(8_000) })).min(1).max(128),
  verificationStrategy: z.string().min(1).max(12_000),
  unresolvedQuestions: z.array(z.string().max(2_000)).max(16).length(0),
});

export type MergeConflictPlan = z.infer<typeof MergeConflictPlanSchema>;

export const IssuePhaseSchema = z.enum(["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_required", "final_review", "accepted", "manual_merge", "done", "delivery_blocked", "cancelled", "failed"]);
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
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: z.string().max(2_000).nullable().optional(),
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
  developerEvidenceArtifactId: durableId.nullable().optional(),
  deliverySummary: z.string().max(2_000).nullable().optional(),
  developerOutcome: z.enum(["completed", "blocked"]).nullable().optional(),
  deliveryReviewId: durableId.nullable().optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: z.string().max(2_000).nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  deliveryRepairPlan: z.string().max(12_000).nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
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
  ciOutcome: z.enum(["waiting", "passed", "failed", "cancelled", "missing_required", "provider_unavailable", "rate_limited", "stale_head", "timed_out"]).nullable().optional(),
  ciNextPollAt: z.string().datetime().nullable().optional(),
  finalReviewId: durableId.nullable().optional(),
  finalReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  acceptanceId: durableId.nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed", "provider_unavailable"]).nullable().optional(),
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
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
  phase: IssuePhaseSchema,
  revision: z.number().int().nonnegative(),
  owner: z.enum(["human", "lead"]),
  allowedCommands: z.array(IssueCommandSchema),
  pendingAction: z.string().max(200).nullable(),
  lastEventId: durableId,
  continuationCount: z.number().int().nonnegative(),
  lastSummaryHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  leadSessionRef: durableId.nullable().optional(),
  leadExecutionId: durableId.nullable().optional(),
  leadEvidenceArtifactId: durableId.nullable().optional(),
  leadOutputArtifactId: durableId.nullable().optional(),
  leadOutputKind: IssueLeadOutputKindSchema.nullable().optional(),
  leadSummary: z.string().max(2_000).nullable().optional(),
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
  developerEvidenceArtifactId: durableId.nullable().optional(),
  deliverySummary: z.string().max(2_000).nullable().optional(),
  developerOutcome: z.enum(["completed", "blocked"]).nullable().optional(),
  deliveryReviewId: durableId.nullable().optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: z.string().max(2_000).nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).max(64).optional(),
  deliveryRepairPlan: z.string().max(12_000).nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
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
  ciOutcome: z.enum(["waiting", "passed", "failed", "cancelled", "missing_required", "provider_unavailable", "rate_limited", "stale_head", "timed_out"]).nullable().optional(),
  ciNextPollAt: z.string().datetime().nullable().optional(),
  finalReviewId: durableId.nullable().optional(),
  finalReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  acceptanceId: durableId.nullable().optional(),
  acceptedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed", "provider_unavailable"]).nullable().optional(),
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
});

export const StartPlanningInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
});

export const RecordProgressInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const PlanCommandInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  note: z.string().max(4_000).optional(),
  worktreeDecision: z.enum(["reuse", "new"]).optional(),
  exactBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  decision: z.enum(["accept", "request_changes", "cancel"]).optional(),
});

export type IssueWorkflowInput = z.input<typeof IssueWorkflowInputSchema>;
export type IssueWorkflowState = z.infer<typeof IssueWorkflowStateSchema>;
export type StartPlanningInput = z.infer<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.infer<typeof RecordProgressInputSchema>;
export type PlanCommandInput = z.infer<typeof PlanCommandInputSchema>;

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
  worktreePath: z.string().min(1).max(1_000),
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
  cycle: z.number().int().positive(),
  repairCycleLimit: z.number().int().min(0).max(5),
  worktreePath: z.string().min(1).max(1_000),
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

export interface DeliveryReviewResult {
  reviewId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
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
  planSummary: string;
  deliverySummary: string;
  verificationSummary: string;
}

export interface PublishReleaseActivityResult {
  releaseId: string;
  repository: string;
  branchName: string;
  headSha: string;
  headTree: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  isDraft: boolean;
  reused: boolean;
  baseDriftMerged?: boolean;
  targetBaseSha?: string;
  baseDriftConflict?: boolean;
  forwardMergeId?: string;
  priorHead?: string;
  mergeCommit?: string;
  tree?: string;
  conflictFiles?: string[];
  conflictDiff?: string;
}

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
  worktreePath: string;
  branchName: string;
  priorHead: string;
  targetBaseSha: string;
  conflictFiles: string[];
  conflictDiff: string;
}

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
  attempt?: number;
}

export interface ReconcileCiActivityResult {
  runId: string;
  outcome: "waiting" | "passed" | "failed" | "cancelled" | "missing_required" | "provider_unavailable" | "rate_limited" | "stale_head" | "timed_out";
  summary: string;
  nextPollAt: string | null;
}

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

export interface FinalReviewActivityResult {
  finalReviewId: string;
  leadExecutionId: string;
  leadSessionRef: string;
  opinionArtifactId: string;
  evidenceArtifactId: string;
  outcome: "approved" | "blocking";
  summary: string;
  findings: DeliveryFinding[];
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
  projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState>;
  runLeadPlanning(input: LeadPlanningActivityInput): Promise<LeadPlanningResult>;
  runSupplementalReview(input: SupplementalReviewActivityInput): Promise<SupplementalReviewResult>;
  consolidateLeadPlan(input: ConsolidateLeadPlanActivityInput): Promise<LeadPlanningResult>;
  recordPlanDecision(input: PlanDecisionActivityInput): Promise<{ decisionId: string }>;
  runDeveloperExecution(input: DeveloperExecutionActivityInput): Promise<DeveloperExecutionResult>;
  reviewDelivery(input: DeliveryReviewActivityInput): Promise<DeliveryReviewResult>;
  runDeveloperRepair(input: DeveloperRepairActivityInput): Promise<DeveloperRepairResult>;
  recordDeliveryDecision(input: DeliveryDecisionActivityInput): Promise<{ artifactId: string }>;
  cancelDeveloperExecution(input: DeveloperCancellationActivityInput): Promise<{ status: "cancelled" | "ownership_ambiguous"; reason?: string | undefined }>;
  publishRelease(input: PublishReleaseActivityInput): Promise<PublishReleaseActivityResult>;
  reconcileCi(input: ReconcileCiActivityInput): Promise<ReconcileCiActivityResult>;
  finalReview(input: FinalReviewActivityInput): Promise<FinalReviewActivityResult>;
  acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }): Promise<AcceptDeliveryActivityResult>;
  reconcileMerge(input: ReconcileMergeActivityInput): Promise<ReconcileMergeActivityResult>;
  planMergeConflict(input: MergeConflictPlanActivityInput): Promise<MergeConflictPlanActivityResult>;
  resolveMergeConflict(input: MergeConflictResolutionActivityInput): Promise<MergeConflictResolutionActivityResult>;
}
