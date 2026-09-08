import { expect, test } from "vitest";
import { evaluateTaskLimits } from "../src/task-limits.js";

test("task limits enforce budget and turns independently", () => {
  expect(evaluateTaskLimits({ limits: { budgetUsd: 15, maxTurns: 40 }, usage: { estimatedCostUsd: 14.99, admittedTurns: 39 }, allowance: { budgetUsd: 15, maxTurns: 40 } })).toEqual({ kind: "within_limits" });
  expect(evaluateTaskLimits({ limits: { budgetUsd: 15, maxTurns: 0 }, usage: { estimatedCostUsd: 15, admittedTurns: 400 }, allowance: { budgetUsd: 15, maxTurns: 40 } })).toMatchObject({ kind: "limit_reached", pause: { reason: "budget", proposedLimits: { budgetUsd: 30, maxTurns: 0 } } });
  expect(evaluateTaskLimits({ limits: { budgetUsd: 0, maxTurns: 40 }, usage: { estimatedCostUsd: 100, admittedTurns: 40 }, allowance: { budgetUsd: 15, maxTurns: 40 } })).toMatchObject({ kind: "limit_reached", pause: { reason: "turns", proposedLimits: { budgetUsd: 0, maxTurns: 80 } } });
  expect(evaluateTaskLimits({ limits: { budgetUsd: 0, maxTurns: 0 }, usage: { estimatedCostUsd: 100, admittedTurns: 400 }, allowance: { budgetUsd: 15, maxTurns: 40 } })).toEqual({ kind: "within_limits" });
  expect(evaluateTaskLimits({ limits: { budgetUsd: 15, maxTurns: 40 }, usage: { estimatedCostUsd: null, admittedTurns: 40 }, allowance: { budgetUsd: 15, maxTurns: 40 } })).toMatchObject({ kind: "limit_reached", pause: { reason: "turns", proposedLimits: { budgetUsd: 15, maxTurns: 80 } } });
});
