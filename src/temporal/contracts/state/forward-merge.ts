import { z } from "zod";
import { DurableArtifactReferenceSchema, durableId } from "../primitives.js";

export const forwardMergeStateFields = {
  forwardMergeId: durableId.nullable().optional(),
  forwardMergePriorHead: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergePriorTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  forwardMergeTargetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  mergeConflictEvidence: DurableArtifactReferenceSchema.nullable().optional(),
  forwardMergeConflictFiles: z.array(z.string().max(1_000)).max(128).optional(),
  forwardMergeConflictDiff: z.string().max(80_000).nullable().optional(),
};
