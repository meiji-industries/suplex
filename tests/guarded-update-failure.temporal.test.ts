import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { PlanBlockerSubject, PlanSubject } from "../src/plan-governance.js";
import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow, respondPlanBlockerUpdate } from "../src/temporal/workflows.js";
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

test("a rejected update handler projects a retryable failed state instead of stranding mutated Workflow state", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    recordPlanBlockerResponse: async () => ({ responseId: "blocker_response", subjectHash: sha, answerArtifactId: "answer_artifact", answerArtifactSha256: sha }),
    runLeadPlanning: async () => ({
      leadSessionRef: "lead_session",
      leadExecutionId: "lead_execution_2",
      leadEvidenceArtifactId: "lead_evidence",
      leadOutputArtifactId: "plan_artifact",
      leadOutputArtifactSha256: sha,
      leadOutputKind: "plan",
      leadSummary: "Material plan after the blocker answer",
      materialCategories: ["security_permissions"],
      material: true,
      planSubject,
      materialityEvidence: { categories: ["security_permissions"], artifactId: "materiality_artifact", artifactSha256: sha },
    }),
    recordPlanDecision: async () => ({ decisionId: "decision_guarded", subjectHash: sha }),
    // The bug under test: authorization rejects after the handler already mutated state.
    authorizeFinalPlan: async () => { throw ApplicationFailure.nonRetryable("The exact final plan artifact is unavailable", "plan-authorization-mismatch"); },
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
      continuationState: {
        phase: "blocked",
        revision: 10,
        owner: "human",
        allowedCommands: ["respond_plan_blocker", "cancel_issue"],
        pendingAction: "Member decision required",
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
    await expect(handle.executeUpdate(respondPlanBlockerUpdate, {
      args: [{ expectedRevision: 10, expectedWorkflowRevision: 10, actorUserId: "member_guarded", answerStagingRef: "staging_answer", answerSha256: sha, idempotencyKey: "blocker-answer-1" }],
      updateId: "guarded-blocker-response",
    })).rejects.toThrow();

    const projected = projections.at(-1)!;
    expect(projected).toMatchObject({ phase: "failed", owner: "human" });
    expect(projected.allowedCommands).toContain("start_planning");
    // The invariant: the Workflow never keeps a revision the projection never saw.
    expect(projected.revision).toBe((await handle.query(issueStateQuery)).revision);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});

test("a task created with auto-approve and auto-merge reaches done without another human click", { timeout: 180_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  const capacity = createImmediateCapacityActivities();
  const commit = "b".repeat(40);
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
      leadSummary: "Material plan after the blocker answer",
      materialCategories: ["security_permissions"],
      material: true,
      planSubject,
      materialityEvidence: { categories: ["security_permissions"], artifactId: "materiality_artifact", artifactSha256: sha },
    }),
    recordPlanDecision: async () => ({ decisionId: "decision_auto", subjectHash: sha }),
    authorizeFinalPlan: async () => ({ authorizationId: "authorization_auto", planRevision: 11, planArtifactId: "plan_artifact", planArtifactSha256: sha, authorizationKind: "human_approval", approvalDecisionId: "decision_auto", authorizedAt: "2026-01-01T00:00:00.000Z" }),
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
    finalReview: async (input) => ({ finalReviewId: "final_review_auto", leadExecutionId: "lead_execution_final", leadSessionRef: input.leadSessionRef, opinionArtifactId: "final_opinion", evidenceArtifactId: "final_evidence", reviewArtifact: { artifactId: "final_opinion", companyId, kind: "delivery-review", sha256: sha, byteSize: 1, mimeType: "application/json" }, outcome: "approved", summary: "Exact release approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }),
    acceptDelivery: async () => ({ acceptanceId: "acceptance_auto", status: "accepted", outcome: "ready", retryAt: null, readyAt: "2026-01-01T00:00:00.000Z", acceptedAt: "2026-01-01T00:00:00.000Z", evidenceArtifactId: null, pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/forge/pull/7", reasonArtifactId: null }),
    reconcileMerge: async () => ({ outcome: "merged", pullRequestNumber: 7, pullRequestUrl: "https://github.com/acme/forge/pull/7", mergeObservationId: "merge_observation_auto", completionReceiptId: "completion_receipt_auto", observedAt: "2026-01-01T00:00:00.000Z", mergedAt: "2026-01-01T00:00:00.000Z", retryAt: null }),
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
      autoMergeActorUserId: "member_guarded",
      continuationState: {
        phase: "blocked",
        revision: 10,
        owner: "human",
        allowedCommands: ["respond_plan_blocker", "cancel_issue"],
        pendingAction: "Member decision required",
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
    expect(done).toMatchObject({ phase: "done", pendingAction: "Merged pull request confirmed", mergeOutcome: "merged", acceptanceId: "acceptance_auto", finalReviewOutcome: "approved", ciOutcome: "passed" });
    expect(projections.map((state) => state.phase).filter((phase, index, all) => phase !== all[index - 1])).toEqual([
      "planning", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "delivery_reviewed",
      "releasing", "ci_waiting", "final_review", "accepted", "manual_merge", "done",
    ]);

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});
