import { expect, test } from "vitest";

import { LeadOutputSchema, PersistedLeadOutputSchema } from "../src/codex-lead-contracts.js";
import { SafeSummarySchema, toSafeSummary } from "../src/temporal/issue-contracts.js";

const gitPresentation = {
  branchSlug: "improve-lead-contracts",
  pullRequestTitle: "Improve Lead plan contracts",
  pullRequestDescription: "Make the approved plan carry clear Git presentation metadata.",
};

test("multiline and multibyte Lead summaries fit bounded Temporal state", () => {
  const summary = toSafeSummary(`A detailed plan\n${"évidence ".repeat(80)}`);
  expect(summary).not.toMatch(/[\r\n]/);
  expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(240);
  expect(summary.endsWith("…")).toBe(true);
  expect(SafeSummarySchema.parse(summary)).toBe(summary);
});

test("Lead contracts are strict and step numbering is contiguous", () => {
  const askUserQuestion = { header: "Decision", id: "decision", question: "Which?", options: [{ label: "First (Recommended)", description: "The best supported choice." }, { label: "Second", description: "Choose the alternative." }, { label: "Defer", description: "Keep the task blocked." }], isOther: true, isSecret: false };
  const plan = {
    kind: "plan" as const,
    summary: "Bounded plan",
    gitPresentation,
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
  expect(LeadOutputSchema.safeParse({ ...plan, gitPresentation: undefined }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ ...plan, gitPresentation: { ...gitPresentation, branchSlug: "Task_Internal_Key" } }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ ...plan, extra: true }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ ...plan, steps: [{ ...plan.steps[0], number: 2 }] }).success).toBe(false);
  const blocker = { kind: "decision_blocker", category: "human_decision", summary: "Choose", evidence: "Evidence", owner: "human", askUserQuestion, nextAction: "Answer", resumePhase: "planning" };
  expect(LeadOutputSchema.safeParse(blocker).success).toBe(true);
  expect(LeadOutputSchema.safeParse({ ...blocker, extra: true }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ ...blocker, askUserQuestion: { ...askUserQuestion, options: askUserQuestion.options.slice(0, 2) } }).success).toBe(false);
});

test("persisted Lead plans from before materiality evidence remain readable", () => {
  const legacyPlan = {
    kind: "plan" as const,
    summary: "Historical plan",
    reproduction: null,
    rootCauseAnalysis: "Recorded before path evidence.",
    steps: [{ number: 1, instruction: "Inspect the seam", verification: "Review the result" }],
    compatibilityAnalysis: "No compatibility change.",
    operationalAnalysis: "No operational change.",
    verificationStrategy: "Review the result.",
    unresolvedTechnicalQuestions: [],
    materialCategories: [],
  };
  expect(LeadOutputSchema.safeParse(legacyPlan).success).toBe(false);
  expect(PersistedLeadOutputSchema.parse(legacyPlan)).toMatchObject({ gitPresentation: null, affectedPaths: [], materiality: [] });
});

test("persisted decision blockers from before structured choices remain readable", () => {
  const blocker = { kind: "decision_blocker", category: "human_decision", summary: "Choose", evidence: "Evidence", owner: "human", question: "Which?", nextAction: "Answer", resumePhase: "planning" } as const;
  expect(LeadOutputSchema.safeParse(blocker).success).toBe(false);
  expect(PersistedLeadOutputSchema.parse(blocker)).toEqual(blocker);
});
