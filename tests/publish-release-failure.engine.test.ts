import { expect, test } from "vitest";

import { ApplicationFailure } from "../src/engine/failures.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { startIssueWorkflow } from "../src/engine/service.js";
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
    phase: "delivery_reviewed" as const, revision: 5, owner: "lead" as const, allowedCommands: ["publish_draft" as const, "cancel_issue" as const], pendingAction: "Opening the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: "forge/issue/stale", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, releaseRepository: "acme/forge", lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "stale-publish", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState });
    const state = await h.settle(started.workflowId, (value) => value.phase === "delivery_blocked");
    expect(state).toMatchObject({ phase: "delivery_blocked", owner: "human", allowedCommands: ["review_delivery", "cancel_issue"], releaseFailureCode: "stale-reviewed-revision", pendingAction: "The reviewed branch is unavailable for pushing" });
  } finally { await h.stop(); }
});

test("a resumed interrupted publish returns to delivery review without pushing", async () => {
  const projected: unknown[] = [];
  const h = await createEngineHarness({
    projectIssueState: async (event) => { projected.push(event.state); return event.state; },
  });
  h.seedTask("interrupted-publish");
  const workflowId = h.workflowId("interrupted-publish");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "interrupted-publish", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    phase: "releasing" as const, revision: 5, owner: "lead" as const, allowedCommands: [], pendingAction: "Opening the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: "forge/issue/interrupted", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, releaseRepository: "acme/forge", activeOperation: null, releaseRetryAt: null, lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "interrupted-publish", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState });
    await h.settle(started.workflowId, (value) => value.phase === "delivery_ready");
    expect(projected).toContainEqual(expect.objectContaining({ phase: "delivery_ready", owner: "lead", allowedCommands: expect.arrayContaining(["review_delivery", "cancel_issue"]), pendingAction: "Publish was interrupted — re-review before publishing" }));
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
