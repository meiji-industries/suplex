import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";

import { ApplicationFailure } from "../src/engine/failures.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

test("a stale reviewed revision blocks publication for human review", async () => {
  const h = await createEngineHarness({
    observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    projectIssueState: async (event) => event.state,
    pushDeliveryBranch: async () => { throw ApplicationFailure.nonRetryable("The reviewed branch is unavailable for pushing", "stale-reviewed-revision", { code: "stale-reviewed-revision", summary: "The reviewed branch is unavailable for pushing" }); },
  });
  h.seedTask("stale-publish");
  const workflowId = h.workflowId("stale-publish");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "stale-publish", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_reviewed"), revision: 5, owner: "lead" as const, allowedCommands: ["publish_draft" as const, "cancel_issue" as const], pendingAction: "Forge opens the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: "forge/issue/stale", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, releaseRepository: "acme/forge", lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("stale-publish", continuationState);
    const state = await h.settle(started.workflowId, (value) => isBlocked(value) && value.step === "delivery_ready");
    expect(state).toMatchObject({ step: "delivery_ready", owner: "human", allowedCommands: expect.arrayContaining(["review_delivery", "cancel_issue"]) });
    expect(state.blocker?.actions.map((action) => action.command)).toEqual(["review_delivery", "cancel_issue"]);
  } finally { await h.stop(); }
});

test("a resumed interrupted publish observes owners then retries publication without a new review", async () => {
  const projected: unknown[] = [];
  const h = await createEngineHarness({
    projectIssueState: async (event) => { projected.push(event.state); return event.state; },
    observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    publishRelease: async (input) => ({ outcome: "completed" as const, repository: "acme/forge", branchName: input.branchName, headSha: engineFixture.commit, headTree: engineFixture.tree, reused: true, attempt: 2, releaseId: "release-interrupted", baseBranch: "main", pullRequestNumber: 127, pullRequestUrl: "https://github.test/acme/forge/pull/127", isDraft: false, targetBaseSha: engineFixture.base }),
  });
  h.seedTask("interrupted-publish");
  const workflowId = h.workflowId("interrupted-publish");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "interrupted-publish", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("releasing"), revision: 5, owner: "lead" as const, allowedCommands: [], pendingAction: "Forge opens the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: "forge/issue/interrupted", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, releaseRepository: "acme/forge", activeOperation: null, releaseRetryAt: null, lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("interrupted-publish", continuationState, { deliveryTarget: "pull_request_ready" });
    const done = await h.settle(started.workflowId, (value) => value.step === "done");
    expect(done).toMatchObject({ pullRequestNumber: 127, releaseId: "release-interrupted" });
    expect(projected).not.toContainEqual(expect.objectContaining({ step: "delivery_ready", pendingAction: "The publish stopped. Review again before you publish." }));
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBe(1);
    expect(h.calls.get("reviewDelivery") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
