import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_cancellation",
  captureId: "developer-cancellation-v1",
  activityOverrides: (context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      const result = await shared.runDeveloperExecutionSupervised!(input);
      await context.developerGate.promise;
      return result;
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { cancellation: "development", skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_cancellation">;
