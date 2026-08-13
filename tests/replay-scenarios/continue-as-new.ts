import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "continue_as_new",
  captureId: "continue-as-new-run-0-v1",
  workflowInput: { continueAsNewAfter: 2 },
  activityOverrides: (context, shared) => ({
    async runDeveloperExecution(input) {
      await context.developerGate.promise;
      return shared.runDeveloperExecution!(input);
    },
    async runDeveloperExecutionSupervised(input) {
      const result = await shared.runDeveloperExecutionSupervised!(input);
      await context.developerGate.promise;
      return result;
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { continueAsNew: true, cancellation: "development", skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"continue_as_new">;
