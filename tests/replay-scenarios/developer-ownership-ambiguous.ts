import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_ownership_ambiguous",
  captureId: "developer-ownership-ambiguous-v1",
  activityOverrides: (_context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      await shared.runDeveloperExecutionSupervised!(input);
      const request = _context.capacityRequests.get(input.capacityRequestId!);
      if (request) _context.capacityRequests.set(request.id, { ...request, status: "ownership_ambiguous", executionKind: "developer", executionId: input.developerTurnExecutionId, terminalReason: "ownership_ambiguous" });
      return { status: "ownership_ambiguous" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-ownership-ambiguous", summary: "Controlled ownership ambiguity.", lastHeartbeatAt: null };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_ownership_ambiguous">;
