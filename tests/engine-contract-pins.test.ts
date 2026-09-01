import { expect, test } from "vitest";

import { issueStateQuery } from "../src/engine/workflows.js";
import { issueUpdates } from "../src/engine/issue-updates.js";

// FROZEN: these names are the durable command registry persisted in SQLite.
const FROZEN_UPDATE_NAMES = [
  "acceptDelivery", "approvePlan", "cancelDevelopment", "cancelIssue", "continueWork", "deleteWorktree",
  "finalReview", "integrateRemoteConflict", "publishDraft", "reconcileAcceptance", "reconcileCI", "reconcileMerge",
  "recordDeliveryDecision", "recordProgress", "recreateWorktree", "rejectPlan", "repairCI", "repairDelivery", "reportWorktreeMissing",
  "requestDeliveryChanges", "requestPlanRevision", "requestSupplementalReview",
  "resolveDecisionBlocker", "resolveMergeConflict", "respondPlanBlocker", "resumePreservedWork", "retryCapacity", "retryDevelopment",
  "retryForwardMergeVerification", "retryTargetBaseReconciliation", "reviewDelivery", "revisePlan",
  "startDevelopment", "startPlanning", "tellPlanner", "verifyDeveloperOwnership",
];

test("issue workflow update names are frozen", () => {
  const actual = Object.values(issueUpdates).sort();
  expect(actual).toEqual(FROZEN_UPDATE_NAMES);
  expect(issueStateQuery).toBe("issueState");
});
