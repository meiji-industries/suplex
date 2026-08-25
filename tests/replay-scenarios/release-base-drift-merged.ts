import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "release_base_drift_merged",
  captureId: "release-base-drift-merged-v1",
  activityOverrides: (context, shared) => ({
    // Base drift is merged while keeping the open pull request current (forge-kodiak-merge-v1), not at
    // publish time. Drift once: the updated head re-runs CI, so a fake that always drifts would keep
    // the fixture updating forever.
    async updateCiFromBase(input) {
      if (context.ciAttempts.get("base-update") !== undefined) return shared.updateCiFromBase!(input);
      context.ciAttempts.set("base-update", 1);
      return { outcome: "updated" as const, baseSha: "9".repeat(40), headSha: "8".repeat(40), headTree: "7".repeat(40), summary: "Controlled base update" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, {});
  },
} satisfies ReplayScenarioDefinition<"release_base_drift_merged">;
