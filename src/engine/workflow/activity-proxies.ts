import { runExecution, type ActivityCallOptions } from "../registry.js";

type RetryPolicy = NonNullable<ActivityCallOptions["retry"]>;
function proxyActivities<T extends object>(options: ActivityCallOptions): T {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return (...args: unknown[]) => runExecution.current().activity(property, args, options);
    },
  }) as T;
}

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
const BOOKKEEPING_RETRY_POLICY: RetryPolicy = {
  maximumAttempts: 5,
  initialInterval: "1 second",
  maximumInterval: "15 seconds",
  nonRetryableErrorTypes: ["PlanGovernanceConflict"],
};

export const { projectIssueState: projectIssueStateActivity } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});
export const { inspectTaskWorktree, cleanupTaskWorktree, recreateTaskWorktree } = proxyActivities<IssueActivities>({ startToCloseTimeout: "2 minutes", retry: BOOKKEEPING_RETRY_POLICY });
const EXTERNAL_AGENT_RETRY_POLICY: RetryPolicy = {
  maximumAttempts: 3,
  initialInterval: "1 second",
  maximumInterval: "30 seconds",
  nonRetryableErrorTypes: ["rate-limited"],
};
const SUPERVISED_DEVELOPER_RETRY_POLICY: RetryPolicy = {
  maximumAttempts: 3,
  initialInterval: "1 second",
  maximumInterval: "30 seconds",
  nonRetryableErrorTypes: ["developer-ownership-ambiguous", "developer-result-claim-conflict", "developer-scope-mismatch"],
};
export const { runLeadPlanning } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const herdrLeadActivityCallOptions: ActivityCallOptions = { startToCloseTimeout: "20 minutes", retry: EXTERNAL_AGENT_RETRY_POLICY };
export const { runLeadPlanning: runHerdrLeadPlanning } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

export const { runSupplementalReview, consolidateLeadPlan } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
export const { runSupplementalReview: runHerdrSupplementalReview, consolidateLeadPlan: consolidateHerdrLeadPlan } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

export const { runDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
const herdrDeveloperActivityCallOptions: ActivityCallOptions = { startToCloseTimeout: "60 minutes", retry: EXTERNAL_AGENT_RETRY_POLICY };
export const { runDeveloperExecution: runHerdrDeveloperExecution } = proxyActivities<IssueActivities>(herdrDeveloperActivityCallOptions);

export const { runDeveloperExecutionSupervised, runDeveloperRepairSupervised, resolveMergeConflictSupervised } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: SUPERVISED_DEVELOPER_RETRY_POLICY,
});

const herdrSupervisedDeveloperActivityCallOptions: ActivityCallOptions = {
  ...herdrDeveloperActivityCallOptions,
  retry: SUPERVISED_DEVELOPER_RETRY_POLICY,
};

export const { runDeveloperExecutionSupervised: runHerdrDeveloperExecutionSupervised, runDeveloperRepairSupervised: runHerdrDeveloperRepairSupervised, resolveMergeConflictSupervised: resolveHerdrMergeConflictSupervised } = proxyActivities<IssueActivities>(herdrSupervisedDeveloperActivityCallOptions);

export const { cancelDeveloperExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { findActiveDeveloperExecution, findRecoverableDeveloperExecution } = proxyActivities<IssueActivities>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "5 seconds" } });

export const { cancelCapacityExecution } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});



export const { recordPlanDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { recordPlannerNote } = proxyActivities<IssueActivities>({
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
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});
export const { arbitrateReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { findCompletedDeliveryReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { recoverRevalidatedDeliveryReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "5 seconds" },
});

export const { reviewDelivery: reviewHerdrDelivery } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

export const { recordDeliveryBlocker } = proxyActivities<DeliveryBlockerActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { runDeveloperRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { runDeveloperRepair: runHerdrDeveloperRepair } = proxyActivities<IssueActivities>(herdrDeveloperActivityCallOptions);

export const { recordDeliveryDecision } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export const { pushDeliveryBranch } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { publishRelease } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 5, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});

export const { adoptPullRequestRelease } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: BOOKKEEPING_RETRY_POLICY,
});

export const { loadTaskSourcePullRequest, observeGithubPullRequest, applyGithubPullRequestAction } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "15 seconds" },
});

export const { reconcileTargetBase } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});

export const { planMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { planMergeConflict: planHerdrMergeConflict } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

export const { resolveMergeConflict } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { resolveMergeConflict: resolveHerdrMergeConflict } = proxyActivities<IssueActivities>(herdrDeveloperActivityCallOptions);

export function agentActivities(herdrExecutionSubstrateEnabled: boolean) {
  if (!herdrExecutionSubstrateEnabled) {
    return { runLeadPlanning, runSupplementalReview, consolidateLeadPlan, runDeveloperExecution, runDeveloperExecutionSupervised, runDeveloperRepairSupervised, resolveMergeConflictSupervised, reviewDelivery, runDeveloperRepair, planMergeConflict, resolveMergeConflict, finalReview, planDeliveryRepair, planCiRepair, runCiRepair };
  }
  return { runLeadPlanning: runHerdrLeadPlanning, runSupplementalReview: runHerdrSupplementalReview, consolidateLeadPlan: consolidateHerdrLeadPlan, runDeveloperExecution: runHerdrDeveloperExecution, runDeveloperExecutionSupervised: runHerdrDeveloperExecutionSupervised, runDeveloperRepairSupervised: runHerdrDeveloperRepairSupervised, resolveMergeConflictSupervised: resolveHerdrMergeConflictSupervised, reviewDelivery: reviewHerdrDelivery, runDeveloperRepair: runHerdrDeveloperRepair, planMergeConflict: planHerdrMergeConflict, resolveMergeConflict: resolveHerdrMergeConflict, finalReview: finalHerdrReview, planDeliveryRepair: planHerdrDeliveryRepair, planCiRepair: planHerdrCiRepair, runCiRepair: runHerdrCiRepair };
}

export const { reconcileCi } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export const { rerunCi } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export const { findCiRepairPriorDelivery } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3, initialInterval: "1 second", maximumInterval: "5 seconds" },
});

export const { planCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});

export const { planCiRepair: planHerdrCiRepair } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

export const { runCiRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "60 minutes",
  retry: SUPERVISED_DEVELOPER_RETRY_POLICY,
});

export const { runCiRepair: runHerdrCiRepair } = proxyActivities<IssueActivities>(herdrSupervisedDeveloperActivityCallOptions);

export const { updateCiFromBase } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds", maximumInterval: "1 minute" },
});

export const { finalReview } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: EXTERNAL_AGENT_RETRY_POLICY,
});

export const { finalReview: finalHerdrReview } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

export const { planDeliveryRepair } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});

export const { planDeliveryRepair: planHerdrDeliveryRepair } = proxyActivities<IssueActivities>(herdrLeadActivityCallOptions);

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

// Historical workflows replay these activity schedules. New workflows use
// forge-simple-capacity-v1 and never invoke them.
export const { requestCapacity, tryAcquireCapacity, inspectCapacity, requeueCapacity, cancelCapacity, finalizeCapacity, rateLimitCapacity, reconcileCapacityOwnership } = proxyActivities<IssueActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "15 seconds" },
});
