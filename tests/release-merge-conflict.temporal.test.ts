import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow } from "../src/temporal/workflows.js";
import { createImmediateCapacityActivities } from "./immediate-capacity-activities.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const nextBase = "d".repeat(40);
const mergedHead = "e".repeat(40);
const mergedTree = "f".repeat(40);
const sha256 = "9".repeat(64);
const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));
const taskQueue = "release-merge-conflict";

let environment: TestWorkflowEnvironment | undefined;

afterEach(async () => {
  await environment?.teardown();
  environment = undefined;
});

// A conflict found while publishing must leave the Workflow with the same forward-merge
// inputs a plan-side conflict leaves, or the Integrator's resolve turn throws
// "An owned Developer execution and forward-merge evidence are required" and the
// auto-chain halts for good.
test("a conflict detected during release resolves through the Integrator and reaches done", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const capacity = createImmediateCapacityActivities();
  const capacityRoles: string[] = [];
  const projections: IssueWorkflowState[] = [];
  let publishes = 0;
  const activities: Partial<IssueActivities> = {
    ...capacity.activities,
    requestCapacity: async (input) => {
      capacityRoles.push(`${input.operation}:${input.role}`);
      return capacity.activities.requestCapacity(input);
    },
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    reconcileTargetBase: async (input) => ({ outcome: "no_drift" as const, checkId: `target-base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree }),
    publishRelease: async () => {
      publishes += 1;
      if (publishes > 1) return { outcome: "completed" as const, releaseId: "release_new", repository: "acme/forge", branchName: "forge/issue/release_conflict", baseBranch: "main", headSha: mergedHead, headTree: mergedTree, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", isDraft: false, reused: false, attempt: 1, targetBaseSha: nextBase };
      return {
        outcome: "base-drift-conflict" as const,
        releaseId: null,
        repository: "acme/forge",
        branchName: "forge/issue/release_conflict",
        headSha: head,
        headTree: tree,
        pullRequestNumber: null,
        pullRequestUrl: null,
        isDraft: false as const,
        reused: false,
        attempt: 1,
        baseDriftConflict: true as const,
        targetBaseSha: nextBase,
        priorHead: head,
        priorTree: tree,
        forwardMergeId: "merge_release_conflict",
        conflictArtifact: { id: "conflict_artifact", sha256, kind: "forward-merge-conflict" as const },
        conflictFileCount: 1,
        mergeConflictEvidence: { artifactId: "conflict_evidence", companyId: "company_test", kind: "merge-conflict-evidence" as const, sha256, byteSize: 1, mimeType: "application/json" },
      };
    },
    planMergeConflict: async () => ({ planId: "conflict_plan", planArtifactId: "conflict_plan_artifact", evidenceArtifactId: "conflict_plan_evidence", leadExecutionId: "lead_conflict", leadSessionRef: "lead_session", summary: "Keep both invariants" }),
    resolveMergeConflictSupervised: async () => ({ status: "completed" as const, resultHash: sha256, result: { developerExecutionId: "developer_conflict_resolution", developerSessionRef: "developer_session", resultCommit: mergedHead, resultTree: mergedTree, deliveryArtifactId: "delivery_forward_merge", deliveryArtifactSha256: sha256, evidenceArtifactId: "conflict_resolution_evidence", evidenceArtifactSha256: sha256, verificationArtifactId: "verification_forward_merge", verificationArtifactSha256: sha256, summary: "Resolved the release conflict" } }),
    reviewDelivery: async (input) => ({
      outcome: "completed" as const,
      attemptId: "delivery_review_attempt",
      correctionAttempts: 0,
      subject: input.subject,
      review: { reviewId: "delivery_review_new", leadExecutionId: "lead_review", leadSessionRef: "lead_session", opinionArtifactId: "review_opinion", evidenceArtifactId: "review_evidence", opinion: "approved" as const, summary: "The merged delivery matches the plan.", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "review_artifact", companyId: "company_test", kind: "delivery-review" as const, sha256, byteSize: 1, mimeType: "application/json" } },
    }),
    reconcileCi: async (input) => ({ runId: "ci_new", attemptId: "ci_attempt_new", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci_evidence", outcome: "passed" as const, reason: "checks_passed", owner: null, repairable: false, summary: "All required checks passed", retryAt: null, nextPollAt: null, policyHash: sha256, propagationDeadline: null, overallDeadline: null }),
    finalReview: async (input) => ({ finalReviewId: "final_new", leadExecutionId: "lead_final", leadSessionRef: input.leadSessionRef, opinionArtifactId: "opinion_final", evidenceArtifactId: "evidence_final", evidenceArtifactSha256: sha256, reviewArtifact: { artifactId: "review_final", companyId: "company_test", kind: "delivery-review" as const, sha256, byteSize: 1, mimeType: "application/json" }, outcome: "approved" as const, summary: "Exact release approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }),
    acceptDelivery: async () => ({ acceptanceId: "acceptance_new", status: "accepted" as const, outcome: "ready" as const, retryAt: null, readyAt: "2026-08-21T00:00:00.000Z", acceptedAt: "2026-08-21T00:00:00.000Z", evidenceArtifactId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", reasonArtifactId: null }),
    reconcileMerge: async () => ({ outcome: "merged" as const, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", mergeObservationId: "merge_observation", completionReceiptId: "completion_receipt", observedAt: "2026-08-21T00:00:00.000Z", mergedAt: "2026-08-21T00:00:00.000Z", retryAt: null }),
  };

  const workflowId = "workflow:release_conflict";
  const input: IssueWorkflowInput = {
    workflowId,
    companyId: "company_test",
    projectId: "project_test",
    issueId: "release_conflict",
    projectRevisionId: "revision_test",
    briefArtifactId: "brief_test",
    briefSha256: "0".repeat(64),
    imageArtifactIds: [],
    roleProfiles: { planner: "profile-planner", builder: "profile-builder", integrator: "profile-integrator" },
    supplementalReview: false,
    pullRequestMode: "auto_merge",
    autoMergeActorUserId: "member_test",
    continuationState: {
      phase: "delivery_reviewed",
      revision: 10,
      owner: "lead",
      allowedCommands: ["publish_draft", "cancel_issue"],
      pendingAction: "Publish draft",
      lastEventId: "seed:10",
      continuationCount: 0,
      lastSummaryHash: null,
      leadSessionRef: "lead_session",
      leadOutputArtifactId: "lead_plan",
      leadSummary: "Approved plan",
      planRevision: 1,
      developerExecutionId: "developer_original",
      developerSessionRef: "developer_session",
      worktreePath: "/tmp/forge_release_conflict_test",
      branchName: "forge/issue/release_conflict",
      targetBaseSha: base,
      resultCommit: head,
      resultTree: tree,
      dirtyState: "clean",
      deliveryArtifactId: "delivery_original",
      developerEvidenceArtifactId: "evidence_original",
      deliverySummary: "Verified delivery",
      developerOutcome: "completed",
      developerRecoveryStatus: "active",
      developerRecoverySummary: "Developer result claimed.",
      deliveryReviewId: "review_original",
      deliveryReviewOutcome: "approved",
    },
  };

  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath, activities: activities as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  let history: Awaited<ReturnType<Awaited<ReturnType<typeof environment.client.workflow.start>>["fetchHistory"]>>;
  try {
    // The auto-chain drives publish_draft itself from delivery_reviewed.
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue, args: [input] });
    await handle.result();

    // The regression: the release path used to store neither the prior tree nor the
    // conflict artifact, so resolve_merge_conflict threw on its own preconditions and
    // the auto-chain halted for good at merge_conflict_required.
    const conflicted = projections.find((state) => state.phase === "merge_conflict_required");
    expect(conflicted).toMatchObject({
      forwardMergeId: "merge_release_conflict",
      forwardMergePriorHead: head,
      forwardMergePriorTree: tree,
      forwardMergeTargetBaseSha: nextBase,
      forwardMergeConflictArtifact: { id: "conflict_artifact", sha256, kind: "forward-merge-conflict" },
      forwardMergeConflictFileCount: 1,
    });

    const settled = await handle.query(issueStateQuery);
    expect(settled).toMatchObject({ phase: "done", targetBaseSha: nextBase, resultCommit: mergedHead, resultTree: mergedTree, developerExecutionId: "developer_conflict_resolution" });
    // The Integrator, not the Planner or the Builder, owns the release-side conflict turns.
    expect(capacityRoles).toContain("merge_conflict_plan:integrator");
    expect(capacityRoles).toContain("merge_conflict_resolution:integrator");
    expect(capacityRoles).toContain("final_review:integrator");
    history = await handle.fetchHistory();
  } finally {
    worker.shutdown();
    await workerRun;
  }

  await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
});
