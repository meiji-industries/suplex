import { expect, test } from "vitest";

import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { executeIssueCommand, queryIssueWorkflow, signalIssueGithubPullRequestSync, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const head = "a".repeat(40);

test("repeated unchanged PR syncs retain a human CI decision", async () => {
  let observations = 0;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => {
      observations += 1;
      return { exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 1, successful: 0 }, autoMergeEnabled: false, reviewDecision: null };
    },
    reconcileCi: async () => { throw new Error("unchanged human CI state must not reconcile"); },
  });
  h.seedTask("human-ci");
  try {
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId: "workflow-human-ci", companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "human-ci", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      phase: "ci_repair_required" as const,
      revision: 20,
      owner: "human" as const,
      allowedCommands: ["repair_ci" as const, "reconcile_ci" as const, "cancel_issue" as const],
      pendingAction: "Required check failed: Test suite",
      releaseRepository: "acme/forge",
      branchName: "forge/issue/human-ci",
      pullRequestNumber: 42,
      expectedHeadSha: head,
      githubPullRequestObservationKey: `42:open:false:${head}:none:failed`,
      lastEventId: "workflow-human-ci:20",
    };
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "human-ci", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState });

    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    await h.settle(started.workflowId, () => observations === 1);
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    await h.settle(started.workflowId, () => observations === 2);

    expect(await queryIssueWorkflow(h.config, started.workflowId)).toMatchObject({ phase: "ci_repair_required", owner: "human", revision: 21, pendingAction: "Required check failed: Test suite", githubPullRequestMergeable: "MERGEABLE", githubPullRequestChecks: { total: 1, pending: 0, failing: 1, successful: 0 }, expectedHeadSha: head });
  } finally { await h.stop(); }
});

test("CI reconciliation rejects a changed PR head without replacing reviewed identity", async () => {
  const changedHead = "d".repeat(40);
  let observations = 0;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: ++observations === 1 ? head : changedHead, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
    reconcileCi: async () => { throw new Error("changed PR head must not reach CI reconciliation"); },
  });
  h.seedTask("ci-head-drift");
  try {
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId: "workflow-ci-head-drift", companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "ci-head-drift", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      phase: "delivery_blocked" as const,
      revision: 20,
      owner: "human" as const,
      allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const],
      pendingAction: "Retry CI",
      releaseId: "release-a",
      releaseRepository: "acme/forge",
      branchName: "forge/issue/ci-head-drift",
      baseBranch: "main",
      pullRequestNumber: 42,
      expectedHeadSha: head,
      expectedHeadTree: engineFixture.tree,
      resultCommit: head,
      resultTree: engineFixture.tree,
      deliveryReviewId: "review-a",
      processedCommandIds: [`${h.workflowId("ci-head-drift")}:auto-review_delivery:23`],
      lastEventId: "workflow-ci-head-drift:20",
    };
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "ci-head-drift", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState });

    const changed = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: 20, actorUserId: engineFixture.actorUserId });

    expect(changed).toMatchObject({ phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", expectedHeadSha: head, expectedHeadTree: engineFixture.tree, resultCommit: head, resultTree: engineFixture.tree, deliveryReviewId: null, finalReviewId: null, ciRunId: null, ciOutcome: null, acceptanceId: null, blocker: null });
    expect(h.calls.get("reconcileCi") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
