import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "acceptance_requested_changes",
  captureId: "acceptance-requested-changes-v1",
  activityOverrides: (_context, shared) => ({
    async acceptDelivery(input) {
      const result = await shared.acceptDelivery!(input);
      return { ...result, acceptanceId: `acceptance-${input.workflowId}`, status: "requested_changes" as const, reasonArtifactId: `reason-${input.workflowId}` };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "request-changes" });
  },
} satisfies ReplayScenarioDefinition<"acceptance_requested_changes">;
