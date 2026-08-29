import { z } from "zod";
import { DeliveryFindingSchema, DeliveryWorkflowBlockCodeSchema, DurableArtifactReferenceSchema, RepairAuthoritySchema, SafeSummarySchema, blockSummary, durableId } from "../primitives.js";

export const deliveryReviewStateFields = {
  deliveryReviewId: durableId.nullable().optional(),
  deliveryReviewAttemptId: durableId.nullable().optional(),
  deliveryReviewBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryReviewBlockerSummary: blockSummary.nullable().optional(),
  deliveryReviewBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryReviewSupersedesId: durableId.nullable().optional(),
  deliveryReviewArtifact: DurableArtifactReferenceSchema.optional(),
  deliveryReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  deliveryReviewSummary: SafeSummarySchema.nullable().optional(),
  deliveryBlockingFindings: z.array(DeliveryFindingSchema).optional(),
  deliveryRepairPlan: z.string().nullable().optional(),
  deliveryRepairPlanArtifactId: durableId.nullable().optional(),
  /** Historical compatibility only; ignored after deserialization. */
  deliveryRepairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  deliveryRepairAuthority: RepairAuthoritySchema.nullable().optional(),
  repairCycle: z.number().int().nonnegative().optional(),
};
