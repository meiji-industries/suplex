import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { signalIssueGithubPullRequestSync } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const reviewedCommit = "d".repeat(40);

function deliveryReady(issueId: string) {
  return {
    ...buildInitialIssueWorkflowState({ workflowId: `workflow-${issueId}`, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_ready"),
    revision: 20,
    owner: "human" as const,
    allowedCommands: ["cancel_issue" as const],
    pendingAction: "The reviewed release is blocked",
    branchName: `forge/issue/${issueId}`,
    baseBranch: "main",
    targetBaseSha: engineFixture.base,
    resultCommit: reviewedCommit,
    resultTree: engineFixture.tree,
    deliveryReviewId: "review-approved",
    releaseStatus: "blocked" as const,
    releaseFailureCode: "stale-reviewed-revision" as const,
    lastEventId: `workflow-${issueId}:20`,
  };
}

test.each([
  ["merged", "done", "Done. Pull request #126 was merged outside Forge."],
  ["open", "ci_waiting", "Forge waits for CI"],
  ["changed", "delivery_ready", "The Planner reviews the latest changes"],
] as const)("a stale release adopts a %s GitHub observation", async (outcome, step, pendingAction) => {
  const issueId = `external-${outcome}`;
  const observedHead = outcome === "changed" ? "e".repeat(40) : reviewedCommit;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 126, url: "https://github.test/126", state: outcome === "merged" ? "merged" as const : "open" as const, isDraft: false, headSha: observedHead, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    adoptPullRequestRelease: async (input) => ({ releaseId: "release-adopted", repository: input.repository, branchName: input.branchName, baseBranch: input.baseBranch, targetBaseSha: engineFixture.base, headSha: input.headSha, headTree: engineFixture.tree, pullRequestNumber: input.pullRequestNumber, pullRequestUrl: "https://github.test/126" }),
  });
  h.seedTask(issueId, { deliveryTarget: "merged" });
  try {
    const started = await h.startContinuation(issueId, deliveryReady(issueId), { repository: "acme/forge", deliveryTarget: "merged" });
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    const state = await h.settle(started.workflowId, (value) => value.step === step && value.pendingAction === pendingAction);

    expect(state).toMatchObject({ step, pendingAction });
    expect(h.calls.get("observeGithubPullRequest")).toBe(1);
    expect(h.calls.get("adoptPullRequestRelease") ?? 0).toBe(outcome === "open" ? 1 : 0);
    if (outcome === "open") expect(state).toMatchObject({ releaseId: "release-adopted", expectedHeadSha: reviewedCommit, releaseStatus: "ready" });
    if (outcome === "changed") expect(state).toMatchObject({ deliveryReviewId: null, releaseId: null, expectedHeadSha: null });
  } finally {
    await h.stop();
  }
});
