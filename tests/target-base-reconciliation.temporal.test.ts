import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { IssueActivities, IssueWorkflowInput, ReconcileTargetBaseActivityInput, ReconcileTargetBaseActivityResult, TargetBaseCheckpoint } from "../src/temporal/issue-contracts.js";
import { acceptDeliveryUpdate, cancelIssueUpdate, finalReviewUpdate, issueWorkflow, publishDraftUpdate, resolveMergeConflictUpdate, retryForwardMergeVerificationUpdate } from "../src/temporal/workflows.js";
import { createImmediateCapacityActivities } from "./immediate-capacity-activities.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const nextBase = "d".repeat(40);
const mergedHead = "e".repeat(40);
const mergedTree = "f".repeat(40);
const artifactSha = "9".repeat(64);
const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));

let environment: TestWorkflowEnvironment | undefined;

afterEach(async () => {
  await environment?.teardown();
  environment = undefined;
});

function continuation(checkpoint: TargetBaseCheckpoint): NonNullable<IssueWorkflowInput["continuationState"]> {
  const phase = checkpoint === "pre_release" ? "delivery_reviewed" : checkpoint === "pre_final_review" ? "final_review" : "accepted";
  return {
    phase,
    revision: 10,
    owner: checkpoint === "pre_acceptance" ? "human" : "lead",
    allowedCommands: checkpoint === "pre_release" ? ["publish_draft", "cancel_issue"] : checkpoint === "pre_final_review" ? ["final_review", "cancel_issue"] : ["accept_delivery", "request_delivery_changes", "cancel_issue"],
    pendingAction: "Run exact-head gate",
    lastEventId: "seed:10",
    continuationCount: 0,
    lastSummaryHash: null,
    leadSessionRef: "lead_session",
    leadOutputArtifactId: "lead_plan",
    leadSummary: "Approved plan",
    planRevision: 1,
    developerExecutionId: "developer_original",
    developerSessionRef: "developer_session",
    worktreePath: "/tmp/forge_target_base_test",
    branchName: "forge/issue/target_base_test",
    targetBaseSha: base,
    resultCommit: head,
    resultTree: tree,
    dirtyState: "clean",
    deliveryArtifactId: "delivery_original",
    developerEvidenceArtifactId: "evidence_original",
    deliverySummary: "Verified delivery",
    developerOutcome: "completed",
    deliveryReviewId: "review_original",
    deliveryReviewOutcome: "approved",
    releaseId: checkpoint === "pre_release" ? null : "release_original",
    releaseRepository: checkpoint === "pre_release" ? null : "acme/forge",
    baseBranch: checkpoint === "pre_release" ? null : "main",
    pullRequestNumber: checkpoint === "pre_release" ? null : 42,
    pullRequestUrl: checkpoint === "pre_release" ? null : "https://github.com/acme/forge/pull/42",
    expectedHeadSha: checkpoint === "pre_release" ? null : head,
    expectedHeadTree: checkpoint === "pre_release" ? null : tree,
    ciRunId: checkpoint === "pre_release" ? null : "ci_original",
    ciOutcome: checkpoint === "pre_release" ? null : "passed",
    finalReviewId: checkpoint === "pre_acceptance" ? "final_original" : null,
    finalReviewOutcome: checkpoint === "pre_acceptance" ? "approved" : null,
  };
}

function input(issueId: string, checkpoint: TargetBaseCheckpoint): IssueWorkflowInput {
  const workflowId = `workflow:${issueId}`;
  return {
    workflowId,
    companyId: "company_test",
    projectId: "project_test",
    issueId,
    projectRevisionId: "revision_test",
    briefArtifactId: "brief_test",
    briefSha256: "0".repeat(64),
    imageArtifactIds: [],
    roleProfiles: { lead: "profile", developer: "profile" },
    supplementalReview: false,
    continuationState: continuation(checkpoint),
  };
}

function resultFor(input: ReconcileTargetBaseActivityInput, outcome: "no_drift" | "revalidated"): ReconcileTargetBaseActivityResult {
  if (outcome === "no_drift") return { outcome, checkId: `check_${input.taskId}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree };
  return {
    outcome,
    checkId: `check_${input.taskId}`,
    checkpoint: input.checkpoint,
    expectedBaseSha: input.expectedBaseSha,
    observedBaseSha: nextBase,
    priorHead: input.expectedHeadSha,
    priorTree: input.expectedHeadTree,
    headSha: mergedHead,
    headTree: mergedTree,
    developerExecutionId: "developer_forward_merge",
    deliveryArtifact: { id: "delivery_forward_merge", sha256: artifactSha, kind: "forward-merge-delivery" },
    verificationArtifact: { id: "verification_forward_merge", sha256: artifactSha, kind: "forward-merge-verification" },
  };
}

test("time-skipping Workflows apply the same target-base contract at release, final review, and acceptance and replay every history", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const histories: Array<{ history: Parameters<typeof Worker.runReplayHistory>[1]; workflowId: string }> = [];
  const outcomes = new Map<string, "no_drift" | "revalidated" | "provider" | "race" | "verification_then_pass" | "conflict">();
  const attempts = new Map<string, number>();
  const capacity = createImmediateCapacityActivities();
  const activities: Partial<IssueActivities> = {
    ...capacity.activities,
    projectIssueState: async (event) => event.state,
    reconcileTargetBase: async (activityInput) => {
      const configured = outcomes.get(activityInput.taskId) ?? "no_drift";
      attempts.set(activityInput.taskId, (attempts.get(activityInput.taskId) ?? 0) + 1);
      if (configured === "provider") return { outcome: "blocked", checkId: `check_${activityInput.taskId}`, checkpoint: activityInput.checkpoint, code: "provider_unavailable", owner: "provider", retryable: true, summary: "GitHub base observation is temporarily unavailable" };
      if (configured === "race") return { outcome: "blocked", checkId: `check_${activityInput.taskId}`, checkpoint: activityInput.checkpoint, code: "base_advanced_again", owner: "provider", retryable: true, summary: "The target base advanced during reconciliation" };
      if (configured === "verification_then_pass" && !activityInput.verificationOnly) return { outcome: "blocked", checkId: `check_${activityInput.taskId}`, checkpoint: activityInput.checkpoint, code: "verification_failed", owner: "lead", retryable: true, summary: "Pinned verification failed", evidenceArtifact: { id: "verification_failed", sha256: artifactSha, kind: "forward-merge-verification" }, observedBaseSha: nextBase, priorHead: head, priorTree: tree, resultHead: mergedHead, resultTree: mergedTree };
      if (configured === "conflict" && !activityInput.verificationOnly) return { outcome: "conflict", checkId: `check_${activityInput.taskId}`, checkpoint: activityInput.checkpoint, expectedBaseSha: activityInput.expectedBaseSha, observedBaseSha: nextBase, priorHead: activityInput.expectedHeadSha, priorTree: activityInput.expectedHeadTree, conflictFileCount: 1, conflictArtifact: { id: "conflict_artifact", sha256: artifactSha, kind: "forward-merge-conflict" } };
      if (configured === "conflict") return resultFor(activityInput, "revalidated");
      return resultFor(activityInput, configured === "verification_then_pass" ? "revalidated" : configured);
    },
    publishRelease: async () => ({ outcome: "completed", releaseId: "release_new", repository: "acme/forge", branchName: "forge/issue/target_base_test", baseBranch: "main", headSha: head, headTree: tree, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", isDraft: true, reused: false, attempt: 1 }),
    reconcileCi: async (activityInput) => ({ runId: "ci_new", attemptId: "ci_attempt_new", attemptNumber: activityInput.attemptNumber, expectedHeadSha: activityInput.expectedHeadSha, observedHeadSha: activityInput.expectedHeadSha, evidenceArtifactId: null, outcome: "waiting", reason: "checks_pending", owner: "system", repairable: false, summary: "Required CI is still running", retryAt: null, nextPollAt: null, policyHash: artifactSha, propagationDeadline: null, overallDeadline: null }),
    finalReview: async () => ({ finalReviewId: "final_new", leadExecutionId: "lead_final", leadSessionRef: "lead_session", opinionArtifactId: "opinion_final", evidenceArtifactId: "evidence_final", reviewArtifact: { artifactId: "review_final", companyId: "company_test", kind: "delivery-review", sha256: artifactSha, byteSize: 1, mimeType: "application/json" }, outcome: "approved", summary: "Exact head approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }),
    acceptDelivery: async () => ({ acceptanceId: "acceptance_new", status: "accepted", pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42" }),
    reconcileMerge: async () => ({ outcome: "open", mergeObservationId: "merge-observation", completionReceiptId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", observedAt: "2026-08-12T00:00:00.000Z", mergedAt: null, retryAt: null }),
    planMergeConflict: async () => ({ planId: "conflict_plan", planArtifactId: "conflict_plan_artifact", evidenceArtifactId: "conflict_plan_evidence", leadExecutionId: "lead_conflict", leadSessionRef: "lead_session", summary: "Preserve both branch invariants" }),
    resolveMergeConflict: async () => ({ outcome: "verification_blocked", developerExecutionId: "developer_conflict_resolution", developerSessionRef: "developer_session", resultCommit: mergedHead, resultTree: mergedTree, evidenceArtifactId: "conflict_resolution_evidence", verificationArtifact: { id: "verification_failed", sha256: artifactSha, kind: "forward-merge-verification" }, code: "verification_failed", summary: "Pinned verification failed after conflict resolution" }),
    resolveMergeConflictSupervised: async () => ({ status: "completed", result: { outcome: "verification_blocked", developerExecutionId: "developer_conflict_resolution", developerSessionRef: "developer_session", resultCommit: mergedHead, resultTree: mergedTree, evidenceArtifactId: "conflict_resolution_evidence", verificationArtifact: { id: "verification_failed", sha256: artifactSha, kind: "forward-merge-verification" }, code: "verification_failed", summary: "Pinned verification failed after conflict resolution" }, resultHash: artifactSha }),
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: "target-base-time-skipping", workflowsPath, activities: activities as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    for (const checkpoint of ["pre_release", "pre_final_review", "pre_acceptance"] as const) {
      for (const outcome of ["no_drift", "revalidated"] as const) {
        const issueId = `${checkpoint}_${outcome}`;
        outcomes.set(issueId, outcome);
        const workflowInput = input(issueId, checkpoint);
        const handle = await environment.client.workflow.start(issueWorkflow, { workflowId: workflowInput.workflowId, taskQueue: "target-base-time-skipping", args: [workflowInput] });
        const command = { expectedRevision: 10, actorUserId: "member_test" };
        const state = checkpoint === "pre_release"
          ? await handle.executeUpdate(publishDraftUpdate, { args: [command] })
          : checkpoint === "pre_final_review"
            ? await handle.executeUpdate(finalReviewUpdate, { args: [command] })
            : await handle.executeUpdate(acceptDeliveryUpdate, { args: [command] });
        if (outcome === "revalidated") {
          expect(state).toMatchObject({ phase: "delivery_ready", targetBaseSha: nextBase, resultCommit: mergedHead, resultTree: mergedTree, developerExecutionId: "developer_forward_merge", deliveryReviewId: null, ciRunId: null, finalReviewId: null, acceptanceId: null });
          if (checkpoint !== "pre_release") expect(state).toMatchObject({ releaseId: "release_original", pullRequestNumber: 42 });
        } else {
          expect(state.phase).toBe(checkpoint === "pre_release" ? "ci_waiting" : checkpoint === "pre_final_review" ? "accepted" : "manual_merge");
        }
        histories.push({ history: await handle.fetchHistory(), workflowId: workflowInput.workflowId });
      }
    }

    for (const blocker of ["provider", "race"] as const) {
      const issueId = `pre_release_${blocker}`;
      outcomes.set(issueId, blocker);
      const workflowInput = input(issueId, "pre_release");
      const handle = await environment.client.workflow.start(issueWorkflow, { workflowId: workflowInput.workflowId, taskQueue: "target-base-time-skipping", args: [workflowInput] });
      const blocked = await handle.executeUpdate(publishDraftUpdate, { args: [{ expectedRevision: 10, actorUserId: "member_test" }] });
      expect(blocked).toMatchObject({ phase: "delivery_blocked", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], targetBaseBlockerCode: blocker === "provider" ? "provider_unavailable" : "base_advanced_again" });
      const cancelled = await handle.executeUpdate(cancelIssueUpdate, { args: [{ expectedRevision: blocked.revision, actorUserId: "member_test" }] });
      expect(cancelled).toMatchObject({ phase: "cancelled", allowedCommands: ["continue_work"] });
      histories.push({ history: await handle.fetchHistory(), workflowId: workflowInput.workflowId });
    }

    const retryIssue = "pre_release_verification_retry";
    outcomes.set(retryIssue, "verification_then_pass");
    const retryInput = input(retryIssue, "pre_release");
    const retryHandle = await environment.client.workflow.start(issueWorkflow, { workflowId: retryInput.workflowId, taskQueue: "target-base-time-skipping", args: [retryInput] });
    const blocked = await retryHandle.executeUpdate(publishDraftUpdate, { args: [{ expectedRevision: 10, actorUserId: "member_test" }] });
    expect(blocked).toMatchObject({ phase: "delivery_blocked", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], resultCommit: mergedHead, resultTree: mergedTree });
    const retried = await retryHandle.executeUpdate(retryForwardMergeVerificationUpdate, { args: [{ expectedRevision: blocked.revision, actorUserId: "member_test" }] });
    expect(retried).toMatchObject({ phase: "delivery_ready", targetBaseSha: nextBase, resultCommit: mergedHead, resultTree: mergedTree });
    expect(attempts.get(retryIssue)).toBe(2);
    histories.push({ history: await retryHandle.fetchHistory(), workflowId: retryInput.workflowId });

    const conflictIssue = "pre_final_review_conflict";
    outcomes.set(conflictIssue, "conflict");
    const conflictInput = input(conflictIssue, "pre_final_review");
    const conflictHandle = await environment.client.workflow.start(issueWorkflow, { workflowId: conflictInput.workflowId, taskQueue: "target-base-time-skipping", args: [conflictInput] });
    const planned = await conflictHandle.executeUpdate(finalReviewUpdate, { args: [{ expectedRevision: 10, actorUserId: "member_test" }] });
    expect(planned).toMatchObject({ phase: "merge_conflict_required", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], releaseId: "release_original", pullRequestNumber: 42, forwardMergeConflictFileCount: 1 });
    const verificationBlocked = await conflictHandle.executeUpdate(resolveMergeConflictUpdate, { args: [{ expectedRevision: planned.revision, actorUserId: "member_test" }] });
    expect(verificationBlocked).toMatchObject({ phase: "delivery_blocked", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], developerExecutionId: "developer_conflict_resolution", resultCommit: mergedHead, resultTree: mergedTree, releaseId: "release_original", pullRequestNumber: 42 });
    const conflictRecovered = await conflictHandle.executeUpdate(retryForwardMergeVerificationUpdate, { args: [{ expectedRevision: verificationBlocked.revision, actorUserId: "member_test" }] });
    expect(conflictRecovered).toMatchObject({ phase: "delivery_ready", developerExecutionId: "developer_forward_merge", resultCommit: mergedHead, resultTree: mergedTree, releaseId: "release_original", pullRequestNumber: 42, deliveryReviewId: null, ciRunId: null, finalReviewId: null });
    histories.push({ history: await conflictHandle.fetchHistory(), workflowId: conflictInput.workflowId });
  } finally {
    worker.shutdown();
    await workerRun;
  }

  for (const item of histories) await Worker.runReplayHistory({ workflowsPath }, item.history, item.workflowId);
});
