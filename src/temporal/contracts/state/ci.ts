import { z } from "zod";
import { durableId } from "../primitives.js";

export const ciStateFields = {
  ciRunId: durableId.nullable().optional(),
  ciAttempt: z.number().int().nonnegative().optional(),
  ciOutcome: z.enum(["waiting", "passed", "failed", "missing_required", "cancelled", "timed_out", "non_success", "stale_head", "rate_limited", "provider_unavailable", "invalid_provider_response"]).nullable().optional(),
  ciReason: z.string().max(128).nullable().optional(),
  ciOwner: z.enum(["system", "lead", "human"]).nullable().optional(),
  ciRepairable: z.boolean().optional(),
  ciAttemptId: durableId.nullable().optional(),
  ciEvidenceArtifactId: durableId.nullable().optional(),
  ciPolicyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  ciPropagationDeadline: z.string().datetime().nullable().optional(),
  ciOverallDeadline: z.string().datetime().nullable().optional(),
  ciRepairPlanId: durableId.nullable().optional(),
  ciRepairPlanArtifactId: durableId.nullable().optional(),
  ciRepairPlanEvidenceArtifactId: durableId.nullable().optional(),
  ciRepairPlanSummary: z.string().max(2_000).nullable().optional(),
  ciRepairLeadExecutionId: durableId.nullable().optional(),
  ciRepairLeadSessionRef: durableId.nullable().optional(),
  ciRepairDeveloperExecutionId: durableId.nullable().optional(),
  ciRepairDeveloperSessionRef: durableId.nullable().optional(),
  ciNextPollAt: z.string().datetime().nullable().optional(),
  ciRerunCount: z.number().int().nonnegative().optional(),
};
