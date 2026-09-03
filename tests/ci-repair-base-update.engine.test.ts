import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { executeIssueCommand, queryIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const head = "b".repeat(40);

function ciWaitingState(workflowId: string, issueId: string, ciBaseUpdateCount: number) {
  return {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("ci_waiting"),
    revision: 20,
    owner: "lead" as const,
    allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const],
    pendingAction: "Forge waits for CI",
    leadSessionRef: "lead-session",
    developerExecutionId: "developer-execution",
    branchName: `forge/issue/${issueId}`,
    targetBaseSha: engineFixture.base,
    resultCommit: head,
    resultTree: engineFixture.tree,
    releaseId: "release-1",
    releaseRepository: "acme/forge",
    ciBaseUpdateCount,
    lastEventId: `${workflowId}:20`,
  };
}

function failedCi(input: { attemptNumber: number; expectedHeadSha: string }) {
  return { runId: "ci-run-1", attemptId: "ci-attempt-1", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci-evidence", outcome: "failed" as const, reason: "required_check_failed", owner: "integrator" as const, repairable: true, summary: "Required check failed", retryAt: null, nextPollAt: null, propagationDeadline: null, overallDeadline: null };
}

test.each([0, 2])("failed repairable CI freshens the base only below the limit (%i)", async (ciBaseUpdateCount) => {
  const issueId = `ci-repair-base-${ciBaseUpdateCount}`;
  const calls: string[] = [];
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE" as const, checks: { total: 1, pending: 0, failing: 1, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    reconcileCi: async (input) => failedCi(input),
    updateCiFromBase: async () => {
      calls.push("updateCiFromBase");
      return { outcome: "no_drift", summary: "Base is current" };
    },
    planCiRepair: async () => {
      calls.push("planCiRepair");
      return { planId: "ci-repair-plan", planArtifactId: "ci-repair-plan-artifact", evidenceArtifactId: "ci-repair-plan-evidence", leadExecutionId: "ci-repair-lead", leadSessionRef: "ci-repair-session", summary: "Re-run CI", disposition: "rerun" as const };
    },
    rerunCi: async () => ({ rerunRunIds: ["ci-run-1"], summary: "CI rerun started" }),
  });
  h.seedTask(issueId);
  try {
    const started = await h.startContinuation(issueId, ciWaitingState(h.workflowId(issueId), issueId, ciBaseUpdateCount));
    const state = await queryIssueWorkflow(h.config, started.workflowId);
    await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: state.revision, actorUserId: engineFixture.actorUserId });

    expect(calls).toEqual(ciBaseUpdateCount === 0 ? ["updateCiFromBase", "planCiRepair"] : ["planCiRepair"]);
  } finally {
    await h.stop();
  }
});
