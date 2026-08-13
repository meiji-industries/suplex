import { z } from "zod";
import { DurableArtifactReferenceSchema, SafeSummarySchema, durableId } from "../primitives.js";

export const developmentStateFields = {
  developerExecutionId: durableId.nullable().optional(),
  developerSessionRef: durableId.nullable().optional(),
  worktreePath: z.string().max(1_000).nullable().optional(),
  branchName: z.string().max(256).nullable().optional(),
  targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  currentStep: z.number().int().positive().nullable().optional(),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),
  dirtyState: z.enum(["clean", "dirty"]).nullable().optional(),
  deliveryArtifactId: durableId.nullable().optional(),
  deliveryArtifact: DurableArtifactReferenceSchema.optional(),
  developerEvidenceArtifactId: durableId.nullable().optional(),
  developerEvidenceArtifact: DurableArtifactReferenceSchema.optional(),
  deliverySummary: SafeSummarySchema.nullable().optional(),
  developerOutcome: z.enum(["completed", "blocked"]).nullable().optional(),
};
