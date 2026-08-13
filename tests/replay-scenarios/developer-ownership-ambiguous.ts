import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_ownership_ambiguous",
  captureId: "developer-ownership-ambiguous-v1",
  activityOverrides: (_context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      await shared.runDeveloperExecutionSupervised!(input);
      return { status: "ownership_ambiguous" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-ownership-ambiguous", summary: "Controlled ownership ambiguity.", lastHeartbeatAt: null };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_ownership_ambiguous">;
