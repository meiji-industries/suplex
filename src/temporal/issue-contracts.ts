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

export const IssuePhaseSchema = z.enum(["backlog", "planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "delivery_blocked"]);
export const IssueLeadOutputKindSchema = z.enum(["plan", "decision_blocker"]);
export const IssueCommandSchema = z.enum(["start_planning", "request_supplemental_review", "approve_plan", "reject_plan", "record_progress", "start_development", "retry_development", "cancel_development", "review_delivery", "repair_delivery", "record_delivery_decision"]);
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
}
