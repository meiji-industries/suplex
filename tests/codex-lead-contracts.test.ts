import { expect, test } from "vitest";

import { LeadOutputJsonSchema, LeadOutputSchema } from "../src/codex-lead-contracts.js";
import { SafeSummarySchema, toSafeSummary } from "../src/temporal/issue-contracts.js";

test("multiline and multibyte Lead summaries fit bounded Temporal state", () => {
  const summary = toSafeSummary(`A detailed plan\n${"évidence ".repeat(80)}`);
  expect(summary).not.toMatch(/[\r\n]/);
  expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(240);
  expect(summary.endsWith("…")).toBe(true);
  expect(SafeSummarySchema.parse(summary)).toBe(summary);
});

test("Lead contracts are strict and step numbering is contiguous", () => {
  const plan = {
    kind: "plan" as const,
    summary: "Bounded plan",
    reproduction: null,
    rootCauseAnalysis: "A known defect.",
    steps: [{ number: 1, instruction: "Inspect the seam", entryPoint: "src/index.ts", completionCriterion: "The seam is covered", verification: "Run the focused test" }],
    compatibilityAnalysis: "No compatibility change.",
    operationalAnalysis: "No operational change.",
    verificationStrategy: "Run the focused test.",
    unresolvedTechnicalQuestions: [],
    materialCategories: [],
    affectedPaths: ["src/index.ts"],
    materiality: [],
  };
  expect(LeadOutputSchema.safeParse(plan).success).toBe(true);
  expect(LeadOutputSchema.safeParse({ ...plan, extra: true }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ ...plan, steps: [{ ...plan.steps[0], number: 2 }] }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ kind: "decision_blocker", category: "human_decision", summary: "Choose", evidence: "Evidence", owner: "human", question: "Which?", nextAction: "Answer", resumePhase: "planning", extra: true }).success).toBe(false);
  const branches = (LeadOutputJsonSchema as { oneOf?: Array<{ additionalProperties?: boolean }> }).oneOf ?? [];
  expect(branches).toHaveLength(2);
  expect(branches.every((branch) => branch.additionalProperties === false)).toBe(true);
});
