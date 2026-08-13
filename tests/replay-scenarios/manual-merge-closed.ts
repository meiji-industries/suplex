import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "manual_merge_closed",
  captureId: "manual-merge-closed-v1",
  activityOverrides: (_context, shared) => ({
    async reconcileMerge(input) {
      const result = await shared.reconcileMerge!(input);
      return { ...result, outcome: "closed_without_merge" as const, completionReceiptId: null, mergedAt: null, blockerCode: "closed_without_merge", blockerSummary: "Controlled pull request closure" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "accept", merge: true });
  },
} satisfies ReplayScenarioDefinition<"manual_merge_closed">;
