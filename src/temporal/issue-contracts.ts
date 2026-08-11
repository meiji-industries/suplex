import { z } from "zod";

import { PlanMaterialCategorySchema, type PlanMaterialCategory } from "../plan-governance.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const IssuePhaseSchema = z.enum(["backlog", "planning", "approval", "ready_for_development"]);
export const IssueLeadOutputKindSchema = z.enum(["plan", "decision_blocker"]);
export const IssueCommandSchema = z.enum(["start_planning", "request_supplemental_review", "approve_plan", "reject_plan", "record_progress"]);
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

export type IssueWorkflowInput = z.infer<typeof IssueWorkflowInputSchema>;
export type IssueWorkflowState = z.infer<typeof IssueWorkflowStateSchema>;
export type StartPlanningInput = z.infer<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.infer<typeof RecordProgressInputSchema>;
export type PlanCommandInput = z.infer<typeof PlanCommandInputSchema>;

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

export interface IssueActivities {
  projectIssueState(state: IssueWorkflowState): Promise<IssueWorkflowState>;
  runLeadPlanning(input: LeadPlanningActivityInput): Promise<LeadPlanningResult>;
  runSupplementalReview(input: SupplementalReviewActivityInput): Promise<SupplementalReviewResult>;
  consolidateLeadPlan(input: ConsolidateLeadPlanActivityInput): Promise<LeadPlanningResult>;
  recordPlanDecision(input: PlanDecisionActivityInput): Promise<{ decisionId: string }>;
}
