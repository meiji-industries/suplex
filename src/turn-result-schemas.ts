import { z, type ZodType } from "zod";

import { BrowserProofInputSchema } from "./browser-proof.js";
import { CiRepairPlanSchema, DeliveryReviewSchema, MergeConflictPlanSchema } from "./engine/issue-contracts.js";
import { LeadOutputSchema } from "./lead-contracts.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const LeadReviewResponseSchema = z.object({
  version: z.literal(1),
  originalPlanRevision: z.number().int().nonnegative(),
  reviewArtifactId: durableId,
  reviewResponse: z.string().min(1),
  result: LeadOutputSchema,
}).strict();

export const SupplementalReviewSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const review = value as Record<string, unknown>;
    if (review.opinion === "approve" || review.opinion === "request_changes") return { verdict: review.opinion === "approve" ? "approve" : "revise", summary: review.summary, concerns: Array.isArray(review.concerns) ? review.concerns.map((text) => ({ severity: "advisory", text })) : Array.isArray(review.requiredChanges) ? review.requiredChanges.map((text) => ({ severity: "blocking", text })) : [] };
  }
  return value;
}, z.object({
  verdict: z.enum(["approve", "revise"]),
  summary: z.string().min(1),
  concerns: z.array(z.object({ severity: z.enum(["blocking", "advisory"]), text: z.string().min(1), step: z.number().int().positive().optional() })),
}));

export const DeliveryRepairLeadOutputSchema = z.object({
  kind: z.literal("delivery_repair_plan"),
  summary: z.string().min(1),
  steps: z.array(z.object({ number: z.number().int().positive(), instruction: z.string().min(1), verification: z.string().min(1) })).min(1),
  verificationStrategy: z.string().min(1),
  unresolvedTechnicalQuestions: z.array(z.string()).length(0),
});

const DeveloperDeliveryStepSchema = z.object({
  number: z.number().int().positive(),
  status: z.enum(["completed", "incomplete", "not_completed", "blocked", "not_applicable_locally"]),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.string()).optional(),
  testResults: z.array(z.string()).optional(),
  notes: z.string(),
});
export const DeveloperObjectionSchema = z.object({ findingId: z.string().min(1), reason: z.string().min(1) }).strict();
export const DeveloperDeliveryReportSchema = z.object({
  kind: z.literal("delivery"),
  summary: z.string().min(1),
  steps: z.array(DeveloperDeliveryStepSchema).min(1),
  authorizedStepsNotCompleted: z.array(z.number().int().positive()),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().nullable(),
  objections: z.array(DeveloperObjectionSchema).default([]),
  visualEvidence: BrowserProofInputSchema.optional(),
});
export const DeveloperRepairReportSchema = z.object({
  summary: z.string().min(1),
  blocker: z.string().nullable(),
  objections: z.array(DeveloperObjectionSchema).default([]),
  visualEvidence: BrowserProofInputSchema.optional(),
}).strict();
export const DeveloperMergeConflictResolutionReportSchema = z.object({
  kind: z.literal("merge_conflict_resolution"),
  summary: z.string().min(1),
  resolvedFiles: z.array(z.string().min(1)),
  commandsRun: z.array(z.string()).min(1),
  testResults: z.array(z.string()).min(1),
  resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  resultTree: z.string().regex(/^[a-f0-9]{40,64}$/i),
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().nullable(),
});

const agentResultSchemas: Readonly<Record<string, ZodType>> = {
  "lead-plan": LeadOutputSchema,
  "lead-plan-revision": LeadOutputSchema,
  "delivery-repair-plan": DeliveryRepairLeadOutputSchema,
  "merge-conflict-plan": MergeConflictPlanSchema,
  "ci-repair-plan": CiRepairPlanSchema,
  "delivery-review": DeliveryReviewSchema,
  "final-review": DeliveryReviewSchema,
  "supplemental-review": SupplementalReviewSchema,
  "lead-consolidation": LeadReviewResponseSchema,
  "lead-consolidation-correction": LeadReviewResponseSchema,
};
const developerResultSchemas: Readonly<Record<string, ZodType>> = {
  implementation: DeveloperDeliveryReportSchema,
  "delivery-repair": DeveloperRepairReportSchema,
  "ci-repair": DeveloperRepairReportSchema,
  "merge-conflict-resolution": DeveloperMergeConflictResolutionReportSchema,
};

export function turnResultSchema(ledger: "agent" | "developer", promptKind: string): ZodType | undefined {
  return (ledger === "agent" ? agentResultSchemas : developerResultSchemas)[promptKind];
}
