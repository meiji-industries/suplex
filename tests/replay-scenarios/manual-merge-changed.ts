import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "manual_merge_changed",
  captureId: "manual-merge-changed-v1",
  activityOverrides: (_context, shared) => ({
    async reconcileMerge(input) {
      const result = await shared.reconcileMerge!(input);
      return { ...result, outcome: "changed_head" as const, completionReceiptId: null, mergedAt: null, blockerCode: "changed_head", blockerSummary: "Controlled pull request head change" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "accept", merge: true });
  },
} satisfies ReplayScenarioDefinition<"manual_merge_changed">;
