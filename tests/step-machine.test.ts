import { describe, expect, it } from "vitest";
import { createTestModel } from "xstate/graph";

import { ISSUE_STEPS, type IssueStep } from "../src/issue-phases.js";
import { nextStep, stepMachine, type OwnerEvent } from "../src/engine/workflow/step-machine.js";
import { ANSWERS, STEP_TABLE, type Transition } from "../src/engine/workflow/step-table.js";

const model = createTestModel(stepMachine);

function eventFor(answer: (typeof ANSWERS)[number]): OwnerEvent {
  return { type: `owner.${answer}` };
}

function expectedActions(transitionRule: Transition) {
  if ("command" in transitionRule) return [{ type: "runCommand", params: { command: transitionRule.command } }];
  if ("step" in transitionRule) return [{ type: "changeStep", params: { step: transitionRule.step, owner: transitionRule.owner } }];
  return [transitionRule.wait === "signal"
    ? { type: "wait", params: { on: "signal" } }
    : { type: "wait", params: { on: "poll", pollMs: transitionRule.wait.pollMs } }];
}

describe("stepMachine", () => {
  it("has shortest paths from backlog for every table-backed state edge", () => {
    const paths = model.getShortestPaths({ events: ANSWERS.map(eventFor) });
    expect(paths.some((path) => path.state.value === "planning")).toBe(true);

    for (const step of ISSUE_STEPS) {
      const rule = STEP_TABLE[step];
      if (rule.terminal) continue;
      for (const answer of ANSWERS) {
        const next = nextStep(step, eventFor(answer));
        expect(next.actions, `${step}.${answer}`).toEqual(expectedActions(rule.on[answer]));
      }
    }
  });

  it("gives each non-final state all owner transitions and finalizes terminal states", () => {
    for (const step of ISSUE_STEPS) {
      const config = stepMachine.config.states?.[step];
      if (STEP_TABLE[step].terminal) {
        expect(config?.type).toBe("final");
        continue;
      }
      for (const answer of ANSWERS) expect(config?.on?.[`owner.${answer}`], `${step}.${answer}`).toBeDefined();
      expect(config?.on?.["owner.unavailable"], `${step}.unavailable`).toBeDefined();
    }
  });

  it("keeps an unavailable owner read in the current step with a short poll", () => {
    expect(nextStep("reviewing_delivery", { type: "owner.unavailable", owner: "herdr", reason: "Herdr is unavailable" })).toEqual({
      step: "reviewing_delivery",
      actions: [{ type: "wait", params: { on: "poll", pollMs: 15_000 } }],
    });
  });

  it("keeps direct step transitions in the XState graph", () => {
    const simplePaths = model.getSimplePaths({ events: [eventFor("done"), { type: "owner.cancel" }] });
    const reached = new Set(simplePaths.map((path) => path.state.value));
    expect(reached).toContain("done");
    expect(reached).toContain("cancelled");
  });

  it("matches every table answer through nextStep", () => {
    for (const step of ISSUE_STEPS) {
      for (const answer of ANSWERS) {
        const transitionRule = STEP_TABLE[step].on[answer];
        expect(nextStep(step, eventFor(answer)).actions).toEqual(expectedActions(transitionRule));
      }
    }
  });

  it("rejects a missing state at compile time", () => {
    // @ts-expect-error IssueStep requires every state in the machine table.
    const missing: Record<IssueStep, unknown> = { backlog: {} };
    expect(missing.backlog).toEqual({});
  });
});
