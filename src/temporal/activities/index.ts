import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import type { ProbeActivities } from "../contracts.js";
import type { DeliveryBlockerActivities } from "../contracts/activities/projection.js";
import type { IssueActivities } from "../contracts/activities/index.js";
import type { ActivityOptions } from "./context.js";
import { createActivityContext } from "./context.js";
import { createProjectionActivities } from "./projection.js";
import { createPlanningActivities } from "./planning.js";
import { createGovernanceActivities } from "./governance.js";
import { createCapacityActivities } from "./capacity.js";
import { createDevelopmentActivities } from "./development.js";
import { createDeliveryReviewActivities } from "./delivery-review.js";
import { createReleaseActivities } from "./release.js";
import { createTargetBaseActivities } from "./target-base.js";
import { createCiActivities } from "./ci.js";
import { createFinalReviewActivities } from "./final-review.js";
import { createAcceptanceActivities } from "./acceptance.js";
import { createMergeConflictActivities } from "./merge-conflict.js";

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities & DeliveryBlockerActivities {
  const ctx = createActivityContext(database, config, options);
  return {
    ...createProjectionActivities(ctx),
    ...createPlanningActivities(ctx),
    ...createGovernanceActivities(ctx),
    ...createCapacityActivities(ctx),
    ...createDevelopmentActivities(ctx),
    ...createDeliveryReviewActivities(ctx),
    ...createReleaseActivities(ctx),
    ...createTargetBaseActivities(ctx),
    ...createCiActivities(ctx),
    ...createFinalReviewActivities(ctx),
    ...createAcceptanceActivities(ctx),
    ...createMergeConflictActivities(ctx),
  };
}

export * from "./context.js";
