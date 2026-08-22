import { z } from "zod";
import {
  blockSummary, DeliveryFindingSchema, DeliveryOperationBlockCodeSchema, DeliveryReviewSubjectSchema,
  DurableArtifactReferenceSchema, durableId,
} from "../primitives.js";

const DeliveryReviewActivityInputCoreSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectId: durableId,
  projectRevisionId: durableId,
  briefArtifactId: durableId,
  planRevision: z.number().int().nonnegative(),
  roleProfiles: z.object({ planner: durableId.optional(), builder: durableId.optional(), reviewer: durableId.optional(), integrator: durableId.optional() }),
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
  visualEvidence: z.enum(["off", "capture", "required"]).optional(),
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
      summary: z.string().min(1),
      repairPlan: z.string().nullable().optional(),
      repairPlanArtifactId: durableId.nullable().optional(),
      repairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
      findings: z.array(DeliveryFindingSchema),
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


export const DeliveryDecisionActivityInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  actorUserId: durableId,
  note: z.string().min(1),
});

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
  findings: z.array(DeliveryFindingSchema).min(1),
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
  summary: z.string().min(1),
  findings: z.array(DeliveryFindingSchema),
});

export type DeliveryRepairPlanResult = z.infer<typeof DeliveryRepairPlanResultSchema>;

export type WorkflowDeliveryReviewResult = DeliveryReviewActivityResult;

export interface DeliveryDecisionActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  note: string;
}

export interface DeliveryReviewActivities {
  planDeliveryRepair(input: DeliveryRepairPlanActivityInput): Promise<DeliveryRepairPlanResult>;
  reviewDelivery(input: WorkflowDeliveryReviewActivityInput): Promise<WorkflowDeliveryReviewResult>;
  recordDeliveryDecision(input: DeliveryDecisionActivityInput): Promise<{ artifactId: string }>;
}
