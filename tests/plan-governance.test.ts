import { expect, test } from "vitest";

import { PlanDecisionSubjectSchema, PlanSubjectSchema, routeLeadResult } from "../src/plan-governance.js";

test("decision subjects retain only plan identity and workflow revision", () => {
  const plan = PlanSubjectSchema.parse({ planRevision: 2, artifactId: "artifact-plan", leadSessionRef: "session-1", ignored: "value" });
  expect(PlanDecisionSubjectSchema.parse({ plan, expectedWorkflowRevision: 3 })).toEqual({ plan, expectedWorkflowRevision: 3 });
  expect(plan).toEqual({ planRevision: 2, artifactId: "artifact-plan", leadSessionRef: "session-1" });
});

test("every plan waits for approval, with supplemental review when configured", () => {
  expect(routeLeadResult({ kind: "plan" }, { supplementalReview: false, reviewerConfigured: false })).toMatchObject({ step: "approval", owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue"] });
  expect(routeLeadResult({ kind: "plan" }, { supplementalReview: true, reviewerConfigured: true }).allowedCommands).toContain("request_supplemental_review");
});

test("decision blockers remain planning blockers", () => {
  expect(routeLeadResult({ kind: "decision_blocker" }, { supplementalReview: false, reviewerConfigured: false })).toMatchObject({ step: "planning", owner: "human" });
});
