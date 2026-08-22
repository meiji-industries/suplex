import { z } from "zod";
import { RevisedExecutionCoordinatesSchema, SuccessorReferenceSchema, durableId, exactSha } from "../primitives.js";
import type { LeadPlanningActivityInput, LeadPlanningResult } from "../../../lead-contracts.js";
import type { PlanSubject, SupplementalReviewSubject } from "../../../plan-governance.js";

export interface SupplementalReviewActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  imageArtifactIds: string[];
  roleProfiles: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  revision: number;
  leadOutputArtifactId: string;
  leadEvidenceArtifactId: string;
  capacityRequestId?: string;
  evidenceManifestArtifactId?: string;
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
}

export interface ConsolidateLeadPlanActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  projectId: string;
  projectRevisionId: string;
  briefArtifactId: string;
  imageArtifactIds: string[];
  roleProfiles: { planner?: string | undefined; builder?: string | undefined; reviewer?: string | undefined; integrator?: string | undefined };
  revision: number;
  leadSessionRef: string;
  leadOutputArtifactId: string;
  supplementalReviewArtifactId: string;
  capacityRequestId?: string;
  evidenceManifestArtifactId?: string;
  originalPlanSubject?: PlanSubject;
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

export interface PlanningActivities {
  runLeadPlanning(input: LeadPlanningActivityInput): Promise<LeadPlanningResult>;
  preparePlanRevision(input: PreparePlanRevisionActivityInput): Promise<PreparePlanRevisionActivityResult>;
  authorizePlanRevision(input: { taskId: string; companyId: string; workflowId: string; revisionRequestId: string; planRevision: number }): Promise<void>;
  createSuccessor(input: CreateSuccessorActivityInput): Promise<CreateSuccessorActivityResult>;
  runSupplementalReview(input: SupplementalReviewActivityInput): Promise<SupplementalReviewResult>;
  consolidateLeadPlan(input: ConsolidateLeadPlanActivityInput): Promise<LeadPlanningResult>;
}
