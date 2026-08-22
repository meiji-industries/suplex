import { z } from "zod";

import { DecisionIdempotencyKeySchema } from "../plan-governance.js";

export const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const exactSha = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const StartPlanningInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  actorUserId: durableId,
  commandId: durableId.optional().default("legacy-command"),
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
});

const RevisionCommandBaseSchema = z.object({ expectedRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000), worktreeDisposition: z.enum(["reuse", "new"]).optional(), exactBaseSha: exactSha.optional() }).strict();
type ParsedPlanRevisionCommand =
  | { expectedRevision: number; actorUserId: string; reason: string; worktreeDisposition: "reuse" }
  | { expectedRevision: number; actorUserId: string; reason: string; worktreeDisposition: "new"; exactBaseSha: string };
// Old workflow histories include a worktree choice. New requests always reuse when possible;
// retain those fields solely so historical update payloads can still be parsed.
export const PlanRevisionCommandSchema = RevisionCommandBaseSchema.transform(({ worktreeDisposition: _worktreeDisposition, exactBaseSha: _exactBaseSha, ...input }): ParsedPlanRevisionCommand => ({ ...input, worktreeDisposition: "reuse" }));
export const ContinueWorkCommandSchema = z.object({ expectedRevision: z.number().int().nonnegative(), actorUserId: durableId, reason: z.string().trim().min(1).max(4_000) }).strict();

export type StartPlanningInput = z.input<typeof StartPlanningInputSchema>;
export type RecordProgressInput = z.input<typeof RecordProgressInputSchema>;
export type PlanCommandInput = z.input<typeof PlanCommandInputSchema>;
// Preserve the historical input shape for workflow handlers and replay typing; parsing above
// canonicalizes every new command to `reuse` before it reaches them.
export type PlanRevisionCommand = z.input<typeof PlanRevisionCommandSchema>;
export type ContinueWorkCommand = z.infer<typeof ContinueWorkCommandSchema>;
