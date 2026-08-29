import { RevisedExecutionCoordinatesSchema, SuccessorReferenceSchema, durableId } from "../primitives.js";

export const successorStateFields = {
  predecessorTaskId: durableId.nullable().optional(),
  successorTaskId: durableId.nullable().optional(),
};

export const successorStateFields2 = {
  revisionRequestId: durableId.nullable().optional(),
  revisedExecutionCoordinates: RevisedExecutionCoordinatesSchema.nullable().optional(),
  successorReference: SuccessorReferenceSchema.nullable().optional(),
};
