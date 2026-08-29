import { z } from "zod";
import { DeliveryWorkflowBlockCodeSchema, blockSummary, durableId } from "../primitives.js";

export const repairStateFields = {
  deliveryRepairAttemptId: durableId.nullable().optional(),
  deliveryRepairBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryRepairBlockerSummary: blockSummary.nullable().optional(),
  deliveryRepairBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
  repairProgress: z.object({ signature: z.string(), commit: z.string().nullable(), diagnosticHash: z.string().nullable(), repeats: z.number().int().nonnegative() }).nullable().optional(),
};
