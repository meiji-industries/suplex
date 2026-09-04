import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/engine/activities.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { createAcceptanceActivities } from "../src/engine/activities/acceptance.js";
import { createCiActivities } from "../src/engine/activities/ci.js";
import { createDeliveryReviewActivities } from "../src/engine/activities/delivery-review.js";
import { createDevelopmentActivities } from "../src/engine/activities/development.js";
import { createFinalReviewActivities } from "../src/engine/activities/final-review.js";
import { createGovernanceActivities } from "../src/engine/activities/governance.js";
import { createGithubSyncActivities } from "../src/engine/activities/github-sync.js";
import { createMergeConflictActivities } from "../src/engine/activities/merge-conflict.js";
import { createPlanningActivities } from "../src/engine/activities/planning.js";
import { createProjectionActivities } from "../src/engine/activities/projection.js";
import { createReleaseActivities } from "../src/engine/activities/release.js";
import { createTargetBaseActivities } from "../src/engine/activities/target-base.js";
import { createWorktreeActivities } from "../src/engine/activities/worktree.js";

const expectedActivityKeys = [
  "acceptDelivery",
  "adoptPullRequestRelease",
  "applyGithubPullRequestAction",
  "arbitrateReview",
  "authorizePlanRevision",
  "cancelDeveloperExecution",
  "consolidateLeadPlan",
  "cleanupTaskWorktree",
  "createSuccessor",
  "finalReview",
  "findActiveDeveloperExecution",
  "findCiRepairPriorDelivery",
  "findCompletedDeliveryReview",
  "findRecoverableDeveloperExecution",
  "loadTaskSourcePullRequest",
  "observeGithubPullRequest",
  "planCiRepair",
  "planDeliveryRepair",
  "planMergeConflict",
  "preparePlanRevision",
  "projectIssueState",
  "publishRelease",
  "pushDeliveryBranch",
  "reconcileAcceptance",
  "reconcileCi",
  "reconcileMerge",
  "reconcileTargetBase",
  "recordDecisionBlockerResolution",
  "recordDeliveryBlocker",
  "recordDeliveryDecision",
  "recordPlanBlockerResponse",
  "recordPlanDecision",
  "recordPlannerNote",
  "recoverRevalidatedDeliveryReview",
  "recreateTaskWorktree",
  "rerunCi",
  "resolveMergeConflict",
  "resolveMergeConflictSupervised",
  "reviewDelivery",
  "runCiRepair",
  "runDeveloperExecution",
  "runDeveloperExecutionSupervised",
  "runDeveloperRepair",
  "runDeveloperRepairSupervised",
  "runLeadPlanning",
  "runSupplementalReview",
  "inspectTaskWorktree",
  "updateCiFromBase",
].sort();

test("activity factories compose the frozen activity key set without overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-activities-composition-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);

  try {
    const context = createActivityContext(database, config);
    const factoryResults = [
      createProjectionActivities(context),
      createPlanningActivities(context),
      createGovernanceActivities(context),
      createGithubSyncActivities(context),
      createDevelopmentActivities(context),
      createDeliveryReviewActivities(context),
      createReleaseActivities(context),
      createTargetBaseActivities(context),
      createCiActivities(context),
      createFinalReviewActivities(context),
      createAcceptanceActivities(context),
      createMergeConflictActivities(context),
      createWorktreeActivities(context),
    ];
    const factoryKeys = factoryResults.flatMap((factory) => Object.keys(factory));
    const activities = createActivities(database, config);

    expect(new Set(factoryKeys).size).toBe(factoryKeys.length);
    expect(Object.keys(activities).length).toBe(factoryKeys.length);
    expect(Object.keys(activities).sort()).toEqual(expectedActivityKeys);
    expect(factoryKeys.sort()).toEqual(expectedActivityKeys);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
