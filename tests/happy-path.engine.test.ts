import { expect, test } from "vitest";

import type { IssueActivities } from "../src/engine/issue-contracts.js";
import { executeIssueCommand, queryIssueWorkflow, signalIssueGithubPullRequestSync, startIssueWorkflow } from "../src/engine/service.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

const observedCommit = "e".repeat(40), observedTree = "f".repeat(40);

test("plan, build, review, publish, CI, merge reaches done", async () => {
  let merged = false, reviewed = false; const projections: string[] = [];
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(event.state.step); return event.state; },
    recordPlanDecision: async () => ({ decisionId: "auto-approved-plan" }),
    runLeadPlanning: async () => ({ leadExecutionId: "lead-plan", leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact", leadEvidenceArtifactId: "plan-evidence", leadOutputArtifactSha256: engineFixture.sha256, leadOutputKind: "plan", leadSummary: "A safe plan", planSubject: { planRevision: 1, artifactId: "plan-artifact", leadSessionRef: "lead-session" } }),
    runDeveloperExecutionSupervised: async (input) => ({ status: "completed", resultHash: engineFixture.sha256, result: { developerExecutionId: input.developerTurnExecutionId, developerSessionRef: "developer-session", branchName: "forge/issue/happy", targetBaseSha: engineFixture.base, currentStep: null, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, dirtyState: "clean", deliveryArtifactId: "delivery", evidenceArtifactId: "developer-evidence", deliverySummary: "Implemented", outcome: "completed" } }),
    reviewDelivery: async (input) => ({ outcome: "completed", attemptId: "review-attempt", correctionAttempts: 0, subject: { ...input.subject, subjectCommit: observedCommit, subjectTree: observedTree }, review: { reviewId: "review", leadExecutionId: "lead-review", leadSessionRef: "lead-session", opinionArtifactId: "review-opinion", evidenceArtifactId: "review-evidence", opinion: "approved", summary: "Matches plan", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" } } }),
    reconcileTargetBase: async (input) => ({ outcome: "no_drift", checkId: `base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }),
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    publishRelease: async () => ({ outcome: "completed", repository: "acme/forge", branchName: "forge/issue/happy", headSha: observedCommit, headTree: observedTree, reused: false, attempt: 0, releaseId: "release", baseBranch: "main", pullRequestNumber: 42, pullRequestUrl: "https://github.test/42", isDraft: false, targetBaseSha: engineFixture.base }),
    reconcileCi: async (input) => ({ runId: "ci", attemptId: "ci-attempt", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci-evidence", outcome: "passed", reason: "checks_passed", owner: null, repairable: false, summary: "Passed", retryAt: null, nextPollAt: null, policyHash: engineFixture.sha256, propagationDeadline: null, overallDeadline: null }),
    updateCiFromBase: async () => ({ outcome: "no_drift", summary: "Current" }),
    finalReview: async (input) => { reviewed = true; return { finalReviewId: "final", leadExecutionId: "lead-final", leadSessionRef: input.leadSessionRef, opinionArtifactId: "final-opinion", evidenceArtifactId: "final-evidence", evidenceArtifactSha256: engineFixture.sha256, reviewArtifact: { artifactId: "final-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" }, outcome: "approved", summary: "Approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }; },
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.test/42", state: merged ? "merged" : "open", isDraft: false, headSha: observedCommit, baseSha: engineFixture.base, mergeable: "MERGEABLE", checks: reviewed ? { total: 1, pending: 0, failing: 0, successful: 1 } : { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    applyGithubPullRequestAction: async () => { merged = true; },
  };
  const h = await createEngineHarness(activities); h.seedTask("happy", { autoApprovePlan: true, pullRequestMode: "auto_merge", deliveryTarget: "merged" });
  try {
    const started = await startIssueWorkflow(h.config, { companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId: "happy", projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, autoApprovePlan: true, autoApprovePlanActorUserId: engineFixture.actorUserId, pullRequestMode: "auto_merge", deliveryTarget: "merged", autoMergeActorUserId: engineFixture.actorUserId });
    await executeIssueCommand(h.config, started.workflowId, "start_planning", { expectedRevision: 0, actorUserId: engineFixture.actorUserId });
    await h.settle(started.workflowId, (state) => state.step === "manual_merge" && merged);
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    await h.settle(started.workflowId, (state) => state.step === "manual_merge" && merged);
    await signalIssueGithubPullRequestSync(h.config, started.workflowId);
    const done = await h.settle(started.workflowId, (state) => state.step === "done");
    expect(done).toMatchObject({ step: "done", pendingAction: "Merged", githubPullRequestState: "merged" });
    expect(projections).toEqual(expect.arrayContaining(["planning", "development", "delivery_ready", "reviewing_delivery", "releasing", "ci_waiting", "final_review", "manual_merge", "done"]));
    expect((await queryIssueWorkflow(h.config, started.workflowId)).revision).toBe(done.revision);
  } finally { await h.stop(); }
});
