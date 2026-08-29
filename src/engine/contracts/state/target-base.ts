import { z } from "zod";
import { ArtifactReferenceSchema, TargetBaseBlockerCodeSchema, TargetBaseCheckpointSchema, durableId } from "../primitives.js";

export const targetBaseStateFields = {
  targetBaseCheckId: durableId.nullable().optional(),
  targetBaseCheckpoint: TargetBaseCheckpointSchema.nullable().optional(),
  targetBaseOutcome: z.enum(["no_drift", "revalidated", "conflict", "blocked"]).nullable().optional(),
  targetBaseBlockerCode: TargetBaseBlockerCodeSchema.nullable().optional(),
  targetBaseBlockerOwner: z.enum(["human", "provider", "lead"]).nullable().optional(),
  targetBaseBlockerRetryable: z.boolean().nullable().optional(),
  targetBaseBlockerSummary: z.string().max(500).nullable().optional(),
  forwardMergeConflictArtifact: ArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFileCount: z.number().int().nonnegative().max(128).nullable().optional(),
};
