import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "ci_wait_retry",
  captureId: "ci-wait-retry-v1",
  activityOverrides: (context, shared) => ({
    async reconcileCi(input) {
      const result = await shared.reconcileCi!(input);
      if (context.ciAttempts.get(input.releaseId) !== 1) return result;
      return { ...result, runId: "ci-waiting", outcome: "waiting" as const, reason: "checks_pending", owner: "system" as const, repairable: false, summary: "Controlled CI wait", retryAt: "2026-08-11T00:00:00.000Z", nextPollAt: "2026-08-11T00:00:00.000Z" };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { ciWait: true });
  },
} satisfies ReplayScenarioDefinition<"ci_wait_retry">;
