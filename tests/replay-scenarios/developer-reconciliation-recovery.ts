import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_reconciliation_recovery",
  captureId: "developer-reconciliation-recovery-v1",
  activityOverrides: (_context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      const outcome = await shared.runDeveloperExecutionSupervised!(input);
      if (outcome.status !== "completed") return outcome;
      return { ...outcome, result: { ...outcome.result, outcome: "blocked" as const, failureCode: "delivery-reconciliation-failed", deliverySummary: "Stored delivery evidence needs policy reconciliation." } };
    },
    async reconcileDeveloperDeliveryEvidence(input) {
      return { developerExecutionId: input.developerExecutionId, developerSessionRef: "developer-session-developer_reconciliation_recovery", branchName: "forge/issue/developer_reconciliation_recovery", targetBaseSha: "b".repeat(40), currentStep: 1, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "reconciled-delivery", evidenceArtifactId: "developer-evidence-developer_reconciliation_recovery", deliverySummary: "Stored Developer evidence reconciled.", outcome: "completed" as const, failureCode: null };
    },
  }),
  async script(handle, helpers) {
    const state = await helpers.drive(handle, { developerRetry: true, skipReview: true });
    if (state.developerAttempt !== 1 || state.phase !== "delivery_ready") throw new Error("Reconciliation recovery launched a second Developer turn");
    return state;
  },
} satisfies ReplayScenarioDefinition<"developer_reconciliation_recovery">;
