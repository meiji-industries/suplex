import { expect, test } from "vitest";

import { at, isBlocked } from "../src/issue-phases.js";

import { ApplicationFailure } from "../src/engine/failures.js";
import { humanBlocker } from "../src/engine/workflow/state-transitions.js";
import {
  buildInitialIssueWorkflowState,
  IssueWorkflowStateSchema,
  type IssueActivities,
  type IssueWorkflowInput,
  type IssueWorkflowState,
  type RecoverRevalidatedDeliveryReviewResult,
} from "../src/engine/issue-contracts.js";
import { executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture, type EngineHarness } from "./helpers/engine-harness.js";

const reviewedBase = "d".repeat(40);
const reviewedHead = "e".repeat(40);
const reviewedTree = "f".repeat(40);
const staleBase = "1".repeat(40);
const staleHead = "2".repeat(40);
const priorTree = "3".repeat(40);

function workflowInput(issueId: string, continuationState: IssueWorkflowState, deliveryTarget: "local_worktree" | "remote_branch" | "pull_request_draft" = "pull_request_draft"): Omit<IssueWorkflowInput, "workflowId"> {
  return {
    companyId: engineFixture.companyId,
    projectId: engineFixture.projectId,
    issueId,
    projectRevisionId: engineFixture.projectRevisionId,
    briefArtifactId: engineFixture.briefArtifactId,
    briefSha256: engineFixture.sha256,
    imageArtifactIds: [],
    roleProfiles: engineFixture.roleProfiles,
    supplementalReview: false,
    deliveryTarget,
    continuationState,
  };
}

function persistContinuation(harness: EngineHarness, issueId: string, continuation: IssueWorkflowState): void {
  const workflowId = harness.workflowId(issueId);
  const initial = IssueWorkflowStateSchema.parse(buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }));
  for (let revision = 0; revision <= continuation.revision; revision += 1) {
    const state = revision === continuation.revision
      ? continuation
      : IssueWorkflowStateSchema.parse({ ...initial, ...at(revision === 0 ? "backlog" : "planning"), revision, owner: revision === 0 ? "human" : "lead", allowedCommands: revision === 0 ? ["start_planning"] : [], pendingAction: revision === 0 ? "Start planning" : "The Planner writes the plan", lastEventId: `${workflowId}:${revision}` });
    harness.database.projectIssueEvent({ schemaVersion: 1, runId: `seed-${issueId}`, eventId: state.lastEventId, state });
  }
}

function reviewedState(harness: EngineHarness, issueId: string, overrides: Partial<IssueWorkflowState> = {}): IssueWorkflowState {
  const workflowId = harness.workflowId(issueId);
  return IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: engineFixture.sha256, roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }),
    ...at("delivery_reviewed"),
    revision: 12,
    owner: "human",
    allowedCommands: ["publish_draft", "cancel_issue"],
    pendingAction: "Forge opens the pull request",
    lastEventId: `${workflowId}:12`,
    planRevision: 3,
    leadSessionRef: "lead-session",
    leadOutputArtifactId: "lead-output",
    developerExecutionId: "developer-reviewed",
    developerSessionRef: "developer-session",
    branchName: `forge/${issueId}`,
    worktreePath: `/worktrees/${issueId}`,
    targetBaseSha: reviewedBase,
    resultCommit: reviewedHead,
    resultTree: reviewedTree,
    dirtyState: "clean",
    deliveryArtifactId: "delivery-artifact",
    developerEvidenceArtifactId: "developer-evidence",
    deliveryReviewId: "review-approved",
    deliveryReviewAttemptId: "review-attempt-approved",
    deliveryReviewOutcome: "approved",
    deliveryReviewSummary: "Approved reviewed delivery",
    releaseId: "release-existing",
    releaseRepository: "acme/forge",
    baseBranch: "main",
    pullRequestNumber: 102,
    pullRequestUrl: "https://github.test/acme/forge/pull/102",
    expectedHeadSha: reviewedHead,
    expectedHeadTree: reviewedTree,
    ...overrides,
  });
}

function corruptState(harness: EngineHarness, issueId: string): IssueWorkflowState {
  const workflowId = harness.workflowId(issueId);
  return reviewedState(harness, issueId, {
    ...at("delivery_ready"),
    revision: 126,
    owner: "human",
    allowedCommands: ["review_delivery", "cancel_issue"],
    pendingAction: "The provider failure continued after the automatic retries.",
    lastEventId: `${workflowId}:126`,
    targetBaseSha: staleBase,
    resultCommit: staleHead,
    resultTree: null,
    expectedHeadSha: staleHead,
    expectedHeadTree: null,
    deliveryReviewId: null,
    deliveryReviewAttemptId: null,
    deliveryReviewOutcome: null,
    deliveryReviewSummary: null,
    deliveryReviewBlockerCode: "review-infrastructure-failure",
    deliveryReviewBlockerSummary: "The review infrastructure did not complete.",
    blocker: humanBlocker("provider_connectivity_exhausted", "The review infrastructure did not complete.", [{ command: "review_delivery", label: "Retry the delivery review", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], undefined),
    targetBaseOutcome: "revalidated",
    targetBaseCheckId: "merge-reviewed",
    targetBaseCheckpoint: "pre_release",
    forwardMergeId: "merge-reviewed",
    forwardMergePriorHead: staleHead,
    forwardMergePriorTree: priorTree,
    forwardMergeTargetBaseSha: reviewedBase,
    mergeResolutionDeveloperExecutionId: "developer-reviewed",
  });
}

function recoveredReview(): Extract<RecoverRevalidatedDeliveryReviewResult, { outcome: "recovered" }> {
  return {
    outcome: "recovered",
    forwardMergeId: "merge-reviewed",
    checkpoint: "ci_update_from_base",
    developerExecutionId: "developer-reviewed",
    targetBaseSha: reviewedBase,
    subjectCommit: reviewedHead,
    subjectTree: reviewedTree,
    review: {
      outcome: "completed",
      attemptId: "review-attempt-approved",
      correctionAttempts: 0,
      subject: {
        planRevision: 3,
        targetBaseSha: reviewedBase,
        subjectCommit: reviewedHead,
        subjectTree: reviewedTree,
        developerExecutionId: "developer-reviewed",
        deliveryArtifactId: "delivery-artifact",
        developerEvidenceArtifactId: "developer-evidence",
        leadSessionRef: "lead-session",
        developerSessionRef: "developer-session",
      },
      review: {
        reviewId: "review-approved",
        leadExecutionId: "lead-review",
        leadSessionRef: "review-session",
        opinionArtifactId: "review-opinion",
        evidenceArtifactId: "review-evidence",
        opinion: "approved",
        summary: "Approved reviewed delivery",
        findings: [],
        supersedesReviewId: null,
        reviewArtifact: { artifactId: "review-opinion", companyId: engineFixture.companyId, kind: "delivery-review", byteSize: 1, mimeType: "text/markdown" },
      },
    },
  };
}

function staleObservation() {
  return { exists: true, number: 102, url: "https://github.test/acme/forge/pull/102", state: "open" as const, isDraft: true, headSha: staleHead, baseSha: staleBase, mergeable: "CONFLICTING", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null };
}

function completedRelease(branchName: string) {
  return { outcome: "completed" as const, repository: "acme/forge", branchName, headSha: reviewedHead, headTree: reviewedTree, reused: true, attempt: 1, releaseId: "release-existing", baseBranch: "main", pullRequestNumber: 102, pullRequestUrl: "https://github.test/acme/forge/pull/102", isDraft: true, targetBaseSha: reviewedBase };
}

test("pushes the reviewed head before publication and keeps stale provider content out of state", async () => {
  const order: string[] = [];
  const projections: IssueWorkflowState[] = [];
  const issueId = "reviewed-head-order";
  const harness = await createEngineHarness({
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    pushDeliveryBranch: async (input) => { order.push("push"); expect(input.commitSha).toBe(reviewedHead); return { repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }; },
    publishRelease: async (input) => { order.push("publish"); expect(input).toMatchObject({ reviewId: "review-approved", targetBaseSha: reviewedBase, subjectCommit: reviewedHead, subjectTree: reviewedTree }); return completedRelease(input.branchName); },
    observeGithubPullRequest: async () => { order.push("observe"); return staleObservation(); },
  });
  harness.seedTask(issueId, { deliveryTarget: "pull_request_draft" });
  const continuation = reviewedState(harness, issueId);
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation));
    const done = await harness.settle(started.workflowId, (state) => state.step === "done");
    expect(order).toEqual(["push", "publish", "observe"]);
    expect(done).toMatchObject({ targetBaseSha: reviewedBase, resultCommit: reviewedHead, resultTree: reviewedTree, expectedHeadSha: reviewedHead, expectedHeadTree: reviewedTree, deliveryReviewId: "review-approved", deliveryReviewOutcome: "approved" });
    expect(projections.some((state) => state.resultCommit === staleHead || state.targetBaseSha === staleBase || state.resultTree === null || state.deliveryReviewId === null)).toBe(false);
  } finally { await harness.stop(); }
});

test("ordinary review action restores the approved subject once, then publishes it", async () => {
  const order: string[] = [];
  let recoveryCalls = 0;
  let agentReviewCalls = 0;
  const issueId = "recover-reviewed-head";
  const activities: Partial<IssueActivities> = {
    recoverRevalidatedDeliveryReview: async () => { recoveryCalls += 1; order.push("recover"); return recoveredReview(); },
    reviewDelivery: async () => { agentReviewCalls += 1; throw new Error("A new Lead review must not run"); },
    pushDeliveryBranch: async (input) => { order.push("push"); return { repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }; },
    publishRelease: async (input) => { order.push("publish"); return completedRelease(input.branchName); },
    observeGithubPullRequest: async () => { order.push("observe"); return staleObservation(); },
  };
  const harness = await createEngineHarness(activities);
  harness.seedTask(issueId, { deliveryTarget: "pull_request_draft" });
  const continuation = corruptState(harness, issueId);
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const active = await queryIssueWorkflow(harness.config, started.workflowId);
    expect(active.revision).toBe(continuation.revision + 1);
    const reviewed = await executeIssueCommand(harness.config, started.workflowId, "review_delivery", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId });
    expect(reviewed).toMatchObject({ step: "delivery_reviewed", deliveryReviewId: "review-approved" });
    expect(order).toEqual(["recover"]);
    expect(recoveryCalls).toBe(1);
    expect(agentReviewCalls).toBe(0);
    expect(reviewed).toMatchObject({ targetBaseSha: reviewedBase, resultCommit: reviewedHead, resultTree: reviewedTree, expectedHeadSha: reviewedHead, expectedHeadTree: reviewedTree, deliveryReviewId: "review-approved", deliveryReviewOutcome: "approved" });

    const counts = { recoveryCalls, push: harness.calls.get("pushDeliveryBranch") ?? 0, publish: harness.calls.get("publishRelease") ?? 0 };
    await expect(executeIssueCommand(harness.config, started.workflowId, "review_delivery", { expectedRevision: continuation.revision, actorUserId: engineFixture.actorUserId })).rejects.toThrow();
    expect({ recoveryCalls, push: harness.calls.get("pushDeliveryBranch") ?? 0, publish: harness.calls.get("publishRelease") ?? 0 }).toEqual(counts);
  } finally { await harness.stop(); }
});

test("a recovery mismatch remains blocked without an agent or provider effect", async () => {
  let agentReviewCalls = 0;
  const issueId = "blocked-reviewed-recovery";
  const harness = await createEngineHarness({
    recoverRevalidatedDeliveryReview: async () => ({ outcome: "blocked", code: "subject-changed", summary: "The approved delivery history no longer matches this task. Restore the task records, then retry the review." }),
    reviewDelivery: async () => { agentReviewCalls += 1; throw new Error("Unexpected Lead review"); },
  });
  harness.seedTask(issueId, { deliveryTarget: "pull_request_draft" });
  const continuation = corruptState(harness, issueId);
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const active = await queryIssueWorkflow(harness.config, started.workflowId);
    expect(active.revision).toBe(continuation.revision + 1);
    const blocked = await executeIssueCommand(harness.config, started.workflowId, "review_delivery", { expectedRevision: active.revision, actorUserId: engineFixture.actorUserId });
    expect(blocked).toMatchObject({ step: "delivery_ready", allowedCommands: expect.arrayContaining(["review_delivery", "cancel_issue"]), deliveryReviewBlockerCode: "subject-changed", targetBaseSha: staleBase, resultCommit: staleHead, resultTree: null, deliveryReviewId: null });
    expect(agentReviewCalls).toBe(0);
    expect(harness.calls.get("pushDeliveryBranch") ?? 0).toBe(0);
    expect(harness.calls.get("publishRelease") ?? 0).toBe(0);
  } finally { await harness.stop(); }
});

test("a complete delivery uses the normal review path and bypasses recovery", async () => {
  let recoveryCalls = 0;
  let reviewCalls = 0;
  const issueId = "normal-review-bypass";
  const harness = await createEngineHarness({
    recoverRevalidatedDeliveryReview: async () => { recoveryCalls += 1; return recoveredReview(); },
    reviewDelivery: async (input) => { reviewCalls += 1; return { ...recoveredReview().review, subject: input.subject }; },
    readHerdrTurn: async () => ({ type: "owner.done", outcome: "approved" }),
  });
  harness.seedTask(issueId, { deliveryTarget: "local_worktree" });
  const continuation = reviewedState(harness, issueId, { ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], deliveryReviewId: null, deliveryReviewAttemptId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, releaseId: null, pullRequestNumber: null, pullRequestUrl: null });
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation, "local_worktree"));
    const done = await harness.settle(started.workflowId, (state) => state.step === "done");
    expect(done).toMatchObject({ step: "done", resultCommit: reviewedHead, resultTree: reviewedTree, deliveryReviewId: "review-approved" });
    expect(recoveryCalls).toBe(0);
    expect(reviewCalls).toBe(1);
  } finally { await harness.stop(); }
});

test("a foreign remote head fails closed without publication, observation, or adoption", async () => {
  let publishCalls = 0;
  const issueId = "foreign-reviewed-head";
  const harness = await createEngineHarness({
    pushDeliveryBranch: async () => { throw ApplicationFailure.nonRetryable("The remote task branch points to another commit.", "remote-head-conflict", { code: "remote-head-conflict", summary: "The remote task branch points to another commit." }); },
    publishRelease: async (input) => { publishCalls += 1; return completedRelease(input.branchName); },
  });
  harness.seedTask(issueId, { deliveryTarget: "pull_request_draft" });
  const continuation = reviewedState(harness, issueId);
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation));
    const blocked = await harness.settle(started.workflowId, (state) => isBlocked(state) && state.step === "delivery_ready");
    expect(blocked).toMatchObject({ targetBaseSha: reviewedBase, resultCommit: reviewedHead, resultTree: reviewedTree, deliveryReviewId: "review-approved", deliveryReviewOutcome: "approved" });
    expect(harness.calls.get("pushDeliveryBranch")).toBe(1);
    expect(blocked.blocker?.actions.map((action) => action.command)).toEqual(["review_delivery", "cancel_issue"]);
    expect(publishCalls).toBe(0);
  } finally { await harness.stop(); }
});

test.each([
  ["remote_branch", true],
  ["local_worktree", false],
] as const)("delivery_reviewed restart resumes %s without creating a pull request", async (deliveryTarget, pushes) => {
  let publishCalls = 0;
  const issueId = `reviewed-resume-${deliveryTarget}`;
  const harness = await createEngineHarness({
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    publishRelease: async (input) => { publishCalls += 1; return completedRelease(input.branchName); },
  });
  harness.seedTask(issueId, { deliveryTarget });
  const continuation = reviewedState(harness, issueId, { releaseId: null, pullRequestNumber: null, pullRequestUrl: null });
  try {
    persistContinuation(harness, issueId, continuation);
    const started = await startIssueWorkflow(harness.config, workflowInput(issueId, continuation, deliveryTarget));
    const done = await harness.settle(started.workflowId, (state) => state.step === "done");
    expect(done.pendingAction).toBe(pushes ? "Done. Branch pushed." : "Done. Kept in the worktree.");
    expect(publishCalls).toBe(0);
    expect(harness.calls.get("pushDeliveryBranch") ?? 0).toBe(pushes ? 1 : 0);
  } finally { await harness.stop(); }
});
