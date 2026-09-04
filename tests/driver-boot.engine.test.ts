import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { IssueContinuationStateSchema, type IssueActivities, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { executeIssueCommand } from "../src/engine/service.js";
import { STEP_TABLE } from "../src/engine/workflow/step-table.js";
import { createEngineHarness, engineFixture } from "./helpers/engine-harness.js";

function provenWorktree(commit = engineFixture.commit, tree = engineFixture.tree) {
  return { present: true, owned: true, dirtyFileCount: 0, branch: "forge/issue/driver-boot", activeExecution: false, revision: { proven: true, head: commit, headTree: tree, branch: "forge/issue/driver-boot", clean: true } };
}

function deliveryReviewState(workflowId: string) {
  return IssueContinuationStateSchema.parse({
    ...at("reviewing_delivery"),
    revision: 7,
    owner: "lead",
    allowedCommands: [],
    pendingAction: "The Planner reviews the delivery",
    leadSessionRef: "lead-session",
    leadOutputArtifactId: "plan-artifact",
    developerExecutionId: "developer-execution",
    developerSessionRef: "developer-session",
    branchName: "forge/issue/driver-boot",
    targetBaseSha: engineFixture.base,
    resultCommit: engineFixture.commit,
    resultTree: engineFixture.tree,
    expectedHeadSha: engineFixture.commit,
    expectedHeadTree: engineFixture.tree,
    dirtyState: "clean",
    deliveryArtifactId: "delivery-artifact",
    developerEvidenceArtifactId: "developer-evidence",
    deliveryReviewId: "delivery-review",
    deliveryReviewOutcome: "approved",
    deliveryReviewSummary: "Approved",
    deliveryReviewArtifact: { artifactId: "review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" },
    planRevision: 1,
    continuationCount: 0,
    lastSummaryHash: "a".repeat(64),
    lastEventId: `${workflowId}:7`,
  });
}

function ciRepairPlanningState(workflowId: string) {
  return IssueContinuationStateSchema.parse({
    ...at("ci_repair_planning"),
    revision: 7,
    owner: "lead",
    allowedCommands: [],
    pendingAction: "The Builder starts the CI repair",
    leadSessionRef: "lead-session",
    developerExecutionId: "developer-execution",
    developerSessionRef: "developer-session",
    branchName: "forge/issue/driver-boot",
    targetBaseSha: engineFixture.base,
    resultCommit: engineFixture.commit,
    resultTree: engineFixture.tree,
    ciRunId: "ci-run",
    ciAttemptId: "ci-attempt",
    ciEvidenceArtifactId: "ci-evidence",
    ciRepairPlanId: "ci-repair-plan",
    ciRepairPlanArtifactId: "ci-repair-plan-artifact",
    ciRepairPlanEvidenceArtifactId: "ci-repair-plan-evidence",
    ciRepairPlanSummary: "Repair CI",
    ciRepairLeadExecutionId: "ci-repair-lead",
    ciRepairLeadSessionRef: "ci-repair-session",
    planRevision: 1,
    continuationCount: 0,
    lastSummaryHash: "a".repeat(64),
    lastEventId: `${workflowId}:7`,
  });
}

test("boot claims a completed approved delivery review before publishing without another review prompt", async () => {
  const projected: IssueWorkflowState[] = [];
  const activities: Partial<IssueActivities> = {
    inspectTaskWorktree: async () => provenWorktree(),
    readHerdrTurn: async () => ({ type: "owner.done", outcome: "approved" }),
    projectIssueState: async (event) => {
      projected.push(event.state);
      return event.state;
    },
    reviewDelivery: async () => {
      throw new Error("completed review must not prompt again");
    },
    pushDeliveryBranch: async () => ({ repository: "acme/forge", branchName: "forge/issue/driver-boot", commitSha: engineFixture.commit }),
    publishRelease: async () => ({ outcome: "blocked", repository: "acme/forge", branchName: "forge/issue/driver-boot", headSha: engineFixture.commit, headTree: engineFixture.tree, reused: false, attempt: 1, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, code: "provider-rate-limited", summary: "GitHub rate limited", retryAt: "2026-08-29T00:01:00.000Z" }),
  };
  const harness = await createEngineHarness(activities);
  const issueId = "driver-boot-review";
  harness.seedTask(issueId);
  try {
    await harness.startContinuation(issueId, deliveryReviewState(harness.workflowId(issueId)));
    const state = await harness.settle(harness.workflowId(issueId), (value) => value.step === "releasing");
    expect(state.step).toBe("releasing");
    expect(projected.map((value) => value.step)).toContain("delivery_reviewed");
    expect(harness.calls.get("reviewDelivery") ?? 0).toBe(0);
  } finally {
    await harness.stop();
  }
});

test("boot claims a completed CI repair plan and starts its repair", async () => {
  let reads = 0;
  const activities: Partial<IssueActivities> = {
    inspectTaskWorktree: async () => provenWorktree(),
    readHerdrTurn: async (input) => input.promptKind === "ci-repair-plan" && reads++ === 0 ? { type: "owner.done" } : { type: "owner.live" },
    findCiRepairPriorDelivery: async () => ({ developerExecutionId: "developer-execution", developerSessionRef: "developer-session", worktreePath: "/tmp/worktree" }),
    runCiRepair: async () => ({ outcome: "completed", repairId: "ci-repair", developerExecutionId: "ci-repair-developer", developerSessionRef: "ci-repair-developer-session", branchName: "forge/issue/driver-boot", priorCommit: engineFixture.commit, priorTree: engineFixture.tree, resultCommit: engineFixture.commit, resultTree: engineFixture.tree, deliveryArtifactId: "ci-repair-delivery", evidenceArtifactId: "ci-repair-evidence", summary: "Repair complete" }),
    reviewDelivery: async (input) => ({ outcome: "completed", attemptId: "ci-repair-review-attempt", correctionAttempts: 0, subject: input.subject, review: { reviewId: "ci-repair-review", leadExecutionId: "ci-repair-review-lead", leadSessionRef: "ci-repair-review-session", opinionArtifactId: "ci-repair-review-opinion", evidenceArtifactId: "ci-repair-review-evidence", opinion: "approved", summary: "Approved", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "ci-repair-review-artifact", companyId: engineFixture.companyId, kind: "delivery-review", sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" } } }),
    pushDeliveryBranch: async () => ({ repository: "acme/forge", branchName: "forge/issue/driver-boot", commitSha: engineFixture.commit }),
    publishRelease: async () => ({ outcome: "blocked", repository: "acme/forge", branchName: "forge/issue/driver-boot", headSha: engineFixture.commit, headTree: engineFixture.tree, reused: false, attempt: 1, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, code: "provider-rate-limited", summary: "GitHub rate limited", retryAt: "2026-08-29T00:01:00.000Z" }),
  };
  const harness = await createEngineHarness(activities);
  const issueId = "driver-boot-ci";
  harness.seedTask(issueId);
  try {
    await harness.startContinuation(issueId, ciRepairPlanningState(harness.workflowId(issueId)));
    await harness.settle(harness.workflowId(issueId), (value) => value.step === "releasing");
    expect(harness.calls.get("planCiRepair") ?? 0).toBe(0);
  } finally {
    await harness.stop();
  }
});

test("boot waits for a live Herdr turn without prompting", async () => {
  const harness = await createEngineHarness({ inspectTaskWorktree: async () => provenWorktree(), readHerdrTurn: async () => ({ type: "owner.live" }) });
  const issueId = "driver-boot-live";
  harness.seedTask(issueId);
  try {
    await harness.startContinuation(issueId, deliveryReviewState(harness.workflowId(issueId)));
    const state = await harness.settle(harness.workflowId(issueId), (value) => value.step === "reviewing_delivery");
    expect(state.step).toBe("reviewing_delivery");
    expect(harness.calls.get("reviewDelivery") ?? 0).toBe(0);
  } finally {
    await harness.stop();
  }
});

test("boot prompts once when no Herdr turn exists, and a second boot is a no-op", async () => {
  let prompts = 0;
  const harness = await createEngineHarness({
    inspectTaskWorktree: async () => provenWorktree(),
    readHerdrTurn: async () => ({ type: "owner.absent" }),
    reviewDelivery: async (input) => {
      prompts += 1;
      return { outcome: "completed" as const, attemptId: "replacement-attempt", correctionAttempts: 0, subject: input.subject, review: { reviewId: "replacement-review", leadExecutionId: "replacement-lead", leadSessionRef: "replacement-session", opinionArtifactId: "replacement-opinion", evidenceArtifactId: "replacement-evidence", opinion: "approved" as const, summary: "Approved", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "replacement-review-artifact", companyId: engineFixture.companyId, kind: "delivery-review" as const, sha256: engineFixture.sha256, byteSize: 1, mimeType: "application/json" } } };
    },
    pushDeliveryBranch: async () => ({ repository: "acme/forge", branchName: "forge/issue/driver-boot", commitSha: engineFixture.commit }),
    publishRelease: async () => ({ outcome: "blocked" as const, repository: "acme/forge", branchName: "forge/issue/driver-boot", headSha: engineFixture.commit, headTree: engineFixture.tree, reused: false, attempt: 1, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false, code: "provider-rate-limited" as const, summary: "GitHub rate limited", retryAt: "2026-08-29T00:01:00.000Z" }),
  });
  const issueId = "driver-boot-absent";
  harness.seedTask(issueId);
  const workflowId = harness.workflowId(issueId);
  try {
    const unclaimedReview = { ...deliveryReviewState(workflowId) };
    delete unclaimedReview.deliveryReviewArtifact;
    await harness.startContinuation(issueId, { ...unclaimedReview, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null });
    await harness.settle(workflowId, (value) => value.step === "releasing");
    expect(prompts).toBe(1);
    const first = harness.engine.run(workflowId).state.processedCommandIds?.find((value) => value.startsWith(`${workflowId}:driver:reviewing_delivery:`));
    expect(first).toMatch(new RegExp(`^${workflowId}:driver:reviewing_delivery:\\d+:owner\\.absent$`));
    await harness.restart();
    expect(prompts).toBe(1);
  } finally {
    await harness.stop();
  }
});

test("a moved delivery head reconciles before Forge reads or publishes the completed review", async () => {
  const movedCommit = "d".repeat(40);
  const movedTree = "e".repeat(40);
  let reads = 0;
  const harness = await createEngineHarness({
    inspectTaskWorktree: async () => ({ ...provenWorktree(movedCommit, movedTree), revision: { ...provenWorktree(movedCommit, movedTree).revision, proven: false } }),
    readHerdrTurn: async () => ({ type: "owner.live" }),
    reconcileTargetBase: async () => new Promise<never>(() => {}),
    publishRelease: async () => { reads += 1; throw new Error("must not publish a moved delivery"); },
  });
  const issueId = "driver-boot-moved-head";
  harness.seedTask(issueId);
  try {
    await harness.startContinuation(issueId, { ...deliveryReviewState(harness.workflowId(issueId)), ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the delivery" });
    for (let attempt = 0; attempt < 100 && !harness.calls.get("reconcileTargetBase"); attempt += 1) await Promise.resolve();
    expect(harness.calls.get("reconcileTargetBase")).toBe(1);
    expect(reads).toBe(0);
  } finally {
    await harness.stop();
  }
});

test("a guard-refused driver command leaves its revision available to the next API command", async () => {
  const original = STEP_TABLE.delivery_ready.on.done;
  STEP_TABLE.delivery_ready.on.done = { command: "publish_draft" };
  const harness = await createEngineHarness({ inspectTaskWorktree: async () => provenWorktree(), readHerdrTurn: async () => ({ type: "owner.done", outcome: "approved" }) });
  const issueId = "driver-boot-refused";
  harness.seedTask(issueId);
  const workflowId = harness.workflowId(issueId);
  try {
    await harness.startContinuation(issueId, { ...deliveryReviewState(workflowId), ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the delivery" });
    const before = harness.engine.run(workflowId).state;
    const waiting = await harness.settle(workflowId, (state) => state.revision === before.revision && state.step === "delivery_ready");
    expect(waiting.processedCommandIds ?? []).not.toContain(`${workflowId}:driver:delivery_ready:${before.revision}:owner.done`);
    await expect(executeIssueCommand(harness.config, workflowId, "cancel_issue", { expectedRevision: before.revision, actorUserId: engineFixture.actorUserId, commandId: "cancel-after-driver-refusal" })).resolves.toMatchObject({ phase: "cancelled" });
  } finally {
    STEP_TABLE.delivery_ready.on.done = original;
    await harness.stop();
  }
});
