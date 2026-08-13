import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "manual_merge_open",
  captureId: "manual-merge-open-v1",
  activityOverrides: (_context, shared) => ({
    async reconcileMerge(input) {
      const result = await shared.reconcileMerge!(input);
      return { ...result, outcome: "open" as const, completionReceiptId: null, mergedAt: null };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "accept", merge: true });
  },
} satisfies ReplayScenarioDefinition<"manual_merge_open">;
