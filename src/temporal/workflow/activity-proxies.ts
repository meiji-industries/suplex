import { ActivityCancellationType } from "@temporalio/common";
import { proxyActivities } from "@temporalio/workflow";

import type { ProbeActivities } from "../contracts.js";
import type { DeliveryBlockerActivities, IssueActivities } from "../issue-contracts.js";

// Bookkeeping/DB activities: bounded retries so a failure surfaces as an
// ActivityFailure -> `failed` state instead of retrying silently forever.
// Only PlanGovernanceConflict is listed here: it's always a deterministic
// idempotency-key reuse, unlike "SqliteError" (a bare class name that also
// covers transient FK/lock errors during concurrent projection writes, which
// must keep retrying). The deterministic UNIQUE-constraint case is instead
// converted to ApplicationFailure.nonRetryable inside the activities
// themselves (see asNonRetryableApplicationFailure), which bypasses this
// policy entirely regardless of maximumAttempts.
const BOOKKEEPING_RETRY_POLICY = {
  maximumAttempts: 5,
  initialInterval: "1 second",
  maximumInterval: "15 seconds",
  nonRetryableErrorTypes: ["PlanGovernanceConflict"],
};

export const { recordProbeStarted } = proxyActivities<ProbeActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { projectIssueState: projectIssueStateActivity } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

const EXTERNAL_AGENT_RETRY_POLICY = {
  maximumAttempts: 3,
  initialInterval: "1 second",
  maximumInterval: "30 seconds",
  nonRetryableErrorTypes: ["rate-limited"],
};

export const { runLeadPlanning } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { runSupplementalReview, consolidateLeadPlan } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { runDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  scheduleToCloseTimeout: "65 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { runDeveloperExecutionSupervised, runDeveloperRepairSupervised, resolveMergeConflictSupervised } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  scheduleToCloseTimeout: "65 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 100, initialInterval: "1 second", maximumInterval: "30 seconds", nonRetryableErrorTypes: ["developer-ownership-ambiguous", "developer-result-claim-conflict"] },
});

export const { cancelDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { findActiveDeveloperExecution } = proxyActivities<IssueActivities>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "5 seconds" } });

export const { observeDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { reconcileDeveloperDeliveryEvidence } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  scheduleToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "10 seconds" },
});

export const { cancelCapacityExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { recordPlanDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { authorizeFinalPlan } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { authorizePlanRevision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { preparePlanRevision } = proxyActivities<IssueActivities>({ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 1 } });
export const { createSuccessor } = proxyActivities<IssueActivities>({ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "30 seconds" } });

export const { recordPlanBlockerResponse } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { recordDecisionBlockerResolution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { reviewDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { recordDeliveryBlocker } = proxyActivities<DeliveryBlockerActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { runDeveloperRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  scheduleToCloseTimeout: "65 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { recordDeliveryDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { publishRelease } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 5, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});

export const { reconcileTargetBase } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});

export const { planMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { resolveMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  scheduleToCloseTimeout: "65 minutes",
  heartbeatTimeout: "15 seconds",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { reconcileCi } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export const { planCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  retry: { maximumAttempts: 1 },
});

export const { runCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  scheduleToCloseTimeout: "65 minutes",
  retry: { maximumAttempts: 1 },
});

export const { finalReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { planDeliveryRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  scheduleToCloseTimeout: "25 minutes",
  retry: { maximumAttempts: 1 },
});

export const { acceptDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

export const { reconcileAcceptance } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export const { reconcileMerge } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export const { requestCapacity, tryAcquireCapacity, inspectCapacity, requeueCapacity, cancelCapacity, finalizeCapacity, rateLimitCapacity, reconcileCapacityOwnership } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "15 seconds" },
});
