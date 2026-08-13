import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_result_claim",
  captureId: "developer-result-claim-v1",
  activityOverrides: (context, shared) => ({
    async runDeveloperExecutionSupervised(input) {
      const result = await shared.runDeveloperExecutionSupervised!(input);
      await context.developerGate.promise;
      return result;
    },
    async cancelDeveloperExecution(input) {
      await shared.cancelDeveloperExecution!(input);
      return { status: "completed_before_cancellation" as const, executionId: input.executionId, result: { developerExecutionId: input.executionId, developerSessionRef: `developer-session-${context.scenario}`, branchName: `forge/issue/${context.scenario}`, targetBaseSha: "b".repeat(40), currentStep: 1, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: `delivery-${context.scenario}`, evidenceArtifactId: `developer-evidence-${context.scenario}`, deliverySummary: "Controlled result won cancellation race", outcome: "completed" as const }, resultHash: "c".repeat(64) };
    },
  }),
  async script(handle, helpers) {
    return helpers.drive(handle, { cancellation: "development", skipReview: true });
  },
} satisfies ReplayScenarioDefinition<"developer_result_claim">;
