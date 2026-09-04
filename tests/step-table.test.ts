import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ISSUE_COMMAND_NAMES } from "../src/commands/registry.js";
import { ISSUE_STEPS } from "../src/issue-phases.js";
import { STEP_TABLE } from "../src/engine/workflow/step-table.js";

const answers = ["done", "live", "absent", "failed"] as const;
const resultSchemas = readFileSync(new URL("../src/turn-result-schemas.ts", import.meta.url), "utf8");

describe("STEP_TABLE", () => {
  it("covers each issue step once", () => {
    expect(Object.keys(STEP_TABLE).sort()).toEqual([...ISSUE_STEPS].sort());
  });

  it("has exhaustive, live rules for non-terminal steps", () => {
    for (const [step, rule] of Object.entries(STEP_TABLE)) {
      if (rule.terminal) continue;
      expect(rule.waitsOn, step).not.toBeNull();
      for (const answer of answers) expect(rule.on[answer], `${step}.${answer}`).toBeDefined();
      expect(
        rule.waitsOn?.owner === "herdr"
          || rule.waitsOn?.owner === "github"
          || rule.waitsOn?.owner === "git"
          || rule.waitsOn?.owner === "timer"
          || Boolean(rule.humanAction),
        step,
      ).toBe(true);
    }
  });

  it("names only registered commands and issue steps", () => {
    for (const rule of Object.values(STEP_TABLE)) {
      for (const transition of Object.values(rule.on)) {
        if ("command" in transition) expect(ISSUE_COMMAND_NAMES).toContain(transition.command);
        if ("step" in transition) expect(ISSUE_STEPS).toContain(transition.step);
      }
      if (rule.humanAction) expect(ISSUE_COMMAND_NAMES).toContain(rule.humanAction);
    }
  });

  it("uses result-schema prompt kinds for Herdr reads", () => {
    for (const [step, rule] of Object.entries(STEP_TABLE)) {
      if (rule.waitsOn?.owner !== "herdr") continue;
      const promptKind = rule.waitsOn.promptKind.replaceAll("-", "\\-");
      expect(resultSchemas, step).toMatch(new RegExp(`(?:"${promptKind}"|${promptKind}):`));
    }
  });
});
