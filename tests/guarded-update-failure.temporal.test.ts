import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { PlanBlockerSubject, PlanSubject } from "../src/plan-governance.js";
import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { acceptDeliveryUpdate, issueStateQuery, issueWorkflow, rejectPlanUpdate, respondPlanBlockerUpdate } from "../src/temporal/workflows.js";
import { createIssueActivitiesFake } from "./fakes/issue-activities.js";
import { createImmediateCapacityActivities } from "./immediate-capacity-activities.js";

const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));
const sha = "a".repeat(64);
const companyId = "company_guarded";
const issueId = "issue_guarded";
const workflowId = "workflow_guarded";
const taskQueue = "guarded-update-failure";

let environment: TestWorkflowEnvironment | undefined;

afterEach(async () => {
  await environment?.teardown();
  environment = undefined;
});

const blockerSubject: PlanBlockerSubject = {
  companyId,
  issueId,
  workflowId,
  artifactId: "blocker_artifact",
  artifactSha256: sha,
  leadSessionRef: "lead_session",
  leadExecutionId: "lead_execution",
  evidenceManifestArtifactId: "blocker_manifest",
  evidenceManifestSha256: sha,
  category: "human_decision",
  resumePhase: "planning",
};

const planSubject: PlanSubject = {
  companyId,
  issueId,
  workflowId,
  originalPlanRevision: 11,
  outputId: "plan_output",
  outputRevision: 11,
  finalVersion: 1,
  artifactId: "plan_artifact",
  artifactSha256: sha,
  leadSessionRef: "lead_session",
  leadExecutionId: "lead_execution_2",
  evidenceManifestArtifactId: "plan_manifest",
  evidenceManifestSha256: sha,
};


test("a task created with auto-approve and auto-merge reaches done without another human click", { timeout: 180_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  const capacity = createImmediateCapacityActivities();
  const commit = "b".repeat(40);
  let reviewed = false;
  let merged = false;
  const activities: Partial<IssueActivities> = {
    ...capacity.activities,
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    recordPlanBlockerResponse: async () => ({ responseId: "blocker_response", subjectHash: sha, answerArtifactId: "answer_artifact", answerArtifactSha256: sha }),
    runLeadPlanning: async () => ({
      leadSessionRef: "lead_session",
      leadExecutionId: "lead_execution_2",
      leadEvidenceArtifactId: "lead_evidence",
      leadOutputArtifactId: "plan_artifact",
      leadOutputArtifactSha256: sha,
      leadOutputKind: "plan",
      leadSummary: "Plan after the blocker answer",
      materialCategories: ["security_permissions"],
      material: true,
      planSubject,
      materialityEvidence: { categories: ["security_permissions"], artifactId: "materiality_artifact", artifactSha256: sha },
    }),
    recordPlanDecision: async () => ({ decisionId: "decision_auto", subjectHash: sha }),
    runDeveloperExecutionSupervised: async () => ({
      status: "completed",
      resultHash: sha,
      result: { developerExecutionId: "developer_execution_auto", developerSessionRef: "developer_session", branchName: "forge/issue/auto", targetBaseSha: commit, currentStep: null, resultCommit: commit, resultTree: commit, dirtyState: "clean", deliveryArtifactId: "delivery_artifact", evidenceArtifactId: "developer_evidence", deliverySummary: "Implemented the auto-approved plan", outcome: "completed" },
    }),
    // Every step past the delivery succeeds: nothing here is a human decision.
    reviewDelivery: async (input) => ({
      outcome: "completed",
      attemptId: "delivery_review_attempt_auto",
      correctionAttempts: 0,
      subject: input.subject,
      review: { reviewId: "delivery_review_auto", leadExecutionId: "lead_execution_review", leadSessionRef: "lead_session", opinionArtifactId: "review_opinion", evidenceArtifactId: "review_evidence", opinion: "approved", summary: "The exact delivery matches the approved plan.", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "review_opinion", companyId, kind: "delivery-review", sha256: sha, byteSize: 1, mimeType: "application/json" } },
    }),
    reconcileTargetBase: async (input) => ({ outcome: "no_drift", checkId: `target_base_${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }),
    publishRelease: async () => ({ outcome: "completed", releaseId: "release_auto", repository: "acme/forge", branchName: "forge/issue/auto", baseBranch: "main", headSha: commit, headTree: commit, pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/forge/pull/7", isDraft: false, reused: false, attempt: 1, targetBaseSha: commit }),
    reconcileCi: async (input) => ({ runId: "ci_auto", attemptId: "ci_attempt_auto", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci_evidence", outcome: "passed", reason: "checks_passed", owner: null, repairable: false, summary: "All required checks passed", retryAt: null, nextPollAt: null, policyHash: "f".repeat(64), propagationDeadline: null, overallDeadline: null }),
    updateCiFromBase: async () => ({ outcome: "no_drift", summary: "The pull request base has not advanced" }),
    finalReview: async (input) => { reviewed = true; return { finalReviewId: "final_review_auto", leadExecutionId: "lead_execution_final", leadSessionRef: input.leadSessionRef, opinionArtifactId: "final_opinion", evidenceArtifactId: "final_evidence", reviewArtifact: { artifactId: "final_opinion", companyId, kind: "delivery-review", sha256: sha, byteSize: 1, mimeType: "application/json" }, outcome: "approved", summary: "Exact release approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }; },
    acceptDelivery: async () => ({ acceptanceId: "acceptance_auto", status: "accepted", outcome: "ready", retryAt: null, readyAt: "2026-01-01T00:00:00.000Z", acceptedAt: "2026-01-01T00:00:00.000Z", evidenceArtifactId: null, pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/forge/pull/7", reasonArtifactId: null }),
    reconcileMerge: async () => ({ outcome: "merged", pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/forge/pull/7", mergeObservationId: "merge_observation_auto", completionReceiptId: "completion_receipt_auto", observedAt: "2026-01-01T00:00:00.000Z", mergedAt: "2026-01-01T00:00:00.000Z", retryAt: null }),
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    // GitHub as the reconciler sees it: checks go green once Forge's final review ran, Forge then
    // requests auto-merge, and the next observation reports the pull request merged.
    observeGithubPullRequest: async () => ({ exists: true, number: 7, url: "https://github.com/acme/forge/pull/7", state: merged ? "merged" as const : "open" as const, isDraft: false, headSha: commit, baseSha: null, mergeable: "MERGEABLE", checks: reviewed ? { total: 1, pending: 0, failing: 0, successful: 1 } : { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    applyGithubPullRequestAction: async () => { merged = true; },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const input: IssueWorkflowInput = {
      workflowId,
      companyId,
      projectId: "project_guarded",
      issueId,
      projectRevisionId: "revision_guarded",
      briefArtifactId: "brief_guarded",
      briefSha256: "0".repeat(64),
      imageArtifactIds: [],
      roleProfiles: { planner: "profile", builder: "profile" },
      supplementalReview: false,
      autoApprovePlan: true,
      autoApprovePlanActorUserId: "member_guarded",
      pullRequestMode: "auto_merge",
      deliveryTarget: "merged",
      autoMergeActorUserId: "member_guarded",
      continuationState: {
        phase: "blocked",
        revision: 10,
        owner: "human",
        allowedCommands: ["respond_plan_blocker", "cancel_issue"],
        pendingAction: "Needs your call",
        lastEventId: `${workflowId}:10`,
        continuationCount: 0,
        lastSummaryHash: null,
        leadSessionRef: "lead_session",
        leadExecutionId: "lead_execution",
        leadOutputArtifactId: "blocker_artifact",
        leadOutputKind: "decision_blocker",
        blockedCategory: "human_decision",
        blockedResumePhase: "planning",
        planBlockerSubject: blockerSubject,
      },
    };
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue, args: [input] });
    // No command is ever sent after this one: every Lead-owned phase chains itself.
    const settled = await handle.executeUpdate(respondPlanBlockerUpdate, {
      args: [{ expectedRevision: 10, expectedWorkflowRevision: 10, actorUserId: "member_guarded", answerStagingRef: "staging_answer", answerSha256: sha, idempotencyKey: "blocker-answer-1" }],
      updateId: "auto-approve-blocker-response",
    });
    expect(settled).toMatchObject({ phase: "delivery_ready", developerOutcome: "completed", developerExecutionId: "developer_execution_auto" });
    expect(projections.map((state) => state.phase)).toContain("development");

    const done = await handle.result();
    // Merged deliveries skip the acceptance gate: done is the reconciler observing GitHub's merge.
    expect(done).toMatchObject({ phase: "done", pendingAction: "Merged", githubPullRequestState: "merged", finalReviewOutcome: "approved", ciOutcome: "passed" });
    expect(projections.map((state) => state.phase).filter((phase, index, all) => phase !== all[index - 1])).toEqual([
      "planning", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "delivery_reviewed",
      "releasing", "ci_waiting", "final_review", "manual_merge", "done",
    ]);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});

test("a non-decision command failure is recorded in the guarded state", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  let leadPlanningInput: { memberResponseArtifactId?: string | undefined; memberResponseSha256?: string | undefined } | undefined;
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    recordPlanBlockerResponse: async () => ({ responseId: "blocker_response", subjectHash: sha, answerArtifactId: "answer_artifact", answerArtifactSha256: sha }),
    // No planSubject on this result: exactSubject is false, so the landing "approval" state offers
    // reject_plan (a non-decision command) alongside approve_plan (a decision command).
    runLeadPlanning: async (input) => {
      leadPlanningInput = input;
      return {
        leadSessionRef: "lead_session",
        leadExecutionId: "lead_execution_2",
        leadEvidenceArtifactId: "lead_evidence",
        leadOutputArtifactId: "plan_artifact",
        leadOutputArtifactSha256: sha,
        leadOutputKind: "plan",
        leadSummary: "Plan after the blocker answer",
        materialCategories: ["security_permissions"],
        material: true,
      };
    },
    // reject_plan mutates state to "planning" and only then calls recordPlanDecision: the bug under
    // test would see "approve_plan" in the prior allowedCommands and misfire the decision-gate revert
    // instead of collapsing to the generic failed state.
    recordPlanDecision: async () => { throw ApplicationFailure.nonRetryable("The plan decision service is unavailable", "plan-decision-unavailable"); },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const input: IssueWorkflowInput = {
      workflowId,
      companyId,
      projectId: "project_guarded",
      issueId,
      projectRevisionId: "revision_guarded",
      briefArtifactId: "brief_guarded",
      briefSha256: "0".repeat(64),
      imageArtifactIds: [],
      roleProfiles: { planner: "profile", builder: "profile" },
      supplementalReview: false,
      continuationState: {
        phase: "blocked",
        revision: 10,
        owner: "human",
        allowedCommands: ["respond_plan_blocker", "cancel_issue"],
        pendingAction: "Needs your call",
        lastEventId: `${workflowId}:10`,
        continuationCount: 0,
        lastSummaryHash: null,
        leadSessionRef: "lead_session",
        leadExecutionId: "lead_execution",
        leadOutputArtifactId: "blocker_artifact",
        leadOutputKind: "decision_blocker",
        blockedCategory: "human_decision",
        blockedResumePhase: "planning",
        planBlockerSubject: blockerSubject,
      },
    };
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue, args: [input] });
    const approval = await handle.executeUpdate(respondPlanBlockerUpdate, {
      args: [{ expectedRevision: 10, expectedWorkflowRevision: 10, actorUserId: "member_guarded", answerStagingRef: "staging_answer", answerSha256: sha, idempotencyKey: "blocker-answer-1" }],
      updateId: "non-decision-blocker-response",
    });
    expect(approval).toMatchObject({ phase: "approval", owner: "human" });
    expect(approval.allowedCommands).toEqual(expect.arrayContaining(["approve_plan", "reject_plan"]));
    expect(leadPlanningInput).toMatchObject({ memberResponseArtifactId: "answer_artifact" });
    expect(leadPlanningInput).not.toHaveProperty("memberResponseSha256");

    const guarded = await handle.executeUpdate(rejectPlanUpdate, {
      args: [{ expectedRevision: approval.revision, actorUserId: "member_guarded", note: "Requesting a revision" }],
      updateId: "non-decision-reject-plan",
    });

    const projected = projections.at(-1)!;
    expect(guarded).toMatchObject({ phase: "planning", owner: "lead", lastHandlerError: { command: "unknown", reason: "Activity task failed" } });
    expect(projected).toMatchObject({ phase: "planning", owner: "lead", lastHandlerError: { command: "unknown", reason: "Activity task failed" } });
    expect(projected.allowedCommands).toContain("start_planning");
    // The guard records the failed handler state rather than rejecting the update task.
    expect(projected.allowedCommands).not.toContain("approve_plan");
    expect(projected.allowedCommands).not.toContain("reject_plan");
    // The invariant: the Workflow never keeps a revision the projection never saw.
    expect(projected.revision).toBe((await handle.query(issueStateQuery)).revision);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});

test("a failed acceptance records the guarded accepted state", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  const commit = "b".repeat(40);
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    reconcileTargetBase: async (input) => ({ outcome: "no_drift", checkId: `target_base_${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }),
    // The live failure this guards: GitHub rejects the merge method. The delivery is still accepted work,
    // so the member must land back on "Accept delivery", not on "re-plan from scratch".
    acceptDelivery: async () => {
      throw ApplicationFailure.create({ message: "Merge commits are not allowed on this repository", type: "github-merge-method-rejected", nonRetryable: true, details: [{ code: "github-merge-method-rejected", summary: "Merge commits are not allowed on this repository", category: "member_authorization", evidenceArtifactId: "merge_method_evidence", evidenceSha256: sha }] });
    },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const input: IssueWorkflowInput = {
      workflowId,
      companyId,
      projectId: "project_guarded",
      issueId,
      projectRevisionId: "revision_guarded",
      briefArtifactId: "brief_guarded",
      briefSha256: "0".repeat(64),
      imageArtifactIds: [],
      roleProfiles: { planner: "profile", builder: "profile" },
      supplementalReview: false,
      pullRequestMode: "auto_merge",
      autoMergeActorUserId: "member_guarded",
      continuationState: {
        phase: "accepted",
        revision: 30,
        owner: "human",
        allowedCommands: ["accept_delivery", "request_delivery_changes", "cancel_issue"],
        pendingAction: "Member acceptance required",
        lastEventId: `${workflowId}:30`,
        continuationCount: 0,
        lastSummaryHash: null,
        leadSessionRef: "lead_session",
        leadExecutionId: "lead_execution",
        leadOutputArtifactId: "plan_artifact",
        planRevision: 11,
        branchName: "forge/issue/guarded",
        targetBaseSha: "a".repeat(40),
        resultCommit: commit,
        resultTree: commit,
        dirtyState: "clean",
        deliveryArtifactId: "delivery_artifact",
        developerExecutionId: "developer_execution_guarded",
        developerEvidenceArtifactId: "developer_evidence",
        deliveryReviewId: "delivery_review_guarded",
        releaseId: "release_guarded",
        releaseRepository: "acme/forge",
        baseBranch: "main",
        pullRequestNumber: 478,
        pullRequestUrl: "https://github.com/acme/forge/pull/478",
        expectedHeadSha: commit,
        expectedHeadTree: commit,
        ciRunId: "ci_guarded",
        ciAttempt: 1,
        ciOutcome: "passed",
        finalReviewId: "final_review_guarded",
        finalReviewOutcome: "approved",
      },
    };
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue, args: [input] });
    const guarded = await handle.executeUpdate(acceptDeliveryUpdate, {
      args: [{ expectedRevision: 30, actorUserId: "member_guarded", commandId: "guarded-accept-1" }],
      updateId: "guarded-accept",
    });

    const projected = projections.at(-1)!;
    expect(guarded).toMatchObject({ phase: "accepted", owner: "human", lastHandlerError: { command: "accept_delivery", reason: "Activity task failed" } });
    expect(projected).toMatchObject({ phase: "accepted", owner: "human", pendingAction: "Member acceptance required" });
    expect(projected.lastHandlerError).toMatchObject({ command: "accept_delivery", reason: "Activity task failed" });
    expect(projected.allowedCommands).toContain("accept_delivery");
    // The invariant: the Workflow never keeps a revision the projection never saw.
    expect(projected.revision).toBe((await handle.query(issueStateQuery)).revision);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});
