import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { ApplicationFailure } from "../src/engine/failures.js";
import { executeIssueCommand, queryIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const failedHead = "d".repeat(40);

function repairState(workflowId: string, issueId: string) {
  return {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("ci_repairing"),
    revision: 20,
    owner: "human" as const,
    allowedCommands: ["repair_ci" as const, "cancel_issue" as const],
    pendingAction: "Repair CI",
    releaseId: "release-1",
    branchName: "forge/issue/repair-execution-id",
    resultCommit: failedHead,
    resultTree: engineFixture.tree,
    developerExecutionId: "persisted-delivery",
    developerSessionRef: "persisted-session",
    ciRunId: "ci-run-1",
    ciAttemptId: "ci-attempt-1",
    ciRepairPlanId: "ci-repair-plan-1",
    ciRepairPlanArtifactId: "ci-repair-plan-artifact-1",
    ciRepairPlanEvidenceArtifactId: "ci-repair-evidence-artifact-1",
    lastEventId: `${workflowId}:20`,
  };
}

async function repairCi(h: Awaited<ReturnType<typeof createEngineHarness>>, issueId: string) {
  const started = await h.startContinuation(issueId, repairState(h.workflowId(issueId), issueId));
  const before = await queryIssueWorkflow(h.config, started.workflowId);
  return executeIssueCommand(h.config, started.workflowId, "repair_ci", { expectedRevision: before.revision, actorUserId: engineFixture.actorUserId });
}

test("a CI repair that fails before its ledger insert retains the persisted execution ID", async () => {
  const issueId = "repair-execution-id-failure";
  const h = await createEngineHarness({
    findCiRepairPriorDelivery: async () => ({ developerExecutionId: "persisted-delivery", developerSessionRef: "persisted-session", worktreePath: "/worktrees/persisted-delivery" }),
    runCiRepair: async () => { throw ApplicationFailure.nonRetryable("The repair scope does not match the delivery.", "developer-scope-mismatch"); },
  });
  h.seedTask(issueId);
  try {
    const state = await repairCi(h, issueId);

    expect(state.developerExecutionId).toBe("persisted-delivery");
    expect(h.calls.get("runCiRepair")).toBe(1);
  } finally {
    await h.stop();
  }
});

test("a completed CI repair claims its persisted execution ID", async () => {
  const issueId = "repair-execution-id-completion";
  const h = await createEngineHarness({
    findCiRepairPriorDelivery: async () => ({ developerExecutionId: "persisted-delivery", developerSessionRef: "persisted-session", worktreePath: "/worktrees/persisted-delivery" }),
    runCiRepair: async () => ({ repairId: "repair-1", developerExecutionId: "new-repair", developerSessionRef: "new-session", branchName: "forge/issue/repair-execution-id", priorCommit: failedHead, priorTree: engineFixture.tree, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery-1", evidenceArtifactId: "evidence-1", summary: "CI repaired", outcome: "completed" as const }),
  });
  h.seedTask(issueId);
  try {
    const state = await repairCi(h, issueId);

    expect(state.developerExecutionId).toBe("new-repair");
  } finally {
    await h.stop();
  }
});
