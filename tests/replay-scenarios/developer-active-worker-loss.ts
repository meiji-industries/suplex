import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_active_worker_loss",
  captureId: "developer-active-worker-loss-v1",
  activityOverrides: (context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      const result = await shared.runDeveloperExecutionSupervised!(input);
      if (context.developmentAttempts.get(input.workflowId) === 1) throw new Error("Controlled Activity worker loss before result claim");
      return result;
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_active_worker_loss">;
