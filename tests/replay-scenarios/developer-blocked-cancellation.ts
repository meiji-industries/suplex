import type { IssueActivities } from "../../src/temporal/contracts/activities/index.js";
import { cancelIssueUpdate } from "../../src/temporal/workflows.js";
import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

type CompletedDeveloperResult = Extract<Awaited<ReturnType<IssueActivities["runDeveloperExecutionSupervised"]>>, { status: "completed" }>["result"];

export const scenario = {
  name: "developer_blocked_cancellation",
  captureId: "developer-blocked-cancellation-v1",
  activityOverrides: (_context, shared) => {
    let blockedResult: CompletedDeveloperResult | undefined;
    return {
      async runDeveloperExecutionSupervised(input) {
        const outcome = await shared.runDeveloperExecutionSupervised!(input);
        if (outcome.status !== "completed") return outcome;
        blockedResult = { ...outcome.result, outcome: "blocked", failureCode: "delivery-reconciliation-failed", deliverySummary: "Stored delivery evidence needs policy reconciliation." };
        return { ...outcome, result: blockedResult };
      },
      async cancelDeveloperExecution(input) {
        if (!blockedResult) throw new Error("Blocked Developer result was not captured");
        return { status: "completed_before_cancellation", executionId: input.executionId, result: blockedResult, resultHash: "a".repeat(64) };
      },
    };
  },
  async script(handle, helpers) {
    let state = await helpers.drive(handle, { skipReview: true });
    if (state.phase !== "delivery_blocked") throw new Error("Developer delivery did not block");
    state = await handle.executeUpdate(cancelIssueUpdate, { args: [helpers.command(state.revision, `${helpers.scenario}-cancel`)], updateId: `${helpers.scenario}-cancel` });
    if (state.phase !== "cancelled") throw new Error("Blocked Developer result prevented cancellation");
    return state;
  },
} satisfies ReplayScenarioDefinition<"developer_blocked_cancellation">;
