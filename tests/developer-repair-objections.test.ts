import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { DeveloperRepairActivityResultSchema, IssueWorkflowStateSchema } from "../src/engine/issue-contracts.js";
import { repairedDeliveryAwaitingFreshReviewState } from "../src/engine/workflows.js";

test("an objection-only repair routes to arbitration without using a repair cycle", () => {
  const subject = { planRevision: 1, targetBaseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40), developerExecutionId: "developer_1", deliveryArtifactId: "delivery_1", developerEvidenceArtifactId: "evidence_1", leadSessionRef: "lead_1", developerSessionRef: "builder_1" };
  const state = IssueWorkflowStateSchema.parse({ workflowId: "workflow_1", companyId: "company_1", projectId: "project_1", issueId: "task_1", projectRevisionId: "revision_1", briefArtifactId: "brief_1", briefSha256: "d".repeat(64), imageArtifactIds: [], requestHash: "e".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2, revision: 4, ...at("repair_required"), owner: "lead", allowedCommands: ["repair_delivery", "cancel_issue"], pendingAction: "The Builder fixes the review findings", lastEventId: "workflow_1:4", continuationCount: 0, lastSummaryHash: null, repairCycle: 1, deliveryReviewId: "review_1", deliveryArtifactId: subject.deliveryArtifactId, developerEvidenceArtifactId: subject.developerEvidenceArtifactId });
  const result = DeveloperRepairActivityResultSchema.parse({ outcome: "completed", repairAttemptId: "repair_1", cycle: 2, reviewId: "review_1", subject, developerExecutionId: "developer_2", developerSessionRef: subject.developerSessionRef, worktreePath: "/worktree", branchName: "forge/task", resultCommit: subject.subjectCommit, resultTree: subject.subjectTree, dirtyState: "clean", deliveryArtifactId: "repair_delivery_1", evidenceArtifactId: "repair_evidence_1", summary: "The Builder rejects the finding.", objections: [{ findingId: "finding_1", reason: "The change would break the approved plan." }] });
  if (result.outcome !== "completed") throw new Error("Expected a completed repair.");

  const next = repairedDeliveryAwaitingFreshReviewState(state, result);

  expect(next).toMatchObject({ ...at("review_arbitration"), owner: "lead", allowedCommands: ["cancel_issue"], repairCycle: 1, arbitrationCount: 1 });
});
