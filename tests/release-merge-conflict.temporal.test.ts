import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow } from "../src/temporal/workflows.js";

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

// Since the Kodiak-style base updates (forge-kodiak-merge-v1) a release-side conflict is
// found while keeping the open pull request current during CI, not by publishRelease. That
// path must leave the Workflow with the same forward-merge inputs a plan-side conflict
// leaves, or the Integrator's resolve turn throws "An owned Developer execution and
// forward-merge evidence are required" and the auto-chain halts for good.
test("GitHub conflicts start automatic resolution without a human command", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  let publishes = 0;
  let baseUpdates = 0;
  let forwardVerificationChecks = 0;
  let reviewed = false;
  let merged = false;
  let githubConflictSeen = false;
  const githubActions: string[] = [];
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    reconcileTargetBase: async (input) => input.checkpoint === "pre_release" && ++forwardVerificationChecks === 1
      ? { outcome: "blocked" as const, checkId: "forward_merge_failure", checkpoint: input.checkpoint, code: "verification_failed" as const, owner: "lead" as const, retryable: true, summary: "The project test command failed", observedBaseSha: nextBase, priorHead: head, priorTree: tree, resultHead: mergedHead, resultTree: mergedTree }
      : { outcome: "no_drift" as const, checkId: `target-base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: nextBase, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree },
    publishRelease: async () => {
      publishes += 1;
      const merged = publishes > 1;
      return { outcome: "completed" as const, releaseId: "release_new", repository: "acme/forge", branchName: "forge/issue/release_conflict", baseBranch: "main", headSha: merged ? mergedHead : head, headTree: merged ? mergedTree : tree, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", isDraft: false, reused: merged, attempt: 1, targetBaseSha: merged ? nextBase : base };
    },
    reconcileCi: async (input) => ({ runId: "ci_new", attemptId: "ci_attempt_new", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci_evidence", outcome: "passed" as const, reason: "checks_passed", owner: null, repairable: false, summary: "All required checks passed", retryAt: null, nextPollAt: null, policyHash: sha256, propagationDeadline: null, overallDeadline: null }),
    // A GitHub conflict starts the existing conflict-resolution path before CI handling.
    updateCiFromBase: async () => {
      baseUpdates += 1;
      return { outcome: "no_drift" as const, summary: "The pull request base has not advanced" };
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
    finalReview: async (input) => { reviewed = true; return { finalReviewId: "final_new", leadExecutionId: "lead_final", leadSessionRef: input.leadSessionRef, opinionArtifactId: "opinion_final", evidenceArtifactId: "evidence_final", evidenceArtifactSha256: sha256, reviewArtifact: { artifactId: "review_final", companyId: "company_test", kind: "delivery-review" as const, sha256, byteSize: 1, mimeType: "application/json" }, outcome: "approved" as const, summary: "Exact release approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null }; },
    acceptDelivery: async () => ({ acceptanceId: "acceptance_new", status: "accepted" as const, outcome: "ready" as const, retryAt: null, readyAt: "2026-08-21T00:00:00.000Z", acceptedAt: "2026-08-21T00:00:00.000Z", evidenceArtifactId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", reasonArtifactId: null }),
    reconcileMerge: async () => ({ outcome: "merged" as const, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", mergeObservationId: "merge_observation", completionReceiptId: "completion_receipt", observedAt: "2026-08-21T00:00:00.000Z", mergedAt: "2026-08-21T00:00:00.000Z", retryAt: null }),
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    // GitHub first reports a conflict. After Forge resolves it, CI passes and auto-merge completes.
    observeGithubPullRequest: async () => {
      const mergeable = githubConflictSeen ? "MERGEABLE" as const : "CONFLICTING" as const;
      githubConflictSeen = true;
      return { exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: merged ? "merged" as const : "open" as const, isDraft: false, headSha: mergedHead, baseSha: nextBase, mergeable, checks: reviewed ? { total: 1, pending: 0, failing: 0, successful: 1 } : { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null };
    },
    applyGithubPullRequestAction: async (input) => {
      githubActions.push(input.action);
      merged = true;
    },
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
    deliveryTarget: "merged",
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
    // The auto-chain drives publish_draft, resolve_merge_conflict and review_delivery itself.
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue, args: [input] });
    await handle.result();

    const settled = await handle.query(issueStateQuery);
    expect(settled).toMatchObject({ phase: "done", targetBaseSha: nextBase, resultCommit: mergedHead, resultTree: mergedTree, developerExecutionId: "developer_original" });
    const failedVerificationReview = projections.find((projection) => projection.deliverySummary === "Project verification failed: The project test command failed");
    expect(failedVerificationReview).toMatchObject({ phase: "delivery_ready", owner: "lead", resultCommit: mergedHead, resultTree: mergedTree, targetBaseSha: nextBase, targetBaseBlockerCode: "verification_failed" });
    expect(failedVerificationReview?.allowedCommands).toContain("review_delivery");
    expect(publishes).toBe(2);
    expect(githubActions).toEqual(["enable_auto_merge"]);
    history = await handle.fetchHistory();
  } finally {
    worker.shutdown();
    await workerRun;
  }

  await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
});


test("a forward-merge verification timeout stays retryable", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  let timeoutProjection!: () => void;
  const timeoutSeen = new Promise<void>((resolve) => { timeoutProjection = resolve; });
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => {
      projections.push(structuredClone(event.state));
      if (event.state.targetBaseBlockerCode === "verification_timed_out") timeoutProjection();
      return event.state;
    },
    pushDeliveryBranch: async (input) => ({ repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }),
    reconcileTargetBase: async (input) => ({ outcome: "blocked" as const, checkId: "forward_merge_timeout", checkpoint: input.checkpoint, code: "verification_timed_out" as const, owner: "lead" as const, retryable: true, summary: "The project test command timed out", observedBaseSha: nextBase, priorHead: head, priorTree: tree, resultHead: mergedHead, resultTree: mergedTree }),
    publishRelease: async () => ({ outcome: "completed" as const, releaseId: "release_timeout", repository: "acme/forge", branchName: "forge/issue/release_timeout", baseBranch: "main", headSha: head, headTree: tree, pullRequestNumber: 43, pullRequestUrl: "https://github.com/acme/forge/pull/43", isDraft: false, reused: false, attempt: 1, targetBaseSha: base }),
    observeGithubPullRequest: async () => ({ exists: true, number: 43, url: "https://github.com/acme/forge/pull/43", state: "open" as const, isDraft: false, headSha: head, baseSha: nextBase, mergeable: "CONFLICTING" as const, checks: { total: 1, pending: 1, failing: 0, successful: 0 }, autoMergeEnabled: false, reviewDecision: null }),
    applyGithubPullRequestAction: async () => undefined,
    reconcileCi: async (input) => ({ runId: "ci_timeout", attemptId: "ci_attempt_timeout", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "ci_evidence", outcome: "waiting" as const, reason: "checks_pending", owner: null, repairable: false, summary: "Checks are pending", retryAt: null, nextPollAt: "2026-08-21T00:00:00.000Z", policyHash: sha256, propagationDeadline: null, overallDeadline: null }),
  };
  const input: IssueWorkflowInput = {
    workflowId: "workflow:release_timeout", companyId: "company_test", projectId: "project_test", issueId: "release_timeout", projectRevisionId: "revision_test", briefArtifactId: "brief_test", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: { planner: "profile-planner", builder: "profile-builder" }, supplementalReview: false, pullRequestMode: "auto_merge", deliveryTarget: "merged", autoMergeActorUserId: "member_test",
    continuationState: { phase: "ci_waiting", revision: 10, owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Waiting for CI", lastEventId: "seed:10", continuationCount: 0, lastSummaryHash: null, leadSessionRef: "lead_session", leadOutputArtifactId: "lead_plan", leadSummary: "Approved plan", planRevision: 1, developerExecutionId: "developer_original", developerSessionRef: "developer_session", worktreePath: "/tmp/forge_release_timeout_test", branchName: "forge/issue/release_timeout", targetBaseSha: base, resultCommit: head, resultTree: tree, dirtyState: "clean", deliveryArtifactId: "delivery_original", developerEvidenceArtifactId: "evidence_original", deliverySummary: "Verified delivery", developerOutcome: "completed", developerRecoveryStatus: "active", developerRecoverySummary: "Developer result claimed.", deliveryReviewId: "review_original", deliveryReviewOutcome: "approved", releaseId: "release_timeout", releaseRepository: "acme/forge", pullRequestNumber: 43, pullRequestUrl: "https://github.com/acme/forge/pull/43", expectedHeadSha: head, expectedHeadTree: tree, ciRunId: "ci_timeout", ciNextPollAt: null },
  };
  const queue = "release-merge-timeout";
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: queue, workflowsPath, activities: activities as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId: input.workflowId, taskQueue: queue, args: [input] });
    await timeoutSeen;
    const timedOut = projections.at(-1)!;
    expect(timedOut).toMatchObject({ phase: "delivery_blocked", targetBaseBlockerCode: "verification_timed_out" });
    expect(timedOut.allowedCommands).toContain("retry_forward_merge_verification");
    await handle.cancel();
  } finally {
    worker.shutdown();
    await workerRun;
  }
});
test("auto-merge rejection uses direct merge on the next sync", { timeout: 120_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const githubActions: string[] = [];
  let merged = false;
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => event.state,
    observeGithubPullRequest: async () => ({ exists: true, number: 42, url: "https://github.com/acme/forge/pull/42", state: merged ? "merged" as const : "open" as const, isDraft: false, headSha: head, baseSha: base, mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
    applyGithubPullRequestAction: async (input) => {
      githubActions.push(input.action);
      if (input.action === "enable_auto_merge") throw new Error("Auto merge is not allowed for this repository");
      merged = true;
    },
  };
  const workflowId = "workflow:auto_merge_unavailable";
  const input: IssueWorkflowInput = {
    workflowId,
    companyId: "company_test",
    projectId: "project_test",
    issueId: "auto_merge_unavailable",
    projectRevisionId: "revision_test",
    briefArtifactId: "brief_test",
    briefSha256: "0".repeat(64),
    imageArtifactIds: [],
    roleProfiles: { planner: "profile-planner", builder: "profile-builder" },
    supplementalReview: false,
    pullRequestMode: "auto_merge",
    deliveryTarget: "merged",
    autoMergeActorUserId: "member_test",
    continuationState: {
      phase: "manual_merge",
      revision: 10,
      owner: "lead",
      allowedCommands: ["cancel_issue"],
      pendingAction: "Merging",
      lastEventId: "seed:10",
      continuationCount: 0,
      lastSummaryHash: null,
      releaseRepository: "acme/forge",
      branchName: "forge/issue/auto_merge_unavailable",
      pullRequestNumber: 42,
      expectedHeadSha: head,
      expectedHeadTree: tree,
    },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: "auto-merge-unavailable", workflowsPath, activities: activities as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue: "auto-merge-unavailable", args: [input] });
    await expect(handle.result()).resolves.toMatchObject({ phase: "done" });
    expect(githubActions).toContain("enable_auto_merge");
    expect(githubActions.at(-1)).toBe("merge");
  } finally {
    worker.shutdown();
    await workerRun;
  }
});
