import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "successor_creation",
  captureId: "successor-creation-v1",
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
    return helpers.drive(handle, { cancellation: "successor", skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"successor_creation">;
