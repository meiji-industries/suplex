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

export type TaskLimits = z.infer<typeof TaskLimitsSchema>;
export type TaskLimitUsage = z.infer<typeof TaskLimitUsageSchema>;
export type TaskLimitPause = z.infer<typeof TaskLimitPauseSchema>;
export type TaskLimitDecision = z.infer<typeof TaskLimitDecisionSchema>;

export type TaskLimitEvaluation = { kind: "within_limits" } | { kind: "limit_reached"; pause: TaskLimitPause };

export function evaluateTaskLimits(input: { limits: TaskLimits; usage: TaskLimitUsage; allowance: TaskLimits }): TaskLimitEvaluation {
  const hitBudget = input.limits.budgetUsd > 0 && input.usage.estimatedCostUsd !== null && input.usage.estimatedCostUsd >= input.limits.budgetUsd;
  const hitTurns = input.limits.maxTurns > 0 && input.usage.admittedTurns >= input.limits.maxTurns;
  if (!hitBudget && !hitTurns) return { kind: "within_limits" };
  const budgetAllowance = input.allowance.budgetUsd > 0 ? input.allowance.budgetUsd : input.limits.budgetUsd;
  const turnAllowance = input.allowance.maxTurns > 0 ? input.allowance.maxTurns : input.limits.maxTurns;
  return {
    kind: "limit_reached",
    pause: {
      kind: "task_limit",
      reason: hitBudget && hitTurns ? "budget_and_turns" : hitBudget ? "budget" : "turns",
      limits: input.limits,
      usage: input.usage,
      proposedLimits: {
        budgetUsd: hitBudget && input.usage.estimatedCostUsd !== null ? input.usage.estimatedCostUsd + budgetAllowance : input.limits.budgetUsd,
        maxTurns: hitTurns ? input.usage.admittedTurns + turnAllowance : input.limits.maxTurns,
      },
    },
  };
}

export function taskLimitQuestion(pause: TaskLimitPause): string {
  const reached = pause.reason === "budget" ? "estimated spend budget" : pause.reason === "turns" ? "turn limit" : "estimated spend budget and turn limit";
  const spend = pause.usage.estimatedCostUsd === null ? "Estimated spend is not available." : pause.limits.budgetUsd === 0 ? `Estimated spend is $${pause.usage.estimatedCostUsd.toFixed(2)}. The budget is disabled.` : `Estimated spend is $${pause.usage.estimatedCostUsd.toFixed(2)} of $${pause.limits.budgetUsd.toFixed(2)}.`;
  const turns = pause.limits.maxTurns === 0 ? `${pause.usage.admittedTurns} turns were admitted. The turn limit is disabled.` : `Admitted turns are ${pause.usage.admittedTurns} of ${pause.limits.maxTurns}.`;
  const proposedBudget = pause.proposedLimits.budgetUsd === 0 ? "no budget limit" : `a $${pause.proposedLimits.budgetUsd.toFixed(2)} budget`;
  const proposedTurns = pause.proposedLimits.maxTurns === 0 ? "no turn limit" : `${pause.proposedLimits.maxTurns} turns`;
  return `This task reached its ${reached}. ${spend} ${turns} Forge proposes ${proposedBudget} and ${proposedTurns}. A native turn already in progress can finish before Forge pauses. Select how to continue.`;
}
