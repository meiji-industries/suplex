import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import type { DeliveryBlockerActivities } from "../contracts/activities/projection.js";
import type { IssueActivities } from "../contracts/activities/index.js";
import type { ActivityOptions } from "./context.js";
import { createActivityContext } from "./context.js";
import { createProjectionActivities } from "./projection.js";
import { createPlanningActivities } from "./planning.js";
import { createGovernanceActivities } from "./governance.js";
import { createGithubSyncActivities } from "./github-sync.js";
import { createHerdrTurnReadActivities } from "./herdr-turn-read.js";
import { createDevelopmentActivities } from "./development.js";
import { createDeliveryReviewActivities } from "./delivery-review.js";
import { createReleaseActivities } from "./release.js";
import { createTargetBaseActivities } from "./target-base.js";
import { createCiActivities } from "./ci.js";
import { createFinalReviewActivities } from "./final-review.js";
import { createAcceptanceActivities } from "./acceptance.js";
import { createMergeConflictActivities } from "./merge-conflict.js";
import { createWorktreeActivities } from "./worktree.js";
import { createRootControlActivities } from "./root-control.js";
import { RootController } from "../../root-controller.js";
import { TaskControlStore } from "../../root-session-store.js";
import { OpenCodeTaskRuntime } from "../../opencode-task-runtime.js";
import { CliHerdrClient } from "../../herdr-client.js";

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): IssueActivities & DeliveryBlockerActivities {
  const ctx = createActivityContext(database, config, options);
  return {
    ...createProjectionActivities(ctx),
    ...createPlanningActivities(ctx),
    ...createGovernanceActivities(ctx),
    ...createGithubSyncActivities(ctx),
    ...createHerdrTurnReadActivities(ctx),
    ...createDevelopmentActivities(ctx),
    ...createDeliveryReviewActivities(ctx),
    ...createReleaseActivities(ctx),
    ...createTargetBaseActivities(ctx),
    ...createCiActivities(ctx),
    ...createFinalReviewActivities(ctx),
    ...createAcceptanceActivities(ctx),
    ...createMergeConflictActivities(ctx),
    ...createWorktreeActivities(ctx),
    ...createRootControlActivities(new RootController(new TaskControlStore(database), new OpenCodeTaskRuntime(database.filename(), new CliHerdrClient()))),
  } as unknown as IssueActivities & DeliveryBlockerActivities;
}

export * from "./context.js";
