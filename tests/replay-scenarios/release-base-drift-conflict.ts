import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "release_base_drift_conflict",
  captureId: "release-base-drift-conflict-v1",
  activityOverrides: (_context, shared) => ({
    async publishRelease(input) {
      const result = await shared.publishRelease!(input);
      // Drift once. The Lead-owned republish is automatic now, so a fake that always
      // drifts would keep the fixture re-reviewing and republishing forever.
      if (_context.ciAttempts.get("publish") !== undefined) return result;
      _context.ciAttempts.set("publish", 1);
      return { ...result, outcome: "base-drift-conflict" as const, releaseId: null, pullRequestNumber: null, pullRequestUrl: null, isDraft: false as const, baseDriftConflict: true as const, forwardMergeId: "forward-merge-conflict", priorHead: input.subjectCommit, targetBaseSha: "9".repeat(40), mergeConflictEvidence: { artifactId: "merge-conflict-evidence", companyId: "fixture-company", kind: "merge-conflict-evidence" as const, sha256: "a".repeat(64), byteSize: 1, mimeType: "application/json" } };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, {});
  },
} satisfies ReplayScenarioDefinition<"release_base_drift_conflict">;
