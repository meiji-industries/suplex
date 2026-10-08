import type { TaskLimitPause } from "../../../contracts/generated/TaskLimitPause.js";

export function roundSuggestedBudget(proposedBudget: number, spent: number): number {
  return Math.max(Math.round(proposedBudget / 5) * 5, (Math.floor(spent / 5) + 1) * 5);
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
