import { DeliveryWorkflowBlockCodeSchema, blockSummary, durableId } from "../primitives.js";

export const repairStateFields = {
  deliveryRepairAttemptId: durableId.nullable().optional(),
  deliveryRepairBlockerCode: DeliveryWorkflowBlockCodeSchema.nullable().optional(),
  deliveryRepairBlockerSummary: blockSummary.nullable().optional(),
  deliveryRepairBlockerEvidenceArtifactId: durableId.nullable().optional(),
  deliveryDecisionArtifactId: durableId.nullable().optional(),
};
