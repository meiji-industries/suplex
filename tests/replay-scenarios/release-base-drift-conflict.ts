import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "release_base_drift_conflict",
  captureId: "release-base-drift-conflict-v1",
  activityOverrides: (context, shared) => ({
    // Base drift is found while keeping the open pull request current (forge-kodiak-merge-v1), not at
    // publish time. Conflict once: the Integrator's resolution chains itself, so a fake that always
    // conflicts would keep the fixture resolving forever.
    async updateCiFromBase(input) {
      if (context.ciAttempts.get("base-update") !== undefined) return shared.updateCiFromBase!(input);
      context.ciAttempts.set("base-update", 1);
      return { outcome: "conflict" as const, forwardMergeId: "forward-merge-conflict", priorHead: input.expectedHeadSha, priorTree: input.expectedHeadTree, baseSha: "9".repeat(40), conflictArtifactId: "forward-merge-conflict-artifact", conflictFileCount: 1, summary: "Controlled base-update conflict" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, {});
  },
} satisfies ReplayScenarioDefinition<"release_base_drift_conflict">;
