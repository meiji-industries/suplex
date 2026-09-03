import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";

import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { ApplicationFailure } from "../src/engine/failures.js";
import { executeIssueCommand, queryIssueWorkflow, signalIssueGithubPullRequestSync } from "../src/engine/service.js";
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
      ...at("ci_waiting"),
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
    const started = await h.startContinuation("human-ci", continuationState);

    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    await h.settle(started.workflowId, () => observations === 1);
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    await h.settle(started.workflowId, () => observations === 2);

    expect(await queryIssueWorkflow(h.config, started.workflowId)).toMatchObject({ step: "ci_waiting", owner: "human", revision: 22, pendingAction: "Required check failed: Test suite", githubPullRequestMergeable: "MERGEABLE", githubPullRequestChecks: { total: 1, pending: 0, failing: 1, successful: 0 }, expectedHeadSha: head });
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
      ...at("ci_waiting"),
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
    const started = await h.startContinuation("ci-head-drift", continuationState);

    const changed = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });

    expect(changed).toMatchObject({ step: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", expectedHeadSha: head, expectedHeadTree: engineFixture.tree, resultCommit: head, resultTree: engineFixture.tree, deliveryReviewId: null, finalReviewId: null, ciRunId: null, ciOutcome: null, acceptanceId: null, blocker: null });
    expect(h.calls.get("reconcileCi") ?? 0).toBe(0);
  } finally { await h.stop(); }
});

test.each([
  ["head", "d".repeat(40), engineFixture.base],
  ["base", head, "d".repeat(40)],
] as const)("missing-release CI recovery rejects observed %s drift without replacing reviewed identity", async (coordinate, observedHeadSha, observedBaseSha) => {
  const issueId = `ci-missing-release-${coordinate}-drift`;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: observedHeadSha, baseSha: observedBaseSha, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
    adoptPullRequestRelease: async () => { throw new Error(`changed PR ${coordinate} must not be adopted`); },
    reconcileCi: async () => { throw new Error(`changed PR ${coordinate} must not reach CI reconciliation`); },
  });
  h.seedTask(issueId);
  try {
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId: `workflow-${issueId}`, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      ...at("ci_waiting"),
      revision: 20,
      owner: "human" as const,
      allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const],
      pendingAction: "Retry CI",
      releaseRepository: "acme/forge",
      branchName: `forge/issue/${issueId}`,
      baseBranch: "main",
      pullRequestNumber: 42,
      expectedHeadSha: head,
      expectedHeadTree: engineFixture.tree,
      targetBaseSha: engineFixture.base,
      resultCommit: head,
      resultTree: engineFixture.tree,
      deliveryReviewId: "review-a",
      processedCommandIds: [`${h.workflowId(issueId)}:auto-review_delivery:23`],
      lastEventId: `workflow-${issueId}:20`,
    };
    const started = await h.startContinuation(issueId, continuationState);

    const changed = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });

    expect(changed).toMatchObject({ step: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", expectedHeadSha: head, expectedHeadTree: engineFixture.tree, targetBaseSha: engineFixture.base, resultCommit: head, resultTree: engineFixture.tree, deliveryReviewId: null, finalReviewId: null, ciRunId: null, ciOutcome: null, acceptanceId: null, blocker: null });
    expect(h.calls.get("adoptPullRequestRelease") ?? 0).toBe(0);
    expect(h.calls.get("reconcileCi") ?? 0).toBe(0);
  } finally { await h.stop(); }
});

test("missing-release CI recovery forwards pinned base and preserves reviewed identity when adoption rejects drift", async () => {
  const issueId = "ci-missing-release-authoritative-base-drift";
  const branchName = `forge/issue/${issueId}`;
  let adoptionInput: { expectedBaseSha?: string } | undefined;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
    adoptPullRequestRelease: async (input) => {
      adoptionInput = input;
      throw ApplicationFailure.nonRetryable("The pull request no longer matches the observed CI identity", "stale-reviewed-revision");
    },
    reconcileCi: async () => { throw new Error("failed adoption must not reach CI reconciliation"); },
  });
  h.seedTask(issueId);
  try {
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId: `workflow-${issueId}`, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      ...at("ci_waiting"),
      revision: 20,
      owner: "human" as const,
      allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const],
      pendingAction: "Retry CI",
      releaseRepository: "acme/forge",
      branchName,
      baseBranch: "main",
      pullRequestNumber: 42,
      expectedHeadSha: head,
      expectedHeadTree: engineFixture.tree,
      targetBaseSha: engineFixture.base,
      resultCommit: head,
      resultTree: engineFixture.tree,
      deliveryReviewId: "review-a",
      processedCommandIds: [`${h.workflowId(issueId)}:auto-review_delivery:23`],
      lastEventId: `workflow-${issueId}:20`,
    };
    const started = await h.startContinuation(issueId, continuationState);

    const failed = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });

    expect(adoptionInput).toMatchObject({ expectedBaseSha: engineFixture.base });
    expect(failed).toMatchObject({ expectedHeadSha: head, expectedHeadTree: engineFixture.tree, targetBaseSha: engineFixture.base, resultCommit: head, resultTree: engineFixture.tree, deliveryReviewId: "review-a", lastHandlerError: { command: "reconcile_ci", reason: "Activity adoptPullRequestRelease failed" } });
    expect(failed).not.toHaveProperty("releaseId");
    expect(h.calls.get("adoptPullRequestRelease")).toBe(1);
    expect(h.calls.get("reconcileCi") ?? 0).toBe(0);
  } finally { await h.stop(); }
});

test("missing-release CI recovery adopts an unpinned legacy pull request identity", async () => {
  const issueId = "ci-missing-release-legacy";
  const branchName = `forge/issue/${issueId}`;
  let adoptionInput: { expectedBaseSha?: string } | undefined;
  const h = await createEngineHarness({
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: "open" as const, isDraft: false, headSha: head, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    adoptPullRequestRelease: async (input) => {
      adoptionInput = input;
      return { releaseId: "release-adopted", repository: "acme/forge", branchName, baseBranch: "main", targetBaseSha: engineFixture.base, headSha: head, headTree: engineFixture.tree, pullRequestNumber: 42, pullRequestUrl: "https://github.test/42" };
    },
    reconcileCi: async (input) => ({ runId: "ci-run", attemptId: "ci-attempt", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: null, outcome: "waiting", reason: "checks_pending", owner: "system", repairable: false, summary: "Forge waits for CI", retryAt: "2026-08-29T00:01:00.000Z", nextPollAt: "2026-08-29T00:01:00.000Z", propagationDeadline: null, overallDeadline: null }),
  });
  h.seedTask(issueId);
  try {
    const continuationState = {
      ...buildInitialIssueWorkflowState({ workflowId: `workflow-${issueId}`, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
      ...at("ci_waiting"),
      revision: 20,
      owner: "human" as const,
      allowedCommands: ["reconcile_ci" as const, "cancel_issue" as const],
      pendingAction: "Retry CI",
      releaseRepository: "acme/forge",
      branchName,
      baseBranch: "main",
      pullRequestNumber: 42,
      processedCommandIds: [`${h.workflowId(issueId)}:auto-review_delivery:23`],
      lastEventId: `workflow-${issueId}:20`,
    };
    const started = await h.startContinuation(issueId, continuationState);

    const adopted = await executeIssueCommand(h.config, started.workflowId, "reconcile_ci", { expectedRevision: (await queryIssueWorkflow(h.config, started.workflowId)).revision, actorUserId: engineFixture.actorUserId });

    expect(adopted).toMatchObject({ releaseId: "release-adopted", expectedHeadSha: head, expectedHeadTree: engineFixture.tree, targetBaseSha: engineFixture.base, resultCommit: head, resultTree: engineFixture.tree });
    expect(h.calls.get("adoptPullRequestRelease")).toBe(1);
    expect(h.calls.get("reconcileCi")).toBe(1);
    expect(adoptionInput).not.toHaveProperty("expectedBaseSha");
  } finally { await h.stop(); }
});
