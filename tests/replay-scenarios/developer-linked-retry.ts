import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_linked_retry",
  captureId: "developer-linked-retry-v1",
  activityOverrides: (context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      const result = await shared.runDeveloperExecutionSupervised!(input);
      if (context.developmentAttempts.get(input.workflowId) === 1) return { status: "interrupted" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-worker-lost", summary: "Controlled Developer worker loss.", lastHeartbeatAt: null };
      return result;
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { developerRetry: true, skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_linked_retry">;
