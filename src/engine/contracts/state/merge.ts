import { z } from "zod";
import { durableId } from "../primitives.js";

export const mergeStateFields = {
  mergeResolutionPlanId: durableId.nullable().optional(),
  mergeResolutionPlanArtifactId: durableId.nullable().optional(),
  mergeResolutionLeadExecutionId: durableId.nullable().optional(),
  mergeResolutionLeadSessionRef: durableId.nullable().optional(),
  mergeResolutionDeveloperExecutionId: durableId.nullable().optional(),
  mergeResolutionDeveloperSessionRef: durableId.nullable().optional(),
  mergeDecision: z.object({ question: z.string().min(1), choices: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), detail: z.string().min(1).max(200) })), recommendedChoiceId: z.string().min(1) }).nullable().optional(), // bound: choice detail is short product-copy metadata
};

export const mergeStateFields2 = {
  mergeAttempt: z.number().int().nonnegative().optional(),
  mergeRetryAt: z.string().datetime().nullable().optional(),
  mergeObservationId: durableId.nullable().optional(),
  mergeBlockerCode: durableId.nullable().optional(),
  mergeBlockerEvidenceArtifactId: durableId.nullable().optional(),
  completionReceiptId: durableId.nullable().optional(),
  mergeOutcome: z.enum(["open", "merged", "closed_without_merge", "changed_head", "changed_base", "provider_unavailable"]).nullable().optional(),
};
