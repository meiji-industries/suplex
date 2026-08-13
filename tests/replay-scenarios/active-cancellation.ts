import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "active_cancellation",
  captureId: "active-cancellation-v1",
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
    return helpers.drive(handle, { cancellation: "development", skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"active_cancellation">;
