import { z } from "zod";
import { DeliveryFindingSchema, durableId } from "../primitives.js";

export const finalReviewStateFields = {
  finalReviewId: durableId.nullable().optional(),
  finalReviewOutcome: z.enum(["approved", "blocking"]).nullable().optional(),
  finalReviewSummary: z.string().nullable().optional(),
  finalReviewOpinionArtifactId: durableId.nullable().optional(),
  finalReviewEvidenceArtifactId: durableId.nullable().optional(),
  finalReviewFailureCode: z.literal("final_review_unavailable").nullable().optional(),
  finalReviewFindings: z.array(DeliveryFindingSchema).optional(),
  finalReviewRepairPlanArtifactId: durableId.nullable().optional(),
  /** Historical compatibility only; ignored after deserialization. */
  finalReviewRepairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
};
