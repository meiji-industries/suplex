import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_linked_retry",
  captureId: "developer-linked-retry-v1",
  activityOverrides: (context, shared) => {
    let initialAuthorization = false;
    return { async runDeveloperExecutionSupervised(input) {
      const retry = context.developmentAttempts.get(input.workflowId) === 1;
      if (retry && Boolean(input.authorization) !== initialAuthorization) throw new Error("Linked Developer retry changed its authorization envelope");
      if (!retry) initialAuthorization = Boolean(input.authorization);
      const result = await shared.runDeveloperExecutionSupervised!(input);
      if (context.developmentAttempts.get(input.workflowId) === 1) return { status: "interrupted" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-worker-lost", summary: "Controlled Developer worker loss.", lastHeartbeatAt: null };
      return result;
    } };
  },
  async script(handle, helpers) {
    return helpers.drive(handle, { developerRetry: true, skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_linked_retry">;
