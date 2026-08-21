import { ApplicationFailure } from "@temporalio/common";

import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "plan_revision",
  captureId: "plan-revision-v1",
  // The Lead review starts itself the moment the delivery lands, and a plan revision is
  // not available while it runs. A controlled review outage parks the task where a member
  // can still ask for a revision.
  activityOverrides: { async reviewDelivery() { throw ApplicationFailure.nonRetryable("Controlled review outage", "review-unavailable"); } },
  async script(handle, helpers) {
    return helpers.drive(handle, { planRevision: true });
  },
} satisfies ReplayScenarioDefinition<"plan_revision">;
