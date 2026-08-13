import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "implementation_repair",
  captureId: "implementation-repair-v1",
  activityOverrides: (_context, shared) => ({
    async reviewDelivery(input) {
      const result = await shared.reviewDelivery!(input);
      if (!("review" in result)) return result;
      if (_context.reviewAttempts.get(input.workflowId) !== 1) return result;
      return { ...result, review: { ...result.review, opinion: "blocking" as const, summary: "Controlled repair required", repairPlan: "Apply the controlled repair", findings: [{ findingId: `finding-${_context.scenario}-1`, severity: "blocking" as const, rationale: "Controlled fixture defect", evidenceRef: "fixture", disposition: "open" as const, repairInstruction: "Apply the controlled repair" }] } };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { repair: true });
  },
} satisfies ReplayScenarioDefinition<"implementation_repair">;
