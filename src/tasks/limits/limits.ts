import type { TaskLimits, TaskLimitUsage, TaskLimitPause } from "./contracts.js";
export { TaskLimitsSchema, TaskLimitUsageSchema, TaskLimitReasonSchema, TaskLimitPauseSchema, TaskLimitDecisionSchema } from "./contracts.js";
export type { TaskLimits, TaskLimitUsage, TaskLimitPause, TaskLimitDecision } from "./contracts.js";

export type TaskLimitEvaluation = { kind: "within_limits" } | { kind: "limit_reached"; pause: TaskLimitPause };

export function roundSuggestedBudget(proposedBudget: number, spent: number): number {
  return Math.max(Math.round(proposedBudget / 5) * 5, (Math.floor(spent / 5) + 1) * 5);
}

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
        budgetUsd: hitBudget && input.usage.estimatedCostUsd !== null ? roundSuggestedBudget(input.usage.estimatedCostUsd + budgetAllowance, input.usage.estimatedCostUsd) : input.limits.budgetUsd,
        maxTurns: hitTurns ? input.usage.admittedTurns + turnAllowance : input.limits.maxTurns,
      },
    },
  };
}

export function taskLimitQuestion(pause: TaskLimitPause): string {
  const reached = pause.reason === "budget" ? "estimated spend budget" : pause.reason === "turns" ? "turn limit" : "estimated spend budget and turn limit";
  const spend = pause.usage.estimatedCostUsd === null ? "Estimated spend is not available." : pause.limits.budgetUsd === 0 ? `Estimated spend is $${pause.usage.estimatedCostUsd.toFixed(2)}. The budget is disabled.` : `Estimated spend is $${pause.usage.estimatedCostUsd.toFixed(2)} of $${pause.limits.budgetUsd.toFixed(2)}.`;
  const turns = pause.limits.maxTurns === 0 ? `${pause.usage.admittedTurns} turns were admitted. The turn limit is disabled.` : `Admitted turns are ${pause.usage.admittedTurns} of ${pause.limits.maxTurns}.`;
  const budget = pause.reason === "turns" ? pause.proposedLimits.budgetUsd : roundSuggestedBudget(pause.proposedLimits.budgetUsd, pause.usage.estimatedCostUsd ?? 0);
  const proposedBudget = budget === 0 ? "no budget limit" : `a $${budget.toFixed(2)} budget`;
  const proposedTurns = pause.proposedLimits.maxTurns === 0 ? "no turn limit" : `${pause.proposedLimits.maxTurns} turns`;
  return `This task reached its ${reached}. ${spend} ${turns} Suplex proposes ${proposedBudget} and ${proposedTurns}. A native turn already in progress can finish before Suplex pauses. Select how to continue.`;
}
