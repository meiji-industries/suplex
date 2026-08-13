import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "acceptance_provider_outage",
  captureId: "acceptance-provider-outage-v1",
  activityOverrides: (_context, shared) => ({
    async acceptDelivery(input) {
      const result = await shared.acceptDelivery!(input);
      return { ...result, acceptanceId: null, status: "blocked" as const, outcome: "provider_unavailable" as const, retryAt: null, blockerCode: "provider_unavailable", blockerSummary: "Controlled pre-intent provider outage" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "provider-outage" });
  },
} satisfies ReplayScenarioDefinition<"acceptance_provider_outage">;
