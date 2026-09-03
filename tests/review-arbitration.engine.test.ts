import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState, type ReviewArbitration } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function arbitration(decision: ReviewArbitration["decision"]): ReviewArbitration {
  const payload = decision === "ask" ? { askUserQuestion: { header: "Choose path", id: "review_path", question: "Which path should Forge take?", options: [{ label: "Repair", description: "Repair the finding." }, { label: "Accept", description: "Accept the delivery." }, { label: "Cancel", description: "Cancel the task." }], isOther: true as const, isSecret: false as const }, repair: null, recommendation: null } : decision === "repair" ? { askUserQuestion: null, repair: { findingId: "finding_1", files: ["src/example.ts"], instruction: "Repair the finding.", patch: null }, recommendation: null } : { askUserQuestion: null, repair: null, recommendation: decision === "accept" ? "Accept the delivery." : "Cancel the task." };
  return { kind: "review_arbitration", summary: "The Planner decided the review outcome.", decision, ...payload };
}

function oldDeadEnd(issueId: string, workflowId: string) {
  return {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("review_arbitration"), revision: 5, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "The Planner decides how to resolve the review", leadSessionRef: "lead-session", leadOutputArtifactId: "plan", worktreePath: "/worktree", arbitrationCount: 1, arbitrationRepairExhausted: false, lastEventId: `${workflowId}:5`,
  };
}

for (const [decision, expected] of [["ask", { step: "review_arbitration", owner: "human", commands: ["respond_plan_blocker", "cancel_issue"], category: "member_decision" }], ["repair", { step: "repair_required", owner: "lead", commands: ["repair_delivery", "cancel_issue"], category: null }], ["accept", { step: "delivery_reviewed", owner: "human", commands: ["publish_draft", "cancel_issue"], category: "member_authorization" }], ["cancel", { step: "development", owner: "human", commands: ["cancel_issue", "respond_plan_blocker"], category: "member_decision" }]] as const) {
  test(`routes ${decision} arbitration`, async () => {
    const h = await createEngineHarness({ arbitrateReview: async () => ({ arbitration: arbitration(decision), leadExecutionId: "lead-execution", leadSessionRef: "lead-session", outputArtifactId: "arbitration-output", evidenceArtifactId: "arbitration-evidence" }) });
    h.seedTask(`arbitration-${decision}`);
    const workflowId = h.workflowId(`arbitration-${decision}`);
    try {
      const started = await h.startContinuation(`arbitration-${decision}`, oldDeadEnd(`arbitration-${decision}`, workflowId));
      const state = await h.settle(started.workflowId, (value) => value.step === expected.step && value.owner === expected.owner);
      expect(state.allowedCommands).toEqual(expect.arrayContaining(Array.from(expected.commands)));
      expect(state.blocker?.category ?? null).toBe(expected.category);
    } finally { await h.stop(); }
  });
}

test("refuses a second repair and asks the member to decide", async () => {
  let calls = 0;
  const h = await createEngineHarness({ arbitrateReview: async () => { calls += 1; return { arbitration: arbitration("repair"), leadExecutionId: `lead-${calls}`, leadSessionRef: "lead-session", outputArtifactId: `output-${calls}`, evidenceArtifactId: `evidence-${calls}` }; } });
  h.seedTask("arbitration-refused");
  const workflowId = h.workflowId("arbitration-refused");
  try {
    const started = await h.startContinuation("arbitration-refused", { ...oldDeadEnd("arbitration-refused", workflowId), arbitrationCount: 2, arbitrationRepairExhausted: true });
    const state = await h.settle(started.workflowId, (value) => value.step === "development" && value.owner === "human");
    expect(calls).toBe(2);
    expect(state.allowedCommands).toEqual(expect.arrayContaining(["cancel_issue", "respond_plan_blocker"]));
    expect(state.blocker).toMatchObject({ category: "member_decision" });
  } finally { await h.stop(); }
});
