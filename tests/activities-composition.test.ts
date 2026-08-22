import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/temporal/activities.js";
import { createActivityContext } from "../src/temporal/activities/context.js";
import { createAcceptanceActivities } from "../src/temporal/activities/acceptance.js";
import { createCapacityActivities } from "../src/temporal/activities/capacity.js";
import { createCiActivities } from "../src/temporal/activities/ci.js";
import { createDeliveryReviewActivities } from "../src/temporal/activities/delivery-review.js";
import { createDevelopmentActivities } from "../src/temporal/activities/development.js";
import { createFinalReviewActivities } from "../src/temporal/activities/final-review.js";
import { createGovernanceActivities } from "../src/temporal/activities/governance.js";
import { createMergeConflictActivities } from "../src/temporal/activities/merge-conflict.js";
import { createPlanningActivities } from "../src/temporal/activities/planning.js";
import { createProjectionActivities } from "../src/temporal/activities/projection.js";
import { createReleaseActivities } from "../src/temporal/activities/release.js";
import { createTargetBaseActivities } from "../src/temporal/activities/target-base.js";

const expectedActivityKeys = [
  "acceptDelivery",
  "authorizePlanRevision",
  "cancelCapacity",
  "cancelCapacityExecution",
  "cancelDeveloperExecution",
  "consolidateLeadPlan",
  "createSuccessor",
  "finalReview",
  "finalizeCapacity",
  "findActiveDeveloperExecution",
  "inspectCapacity",
  "planCiRepair",
  "planDeliveryRepair",
  "planMergeConflict",
  "preparePlanRevision",
  "projectIssueState",
  "publishRelease",
  "rateLimitCapacity",
  "reconcileAcceptance",
  "reconcileCapacityOwnership",
  "reconcileCi",
  "reconcileDeveloperDeliveryEvidence",
  "reconcileMerge",
  "reconcileTargetBase",
  "recordDecisionBlockerResolution",
  "recordDeliveryBlocker",
  "recordDeliveryDecision",
  "recordPlanBlockerResponse",
  "recordPlanDecision",
  "recordProbeStarted",
  "requestCapacity",
  "requeueCapacity",
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
  "tryAcquireCapacity",
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
      createCapacityActivities(context),
      createDevelopmentActivities(context),
      createDeliveryReviewActivities(context),
      createReleaseActivities(context),
      createTargetBaseActivities(context),
      createCiActivities(context),
      createFinalReviewActivities(context),
      createAcceptanceActivities(context),
      createMergeConflictActivities(context),
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

