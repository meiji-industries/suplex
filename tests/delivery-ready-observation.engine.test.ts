import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { queryIssueWorkflow, signalIssueGithubPullRequestSync } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("repeated stale PR observations revise delivery readiness once", async () => {
  const reviewedCommit = "a".repeat(40);
  const stalePullRequestHead = "b".repeat(40);
  let observations = 0;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => {
      observations += 1;
      return { exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: stalePullRequestHead, baseSha: engineFixture.base, mergeable: "MERGEABLE" as const, checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null };
    },
  });
  h.seedTask("delivery-ready-stale-observation");
  try {
    const workflowId = h.workflowId("delivery-ready-stale-observation");
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "delivery-ready-stale-observation", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      ...at("delivery_ready"),
      revision: 20,
      owner: "lead" as const,
      allowedCommands: ["review_delivery" as const, "cancel_issue" as const],
      pendingAction: "The Planner reviews the latest changes",
      releaseRepository: "acme/forge",
      branchName: "forge/issue/delivery-ready-stale-observation",
      resultCommit: reviewedCommit,
      deliveryReviewId: null,
      deliveryReviewOutcome: null,
      deliveryReviewSummary: null,
      releaseId: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      expectedHeadSha: null,
      expectedHeadTree: null,
      ciRunId: null,
      ciNextPollAt: null,
      finalReviewId: null,
      acceptanceId: null,
      processedCommandIds: Array.from({ length: 12 }, (_, index) => `${workflowId}:auto-review_delivery:${20 + index}`),
      lastEventId: `${workflowId}:20`,
    };
    const started = await h.startContinuation("delivery-ready-stale-observation", continuationState);

    for (let count = 1; count <= 3; count += 1) {
      await signalIssueGithubPullRequestSync(h.config, started.workflowId);
      await h.settle(started.workflowId, () => observations === count);
    }

    const state = await queryIssueWorkflow(h.config, started.workflowId);
    expect(state).toMatchObject({ revision: 21, step: "delivery_ready", owner: "lead", pendingAction: "The Planner reviews the latest changes" });
  } finally {
    await h.stop();
  }
});
