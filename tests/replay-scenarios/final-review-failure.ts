import { ApplicationFailure } from "@temporalio/common";

import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "final_review_failure",
  captureId: "final-review-failure-v1",
  activityOverrides: (_context, shared) => ({
    async finalReview(input) {
      await shared.finalReview!(input);
      throw ApplicationFailure.nonRetryable("Final review provider unavailable", "final-review-unavailable");
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { finalReviewFailure: true });
  },
} satisfies ReplayScenarioDefinition<"final_review_failure">;
