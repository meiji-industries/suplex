import type { AcceptanceActivities } from "./acceptance.js";
import type { CapacityActivities } from "./capacity.js";
import type { CiActivities } from "./ci.js";
import type { DeliveryReviewActivities } from "./delivery-review.js";
import type { DevelopmentActivities } from "./development.js";
import type { FinalReviewActivities } from "./final-review.js";
import type { GovernanceActivities } from "./governance.js";
import type { MergeConflictActivities } from "./merge-conflict.js";
import type { PlanningActivities } from "./planning.js";
import type { ProjectionActivities } from "./projection.js";
import type { ReleaseActivities } from "./release.js";
import type { TargetBaseActivities } from "./target-base.js";

export interface IssueActivities extends ProjectionActivities, PlanningActivities, GovernanceActivities, CapacityActivities, DevelopmentActivities, DeliveryReviewActivities, ReleaseActivities, TargetBaseActivities, CiActivities, FinalReviewActivities, AcceptanceActivities, MergeConflictActivities {}

export * from "./acceptance.js";
export * from "./capacity.js";
export * from "./ci.js";
export * from "./delivery-review.js";
export * from "./development.js";
export * from "./final-review.js";
export * from "./governance.js";
export * from "./merge-conflict.js";
export * from "./planning.js";
export * from "./projection.js";
export * from "./release.js";
export * from "./target-base.js";
