import { z } from "zod";
import { DecisionIdempotencyKeySchema, PlanBlockerSubjectSchema, PlanMaterialCategorySchema } from "../../../plan-governance.js";
import { durableId } from "../primitives.js";

export const governanceStateFields = {
  leadReviewResponseArtifactId: durableId.nullable().optional(),
  leadReviewResponseArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  planDecisionReceipt: z.union([
    z.object({ idempotencyKey: DecisionIdempotencyKeySchema, decisionId: durableId, decision: z.enum(["approve", "request_revision"]), subjectHash: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({ idempotencyKey: DecisionIdempotencyKeySchema, decisionId: durableId, decision: z.enum(["approve", "request_revision"]), subjectArtifactId: durableId }),
  ]).nullable().optional(),
  planBlockerSubject: PlanBlockerSubjectSchema.nullable().optional(),
  planBlockerResponseReceipt: z.object({ idempotencyKey: DecisionIdempotencyKeySchema, responseId: durableId, blockerSubjectHash: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  planRevision: z.number().int().nonnegative().nullable().optional(),
  planMaterial: z.boolean().nullable().optional(),
  preservedWorktreeCompatibility: z.boolean().nullable().optional(),
  materialCategories: z.array(PlanMaterialCategorySchema).max(6).optional(),
  blockedCategory: z.enum(["human_decision", "authentication", "configuration", "capacity", "execution_ownership"]).nullable().optional(),
  blockedResumePhase: z.literal("planning").nullable().optional(),
  blockerArtifactId: durableId.nullable().optional(),
  blockerArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  blockerResolutionId: durableId.nullable().optional(),
  leadResumeInstructionArtifactId: durableId.nullable().optional(),
  leadResumeInstructionSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  supplementalReviewUsed: z.boolean().optional(),
  supplementalReviewArtifactId: durableId.nullable().optional(),
  decisionId: durableId.nullable().optional(),
  planAuthorizationId: durableId.nullable().optional(),
  planArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  planAuthorizationKind: z.enum(["routine_auto", "human_approval"]).nullable().optional(),
  planAuthorizedAt: z.string().datetime().nullable().optional(),
};
