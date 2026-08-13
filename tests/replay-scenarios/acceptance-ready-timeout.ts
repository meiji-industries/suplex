import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "acceptance_ready_timeout",
  captureId: "acceptance-ready-timeout-v1",
  activityOverrides: (_context, shared) => ({
    async acceptDelivery(input) {
      const result = await shared.acceptDelivery!(input);
      return { ...result, acceptanceId: `acceptance-${input.workflowId}`, status: "pending_ready" as const, outcome: "provider_unavailable" as const, retryAt: null, blockerCode: "provider_unavailable", blockerSummary: "Controlled ready mutation timeout" };
    },
    async reconcileAcceptance(input) {
      const result = await shared.reconcileAcceptance!(input);
      return { ...result, status: "pending_ready" as const, outcome: "provider_unavailable" as const, retryAt: null, readyAt: null, blockerCode: "provider_unavailable", blockerSummary: "Controlled ready observation timeout" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "ready-timeout" });
  },
} satisfies ReplayScenarioDefinition<"acceptance_ready_timeout">;
