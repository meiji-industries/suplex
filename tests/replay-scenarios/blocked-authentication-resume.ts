import { ApplicationFailure } from "@temporalio/common";

import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "blocked_authentication_resume",
  captureId: "blocked-authentication-resume-v1",
  activityOverrides: (context, shared) => ({
    async runLeadPlanning(input) {
      const result = await shared.runLeadPlanning!(input);
      if (context.planningAttempts.get(input.workflowId) === 1) throw ApplicationFailure.nonRetryable("Authentication expired", "login-expired", { code: "login-expired", summary: "Authentication expired; sign in and retry." });
      return result;
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { planningRetry: true, skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"blocked_authentication_resume">;
