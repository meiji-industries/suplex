import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "release_base_drift_merged",
  captureId: "release-base-drift-merged-v1",
  activityOverrides: (_context, shared) => ({
    async publishRelease(input) {
      const result = await shared.publishRelease!(input);
      // Drift once. The Lead-owned republish is automatic now, so a fake that always
      // drifts would keep the fixture re-reviewing and republishing forever.
      if (_context.ciAttempts.get("publish") !== undefined) return result;
      _context.ciAttempts.set("publish", 1);
      return { ...result, outcome: "base-drift-merged" as const, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false as const, baseDriftMerged: true as const, priorHead: input.subjectCommit, targetBaseSha: "9".repeat(40), headSha: "8".repeat(40), headTree: "7".repeat(40) };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, {});
  },
} satisfies ReplayScenarioDefinition<"release_base_drift_merged">;
