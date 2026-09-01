import { expect, test } from "vitest";

import { DeliveryReviewActivityResultSchema, DeveloperRepairActivityResultSchema, IssueWorkflowStateSchema, SafeSummarySchema, normalizeSafeSummary, toSafeSummary } from "../src/engine/issue-contracts.js";
import { ISSUE_PHASES, TERMINAL_PHASES } from "../src/issue-phases.js";
import { repairBlockedState, repairRequiredState, repairedDeliveryAwaitingFreshReviewState, reviewApprovedState, reviewBlockedState, reviewingDeliveryState } from "../src/engine/workflows.js";
import { finalReviewerTurn, freshDeliveryLineage, withWorktreeCommands } from "../src/engine/workflow/state-transitions.js";
import { assignWorkflowState, type IssueWorkflowContext } from "../src/engine/workflow/context.js";

const subject = { planRevision: 1, targetBaseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40), developerExecutionId: "developer_1", deliveryArtifactId: "artifact_delivery", developerEvidenceArtifactId: "artifact_evidence", leadSessionRef: "session_lead", developerSessionRef: "session_developer" };
const blockingFinding = { findingId: "finding_blocking", severity: "blocking" as const, rationale: "The controlled defect remains.", evidenceRef: "fixture", disposition: "open" as const, repairInstruction: "Fix the controlled defect." };

function state() {
  return IssueWorkflowStateSchema.parse({ workflowId: "workflow_1", companyId: "company_1", projectId: "project_1", issueId: "task_1", projectRevisionId: "revision_1", phase: "delivery_ready", revision: 10, owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Lead delivery review", lastEventId: "workflow_1:10", continuationCount: 0, lastSummaryHash: null, leadSessionRef: subject.leadSessionRef, leadOutputArtifactId: "artifact_plan", developerExecutionId: subject.developerExecutionId, developerSessionRef: subject.developerSessionRef, worktreePath: "/worktree", branchName: "forge/issue/task_1", targetBaseSha: subject.targetBaseSha, resultCommit: subject.subjectCommit, resultTree: subject.subjectTree, dirtyState: "clean", deliveryArtifactId: subject.deliveryArtifactId, developerEvidenceArtifactId: subject.developerEvidenceArtifactId, repairCycle: 0, releaseId: "release_1", expectedHeadSha: subject.subjectCommit, expectedHeadTree: subject.subjectTree, ciRunId: "ci_1", ciAttempt: 2, ciOutcome: "passed", finalReviewId: "final_review_1", finalReviewOutcome: "approved", acceptanceId: "acceptance_1", acceptedHeadSha: subject.subjectCommit, mergeOutcome: "open" });
}

test("state parsing always offers cancellation outside terminal phases", () => {
  for (const phase of ISSUE_PHASES) {
    const parsed = IssueWorkflowStateSchema.parse({ ...state(), phase, allowedCommands: [] });
    if (TERMINAL_PHASES.has(phase)) expect(parsed.allowedCommands).not.toContain("cancel_issue");
    else {
      expect(parsed.allowedCommands).toContain("cancel_issue");
      expect(parsed.allowedCommands).not.toEqual([]);
    }
  }
});

test("withWorktreeCommands offers safe worktree lifecycle commands", () => {
  const initial = state();
  expect(withWorktreeCommands({ ...initial, activeOperation: { commandId: "command_1", kind: "development", startedRevision: 10 } }).allowedCommands).not.toContain("delete_worktree");
  expect(withWorktreeCommands({ ...initial, activeOperation: { commandId: "command_1", kind: "development", startedRevision: 10 } }).allowedCommands).not.toContain("retry_target_base_reconciliation");
  expect(withWorktreeCommands(initial).allowedCommands).toContain("retry_target_base_reconciliation");
  expect(withWorktreeCommands({ ...initial, worktreeState: "cleaned" }).allowedCommands).toEqual(expect.arrayContaining(["recreate_worktree"]));
  expect(withWorktreeCommands({ ...initial, worktreeState: "cleaned" }).allowedCommands).not.toContain("delete_worktree");
  expect(withWorktreeCommands({ ...initial, phase: "done", worktreeState: "cleaned" }).allowedCommands).not.toContain("recreate_worktree");
  expect(withWorktreeCommands({ ...initial, phase: "cancelled", worktreeState: "present", activeOperation: null }).allowedCommands).toContain("delete_worktree");
});

test("accepts a sha-less plan blocker response receipt", () => {
  const parsed = IssueWorkflowStateSchema.parse({
    ...state(),
    phase: "planning",
    owner: "lead",
    allowedCommands: ["start_planning"],
    pendingAction: "Lead plan revision after blocker response",
    revision: 11,
    lastEventId: "workflow_1:11",
    planBlockerSubject: null,
    planBlockerResponseReceipt: {
      idempotencyKey: "blocker-response-1",
      responseId: "response_1",
      blockerSubjectHash: null,
    },
  });

  expect(parsed.planBlockerResponseReceipt?.blockerSubjectHash).toBeNull();
});

test("assigns final review to the Reviewer, with Planner fallback", () => {
  const context = { input: { roleProfiles: { planner: "planner-profile", reviewer: "reviewer-profile" } } } as IssueWorkflowContext;
  expect(finalReviewerTurn(context)).toEqual({ role: "reviewer", profileId: "reviewer-profile" });
  expect(finalReviewerTurn({ ...context, input: { ...context.input, roleProfiles: { planner: "planner-profile" } } })).toEqual({ role: "planner", profileId: "planner-profile" });
});

test("safe summaries are normalized before entering workflow state", () => {
  expect(toSafeSummary("  Review approved.\r\n  Ready to ship.  ")).toBe("Review approved. Ready to ship.");
  expect(toSafeSummary(" \r\n ")).toBe("(no details)");

  const longAscii = "Approved because the implementation matches the plan. ".repeat(10);
  const compactAscii = toSafeSummary(longAscii);
  expect(compactAscii.endsWith("…")).toBe(true);
  expect(new TextEncoder().encode(compactAscii).byteLength).toBeLessThanOrEqual(240);
  expect(SafeSummarySchema.parse(compactAscii)).toBe(compactAscii);

  const compactUnicode = toSafeSummary("✅".repeat(100));
  expect(new TextEncoder().encode(compactUnicode).byteLength).toBeLessThanOrEqual(240);
  expect(compactUnicode.endsWith("…")).toBe(true);
  expect(compactUnicode).not.toContain("�");
});

test("workflow summaries are truncated before state validation", () => {
  const longSummary = "blocked ".repeat(100);
  const parsed = IssueWorkflowStateSchema.parse({ ...state(), phase: "delivery_blocked", owner: "human", pendingAction: longSummary, targetBaseBlockerSummary: longSummary, blocker: { category: "agent_exhausted", summary: longSummary, unblockOwner: "human", actions: [{ command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidence: { artifactId: "artifact_evidence", sha256: "d".repeat(64), kind: "attention-evidence" }, createdAt: "2026-01-01T00:00:00.000Z", retry: null } });

  expect(normalizeSafeSummary(longSummary, 200).endsWith("…")).toBe(true);
  expect(parsed.pendingAction!.length).toBeLessThanOrEqual(200);
  expect(parsed.targetBaseBlockerSummary!.length).toBeLessThanOrEqual(200);
  expect(parsed.blocker?.summary.length).toBeLessThanOrEqual(200);
});

test("invalid workflow state assignments keep a revision-bumped valid state", () => {
  const previous = state();
  const assigned = assignWorkflowState(previous, () => IssueWorkflowStateSchema.parse({ ...previous, ciOwner: "not-an-owner" }));

  expect(assigned).toMatchObject({ revision: previous.revision + 1, lastEventId: `${previous.workflowId}:${previous.revision + 1}` });
  expect(assigned.ciOwner).toBe(previous.ciOwner);
});

test("delivery workflow constructors keep blockers retryable and approvals exact", () => {
  const initial = state();
  const reviewing = reviewingDeliveryState(initial);
  expect(reviewing).toMatchObject({ phase: "reviewing_delivery", owner: "lead", allowedCommands: ["cancel_issue"] });

  const blocked = reviewBlockedState(reviewing, { attemptId: "review_attempt_1", code: "process-failed", summary: "The review process did not complete.", evidenceArtifactId: "artifact_review_evidence" });
  expect(blocked.pendingAction).toBe("The review process did not complete.");
  expect(blocked).toMatchObject({ phase: "delivery_blocked", owner: "human", allowedCommands: ["review_delivery", "cancel_issue"], deliveryReviewBlockerCode: "process-failed", deliveryReviewAttemptId: "review_attempt_1" });

  const blocking = DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId: "review_attempt_2", correctionAttempts: 1, subject, review: { reviewId: "review_1", leadExecutionId: "agent_review_1", leadSessionRef: subject.leadSessionRef, opinionArtifactId: "artifact_opinion", evidenceArtifactId: "artifact_review_evidence", opinion: "blocking", summary: "A repair is required.", repairPlan: "Fix the controlled defect.", findings: [blockingFinding], supersedesReviewId: null } });
  if (blocking.outcome !== "completed") throw new Error("Expected a completed review fixture");
  const repairRequired = repairRequiredState(blocked, blocking, 2);
  expect(repairRequired).toMatchObject({ phase: "repair_required", owner: "lead", allowedCommands: ["record_delivery_decision", "repair_delivery", "cancel_issue"], deliveryReviewId: "review_1" });

  const repairLimitReached = repairRequiredState(IssueWorkflowStateSchema.parse({ ...blocked, repairCycle: 2 }), blocking, 2);
  expect(repairLimitReached).toMatchObject({ phase: "delivery_blocked", pendingAction: "Review problems are not fixed", blocker: { summary: expect.stringMatching(/^Review found 1 blocking problem\./) } });

  const repairBlocked = DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId: "repair_1", cycle: 1, reviewId: "review_1", subject, code: "worktree-unsafe", summary: "The worktree was not clean.", evidenceArtifactId: "artifact_repair_evidence", developerExecutionId: subject.developerExecutionId, developerSessionRef: subject.developerSessionRef, worktreePath: "/worktree", branchName: "forge/issue/task_1", resultCommit: subject.subjectCommit, resultTree: subject.subjectTree, dirtyState: "dirty" });
  if (repairBlocked.outcome !== "blocked") throw new Error("Expected a blocked repair fixture");
  const blockedRepair = repairBlockedState(repairRequired, repairBlocked, 2);
  expect(blockedRepair).toMatchObject({ phase: "delivery_blocked", allowedCommands: ["record_delivery_decision", "repair_delivery", "retry_development", "cancel_issue"], deliveryRepairBlockerCode: "worktree-unsafe", repairCycle: 1 });

  const retryableRepair = DeveloperRepairActivityResultSchema.parse({ outcome: "blocked", repairAttemptId: "repair_retryable", cycle: 1, reviewId: "review_1", subject, code: "process-failed", summary: "The repair process did not complete.", evidenceArtifactId: "artifact_repair_evidence", developerExecutionId: subject.developerExecutionId, developerSessionRef: subject.developerSessionRef, worktreePath: "/worktree", branchName: "forge/issue/task_1", resultCommit: null, resultTree: null, dirtyState: null });
  if (retryableRepair.outcome !== "blocked") throw new Error("Expected a retryable blocked repair fixture");
  const retryableState = repairBlockedState(repairRequired, retryableRepair, 2);
  expect(retryableState).toMatchObject({ phase: "delivery_blocked", allowedCommands: ["record_delivery_decision", "repair_delivery", "retry_development", "cancel_issue"], developerExecutionId: subject.developerExecutionId, developerSessionRef: subject.developerSessionRef, worktreePath: "/worktree", branchName: "forge/issue/task_1", targetBaseSha: subject.targetBaseSha, resultCommit: subject.subjectCommit, resultTree: subject.subjectTree, dirtyState: "clean", deliveryArtifactId: subject.deliveryArtifactId, developerEvidenceArtifactId: subject.developerEvidenceArtifactId, deliveryRepairAttemptId: "repair_retryable" });

  const repaired = DeveloperRepairActivityResultSchema.parse({ outcome: "completed", repairAttemptId: "repair_2", cycle: 2, reviewId: "review_1", subject, developerExecutionId: "developer_2", developerSessionRef: subject.developerSessionRef, worktreePath: "/worktree", branchName: "forge/issue/task_1", resultCommit: "d".repeat(40), resultTree: "e".repeat(40), dirtyState: "clean", deliveryArtifactId: "artifact_repaired", evidenceArtifactId: "artifact_repair_evidence", summary: "The defect was repaired." });
  if (repaired.outcome !== "completed") throw new Error("Expected a completed repair fixture");
  const awaitingReview = repairedDeliveryAwaitingFreshReviewState(repairRequired, repaired);
  expect(awaitingReview).toMatchObject({ phase: "delivery_ready", allowedCommands: ["review_delivery", "cancel_issue"], deliveryReviewId: null, deliveryReviewSupersedesId: "review_1", releaseId: null, ciRunId: null, finalReviewId: null, acceptanceId: null, mergeOutcome: null });

  const approved = DeliveryReviewActivityResultSchema.parse({ outcome: "completed", attemptId: "review_attempt_3", correctionAttempts: 0, subject: { ...subject, subjectCommit: repaired.resultCommit, subjectTree: repaired.resultTree, developerExecutionId: repaired.developerExecutionId, deliveryArtifactId: repaired.deliveryArtifactId, developerEvidenceArtifactId: repaired.evidenceArtifactId }, review: { reviewId: "review_2", leadExecutionId: "agent_review_2", leadSessionRef: subject.leadSessionRef, opinionArtifactId: "artifact_opinion_2", evidenceArtifactId: "artifact_review_evidence_2", opinion: "approved", summary: "The repaired delivery is approved.", repairPlan: null, findings: [], supersedesReviewId: "review_1" } });
  if (approved.outcome !== "completed") throw new Error("Expected a completed approval fixture");
  expect(reviewApprovedState(awaitingReview, approved)).toMatchObject({ phase: "delivery_reviewed", owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], deliveryReviewId: "review_2", deliveryReviewSupersedesId: "review_1" });
});

test("an approved recovered review outranks stale no-progress exhaustion", () => {
  const approved = DeliveryReviewActivityResultSchema.parse({
    outcome: "completed",
    attemptId: "review_attempt_recovered",
    correctionAttempts: 0,
    subject,
    review: {
      reviewId: "review_recovered",
      leadExecutionId: "agent_review_recovered",
      leadSessionRef: subject.leadSessionRef,
      opinionArtifactId: "artifact_opinion_recovered",
      evidenceArtifactId: "artifact_review_evidence_recovered",
      opinion: "approved",
      summary: "The exact recovered delivery is approved.",
      findings: [],
      supersedesReviewId: null,
    },
  });
  if (approved.outcome !== "completed") throw new Error("Expected a completed approval fixture");
  const repeated = IssueWorkflowStateSchema.parse({
    ...state(),
    phase: "delivery_blocked",
    owner: "human",
    allowedCommands: ["retry_development", "cancel_issue"],
    pendingAction: "Needs your call",
    repairProgress: {
      signature: "review|||",
      commit: subject.subjectCommit,
      diagnosticHash: null,
      repeats: 3,
    },
  });

  expect(repairRequiredState(repeated, approved, 2)).toMatchObject({
    phase: "delivery_reviewed",
    owner: "human",
    allowedCommands: ["publish_draft", "cancel_issue"],
    pendingAction: "Opening the pull request",
    blocker: null,
    deliveryReviewId: "review_recovered",
    deliveryReviewOutcome: "approved",
  });
});

test("a new implementation starts a fresh delivery-review lineage without changing repair lineage", () => {
  const repaired = IssueWorkflowStateSchema.parse({
    ...state(),
    developerTurnKind: "repair",
    deliveryReviewSupersedesId: "review_blocking",
    deliveryRepairAttemptId: "repair_completed",
    repairCycle: 1,
    deliveryReviewId: "review_current",
    deliveryReviewOutcome: "blocking",
    deliveryReviewSummary: "Repair this finding.",
    deliveryBlockingFindings: [blockingFinding],
    deliveryRepairPlan: "Fix it.",
    deliveryRepairPlanArtifactId: "artifact_repair_plan",
    deliveryRepairAuthority: "delivery_review",
  });

  expect(repaired).toMatchObject({ developerTurnKind: "repair", deliveryReviewSupersedesId: "review_blocking", deliveryRepairAttemptId: "repair_completed", repairCycle: 1 });
  expect(IssueWorkflowStateSchema.parse({ ...repaired, ...freshDeliveryLineage(), developerTurnKind: "implementation" })).toMatchObject({
    developerTurnKind: "implementation",
    deliveryReviewSupersedesId: null,
    deliveryRepairAttemptId: null,
    repairCycle: 0,
    deliveryReviewId: null,
    deliveryReviewOutcome: null,
    deliveryReviewSummary: null,
    deliveryBlockingFindings: [],
    deliveryRepairPlan: null,
    deliveryRepairPlanArtifactId: null,
    deliveryRepairAuthority: null,
  });
});
