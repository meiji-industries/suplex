import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";

import { ApplicationFailure } from "../src/engine/failures.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { releaseFailureCopy } from "../src/release-failures.js";
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

test("repeated stale publication of the same reviewed commit stops the automatic chain", async () => {
  let publishAttempts = 0;
  const h = await createEngineHarness({
    reviewDelivery: async (input) => ({
      outcome: "completed",
      attemptId: `review-attempt-${publishAttempts}`,
      correctionAttempts: 0,
      subject: input.subject,
      review: {
        reviewId: `review-${publishAttempts}`,
        leadExecutionId: "lead-review",
        leadSessionRef: "lead-session",
        opinionArtifactId: "review-opinion",
        evidenceArtifactId: "review-evidence",
        opinion: "approved",
        summary: "Matches plan",
        repairPlan: null,
        findings: [],
        supersedesReviewId: null,
        reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" },
      },
    }),
    observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: "UNKNOWN", checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    publishRelease: async (input) => {
      publishAttempts += 1;
      return { outcome: "blocked", repository: "acme/forge", branchName: input.branchName, headSha: input.subjectCommit, headTree: input.subjectTree, reused: false, attempt: publishAttempts, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: true, code: "stale-reviewed-revision", summary: "The exact approved Developer revision is unavailable", retryAt: null };
    },
  });
  h.seedTask("stale-auto-chain");
  const workflowId = h.workflowId("stale-auto-chain");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "stale-auto-chain", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_ready"), revision: 5, owner: "lead" as const, allowedCommands: ["review_delivery" as const, "cancel_issue" as const], pendingAction: "The Planner reviews the latest changes", developerExecutionId: "developer", developerSessionRef: "developer-session", branchName: "forge/issue/stale-auto-chain", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "developer-evidence", releaseRepository: "acme/forge", lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("stale-auto-chain", continuationState);
    const state = await h.settle(started.workflowId, (value) => isBlocked(value) && value.owner === "human");
    expect(state).toMatchObject({ step: "delivery_ready", pendingAction: releaseFailureCopy["stale-reviewed-revision"], allowedCommands: expect.arrayContaining(["review_delivery", "publish_draft", "cancel_issue"]), blocker: expect.objectContaining({ category: "agent_exhausted" }) });
    expect(state.blocker?.actions.map((action) => action.command)).toEqual(["review_delivery", "publish_draft", "cancel_issue"]);
    expect(publishAttempts).toBeLessThanOrEqual(3);
    const calls = { publish: h.calls.get("publishRelease") ?? 0, push: h.calls.get("pushDeliveryBranch") ?? 0 };
    await Promise.resolve();
    expect({ publish: h.calls.get("publishRelease") ?? 0, push: h.calls.get("pushDeliveryBranch") ?? 0 }).toEqual(calls);
  } finally { await h.stop(); }
});

test("blocked branch pushes stop before a release records its repository", async () => {
  let reviewAttempts = 0;
  const h = await createEngineHarness({
    reviewDelivery: async (input) => ({
      outcome: "completed",
      attemptId: `review-attempt-${reviewAttempts++}`,
      correctionAttempts: 0,
      subject: input.subject,
      review: {
        reviewId: `review-${reviewAttempts}`,
        leadExecutionId: "lead-review",
        leadSessionRef: "lead-session",
        opinionArtifactId: "review-opinion",
        evidenceArtifactId: "review-evidence",
        opinion: "approved",
        summary: "Matches plan",
        repairPlan: null,
        findings: [],
        supersedesReviewId: null,
        reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" },
      },
    }),
    observeGithubPullRequest: async () => ({ exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: "UNKNOWN", checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    pushDeliveryBranch: async () => { throw ApplicationFailure.nonRetryable("GitHub CLI authentication is unavailable", "authentication-required", { code: "authentication-required", summary: "GitHub CLI authentication is unavailable" }); },
  });
  h.seedTask("blocked-push-auto-chain");
  const workflowId = h.workflowId("blocked-push-auto-chain");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "blocked-push-auto-chain", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_ready"), revision: 5, owner: "lead" as const, allowedCommands: ["review_delivery" as const, "cancel_issue" as const], pendingAction: "The Planner reviews the latest changes", developerExecutionId: "developer", developerSessionRef: "developer-session", branchName: "forge/issue/blocked-push-auto-chain", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "developer-evidence", releaseRepository: null, lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("blocked-push-auto-chain", continuationState, { repository: "acme/forge" });
    const state = await h.settle(started.workflowId, (value) => isBlocked(value) && value.owner === "human");
    expect(state).toMatchObject({ step: "delivery_ready", owner: "human", pendingAction: releaseFailureCopy["authentication-required"], blocker: expect.objectContaining({ category: "agent_exhausted" }) });
    expect(h.calls.get("publishRelease") ?? 0).toBe(0);
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBeLessThanOrEqual(3);
  } finally { await h.stop(); }
});

test("repeated GitHub observation failures stop the automatic publish chain", async () => {
  let reviewAttempts = 0;
  const h = await createEngineHarness({
    reviewDelivery: async (input) => ({
      outcome: "completed",
      attemptId: `review-attempt-${reviewAttempts++}`,
      correctionAttempts: 0,
      subject: input.subject,
      review: {
        reviewId: `review-${reviewAttempts}`,
        leadExecutionId: "lead-review",
        leadSessionRef: "lead-session",
        opinionArtifactId: "review-opinion",
        evidenceArtifactId: "review-evidence",
        opinion: "approved",
        summary: "Matches plan",
        repairPlan: null,
        findings: [],
        supersedesReviewId: null,
        reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" },
      },
    }),
    observeGithubPullRequest: async () => { throw new Error("GitHub did not respond"); },
    pushDeliveryBranch: async () => { throw ApplicationFailure.nonRetryable("GitHub CLI authentication is unavailable", "authentication-required", { code: "authentication-required", summary: "GitHub CLI authentication is unavailable" }); },
  });
  h.seedTask("blocked-observation-auto-chain");
  const workflowId = h.workflowId("blocked-observation-auto-chain");
  const continuationState = {
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "blocked-observation-auto-chain", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_ready"), revision: 5, owner: "lead" as const, allowedCommands: ["review_delivery" as const, "cancel_issue" as const], pendingAction: "The Planner reviews the latest changes", developerExecutionId: "developer", developerSessionRef: "developer-session", branchName: "forge/issue/blocked-observation-auto-chain", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "delivery", developerEvidenceArtifactId: "developer-evidence", releaseRepository: null, lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("blocked-observation-auto-chain", continuationState, { repository: "acme/forge" });
    const state = await h.settle(started.workflowId, (value) => isBlocked(value) && value.owner === "human" && value.pendingAction === "GitHub did not respond. Retry when ready.");
    expect(state).toMatchObject({ step: "delivery_ready", owner: "human", pendingAction: "GitHub did not respond. Retry when ready.", blocker: expect.objectContaining({ category: "agent_exhausted" }) });
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBeLessThanOrEqual(3);
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
    ...at("releasing"), revision: 5, owner: "lead" as const, allowedCommands: [], pendingAction: "Forge opens the pull request", deliveryReviewId: "review", developerExecutionId: "developer", branchName: "forge/issue/interrupted", targetBaseSha: engineFixture.base, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, releaseRepository: "acme/forge", activeOperation: null, releaseRetryAt: null, lastEventId: `${workflowId}:5`,
  };
  try {
    const started = await h.startContinuation("interrupted-publish", continuationState);
    await h.settle(started.workflowId, (value) => value.step === "delivery_ready");
    expect(projected).toContainEqual(expect.objectContaining({ step: "delivery_ready", owner: "lead", allowedCommands: expect.arrayContaining(["review_delivery", "cancel_issue"]), pendingAction: "The publish stopped. Review again before you publish." }));
    expect(h.calls.get("pushDeliveryBranch") ?? 0).toBe(0);
  } finally { await h.stop(); }
});
