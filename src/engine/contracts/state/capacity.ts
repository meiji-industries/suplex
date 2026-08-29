import { CapacityBlockerSchema, WorkflowCapacityStateSchema } from "../../../capacity-contracts.js";

export const capacityStateFields = {
  capacity: WorkflowCapacityStateSchema.nullable().optional(),
  capacityBlocker: CapacityBlockerSchema.nullable().optional(),
};
