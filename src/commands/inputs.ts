import { z } from "zod";

import { DecisionIdempotencyKeySchema } from "../plan-governance.js";

export const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const exactSha = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const StartPlanningInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  commandId: durableId.optional().default("legacy-command"),
  planAuthorizationId: durableId.optional(),
  planArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  reconcileOnly: z.literal(true).optional(),
});

export const ResolveDecisionBlockerInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  answerArtifactId: durableId,
  answerSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type ResolveDecisionBlockerInput = z.infer<typeof ResolveDecisionBlockerInputSchema>;

export const RecordProgressInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  commandId: durableId.optional().default("legacy-command"),
});

export const PlanCommandInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  commandId: durableId.optional().default("legacy-command"),
  note: z.string().max(4_000).optional(),
  worktreeDecision: z.enum(["reuse", "new"]).optional(),
  exactBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  decision: z.enum(["accept", "request_changes", "cancel"]).optional(),
  idempotencyKey: DecisionIdempotencyKeySchema.optional(),
  noteStagingRef: durableId.optional(),
  noteSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedWorkflowRevision: z.number().int().nonnegative().optional(),
  answerStagingRef: durableId.optional(),
  answerSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  planAuthorizationId: durableId.optional(),
  planArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

const RevisionCommandBaseSchema = z.object({ expectedRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000) }).strict();
export const PlanRevisionCommandSchema = z.discriminatedUnion("worktreeDisposition", [
  RevisionCommandBaseSchema.extend({ worktreeDisposition: z.literal("reuse") }).strict(),
  RevisionCommandBaseSchema.extend({ worktreeDisposition: z.literal("new"), exactBaseSha: exactSha }).strict(),
]);
export const ContinueWorkCommandSchema = z.object({ expectedRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000) }).strict();

export type StartPlanningInput = z.input<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.input<typeof RecordProgressInputSchema>;
export type PlanCommandInput = z.input<typeof PlanCommandInputSchema>;
export type PlanRevisionCommand = z.infer<typeof PlanRevisionCommandSchema>;
export type ContinueWorkCommand = z.infer<typeof ContinueWorkCommandSchema>;
