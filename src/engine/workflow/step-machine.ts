import { setup, transition } from "xstate";

import { assertNever } from "../../assert-never.js";
import type { IssueCommand } from "../../commands/registry.js";
import { ISSUE_STEPS, type IssueStep } from "../../issue-phases.js";
import {
  ANSWERS,
  OWNERS,
  STEP_TABLE,
  type Answer,
  type OwnerRead,
  type StepRule,
  type Transition,
} from "./step-table.js";

export { ANSWERS, OWNERS };

export type OwnerEvent =
  | { type: "owner.done"; outcome?: "approved" | "findings" | "disagreement" | undefined }
  | { type: "owner.live" }
  | { type: "owner.absent" }
  | { type: "owner.failed" }
  | { type: "owner.unavailable"; owner: OwnerRead["owner"]; reason: string }
  | { type: "owner.cancel" };

export type DriverAction =
  | { type: "runCommand"; params: { command: IssueCommand } }
  | { type: "wait"; params: { on: "signal" | "poll"; pollMs?: number } }
  | { type: "changeStep"; params: { step: IssueStep; owner: "lead" | "human" } };

type StepMeta = { waitsOn: StepRule["waitsOn"]; humanAction?: IssueCommand };
type ActiveState = {
  meta: StepMeta;
  on: Record<`owner.${Answer}`, { target?: IssueStep }> & { "owner.cancel": { target: "cancelled" }; "owner.unavailable": {} };
};
type FinalState = { type: "final"; meta: StepMeta };
type StepState = ActiveState | FinalState;

const commandTargets: Partial<Record<IssueCommand, IssueStep>> = {
  start_planning: "planning",
  request_supplemental_review: "supplemental_review",
  start_development: "ready_for_development",
  retry_development: "development",
  repair_delivery: "repair_required",
  review_delivery: "reviewing_delivery",
  publish_draft: "releasing",
  arbitrate_review: "review_arbitration",
  final_review: "final_review",
  resolve_merge_conflict: "merge_conflict_resolving",
  reconcile_ci: "ci_waiting",
  repair_ci: "ci_repairing",
  reconcile_acceptance: "ready_reconciliation",
  request_delivery_changes: "development",
  reconcile_merge: "manual_merge",
} as const satisfies Partial<Record<IssueCommand, IssueStep>>;

function actionsFor(transitionRule: Transition): DriverAction[] {
  if ("command" in transitionRule) {
    return [{ type: "runCommand", params: { command: transitionRule.command } }];
  }
  if ("step" in transitionRule) {
    return [{ type: "changeStep", params: { step: transitionRule.step, owner: transitionRule.owner } }];
  }
  if (transitionRule.wait === "signal") {
    return [{ type: "wait", params: { on: "signal" } }];
  }
  return [{ type: "wait", params: { on: "poll", pollMs: transitionRule.wait.pollMs } }];
}

function stateFor(rule: StepRule): StepState {
  const meta = { waitsOn: rule.waitsOn, ...(rule.humanAction ? { humanAction: rule.humanAction } : {}) };
  if (rule.terminal) return { type: "final", meta };

  return {
    meta,
    on: {
      ...Object.fromEntries(
        ANSWERS.map((answer) => {
          const transitionRule = rule.on[answer];
          return [`owner.${answer}`, { target: targetFor(transitionRule) }];
        }),
      ),
      "owner.cancel": { target: "cancelled" },
      "owner.unavailable": {},
    } as ActiveState["on"],
  };
}

function targetFor(transitionRule: Transition): IssueStep | undefined {
  if ("step" in transitionRule) return transitionRule.step;
  if ("command" in transitionRule) return commandTargets[transitionRule.command];
  return undefined;
}

const states = Object.fromEntries(
  ISSUE_STEPS.map((step) => [step, stateFor(STEP_TABLE[step])]),
) as Record<IssueStep, StepState> satisfies Record<IssueStep, StepState>;

export const stepMachine = setup({
  types: {} as { events: OwnerEvent },
}).createMachine({
  id: "issue",
  initial: "backlog",
  states,
});

export function nextStep(step: IssueStep, event: OwnerEvent): { step: IssueStep; actions: DriverAction[] } {
  const current = stepMachine.resolveState({ value: step });
  const [next] = transition(stepMachine, current, event);
  const value = next.value;
  if (typeof value !== "string") throw new Error("Issue steps must be atomic states");
  if (event.type === "owner.cancel") return { step: value, actions: [] };
  if (event.type === "owner.unavailable") return { step: value, actions: [{ type: "wait", params: { on: "poll", pollMs: 15_000 } }] };
  return { step: value, actions: actionsFor(STEP_TABLE[step].on[answerFor(event)]) };
}

function answerFor(event: Exclude<OwnerEvent, { type: "owner.cancel" | "owner.unavailable" }>): Answer {
  switch (event.type) {
    case "owner.done": return "done";
    case "owner.live": return "live";
    case "owner.absent": return "absent";
    case "owner.failed": return "failed";
    default: return assertNever(event);
  }
}

export type { Answer, OwnerRead, Transition };
