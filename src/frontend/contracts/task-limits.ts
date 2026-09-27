import { z } from "zod";

const nonnegative = z.number().finite().nonnegative();

export const TaskLimitsSchema = z.object({ budgetUsd: nonnegative, maxTurns: z.number().int().nonnegative() }).strict();

export const TaskLimitUsageSchema = z.object({ estimatedCostUsd: nonnegative.nullable(), admittedTurns: z.number().int().nonnegative() }).strict();

export const TaskLimitReasonSchema = z.enum(["budget", "turns", "budget_and_turns"]);

export const TaskLimitPauseSchema = z.object({
  kind: z.literal("task_limit"),
  reason: TaskLimitReasonSchema,
  limits: TaskLimitsSchema,
  usage: TaskLimitUsageSchema,
  proposedLimits: TaskLimitsSchema,
}).strict();

export const TaskLimitDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_allowance") }).strict(),
  z.object({ kind: z.literal("change_limits"), limits: TaskLimitsSchema }).strict(),
  z.object({ kind: z.literal("cancel_task") }).strict(),
]);

export type TaskLimitDecision = z.infer<typeof TaskLimitDecisionSchema>;

export type TaskLimitPause = z.infer<typeof TaskLimitPauseSchema>;
