import { expect, test } from "vitest";

import { issueStateQuery } from "../src/temporal/workflows.js";
import { issueUpdates } from "../src/temporal/issue-updates.js";

// FROZEN: these names are pinned by persisted Temporal workflow histories and live
// clients. If this test fails, the change breaks replay — revert it; never edit this list.
const FROZEN_UPDATE_NAMES = [
  "acceptDelivery", "approvePlan", "cancelDevelopment", "cancelIssue", "continueWork",
  "finalReview", "publishDraft", "reconcileAcceptance", "reconcileCI", "reconcileMerge",
  "recordDeliveryDecision", "recordProgress", "rejectPlan", "repairCI", "repairDelivery",
  "requestDeliveryChanges", "requestPlanRevision", "requestSupplementalReview",
  "resolveDecisionBlocker", "resolveMergeConflict", "respondPlanBlocker", "retryCapacity", "retryDevelopment",
  "retryForwardMergeVerification", "retryTargetBaseReconciliation", "reviewDelivery", "revisePlan",
  "startDevelopment", "startPlanning", "verifyDeveloperOwnership",
];

test("issue workflow update names are frozen", () => {
  const actual = Object.values(issueUpdates).map((update) => update.name).sort();
  expect(actual).toEqual(FROZEN_UPDATE_NAMES);
  expect(issueStateQuery.name).toBe("issueState");
});
