import { retryDevelopmentUpdate } from "../../src/temporal/workflows.js";
import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "developer_reconciliation_recovery",
  captureId: "developer-reconciliation-recovery-v1",
  activityOverrides: (context, shared) => {
    let original: { executionId: string; planRevision: number; attempt: number; sessionRef: string; worktreePath: string; branchName: string; targetBaseSha: string } | undefined;
    const supervisedInputs: Array<{ developerTurnExecutionId: string; developerAttempt: number; capacityRequestId?: string }> = [];
    let capacityRequestsAtFailure: number | undefined;
    return {
      async runDeveloperExecutionSupervised(input) {
        supervisedInputs.push(input);
        const completed = await shared.runDeveloperExecutionSupervised!(input);
        if (!original) {
          original = { executionId: input.developerTurnExecutionId, planRevision: input.planRevision, attempt: input.developerAttempt, sessionRef: `developer-session-${context.scenario}`, worktreePath: `/worktrees/${input.developerTurnExecutionId}`, branchName: `forge/issue/${context.scenario}`, targetBaseSha: "b".repeat(40) };
          capacityRequestsAtFailure = context.capacityRequests.size;
          return { status: "failed" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "worker-restart-orphan", summary: "Controlled supervised Developer loss after durable identity.", evidenceArtifactId: null };
        }
        if (input.developerTurnExecutionId !== original.executionId || input.developerAttempt !== original.attempt || input.capacityRequestId || context.capacityRequests.size !== capacityRequestsAtFailure) throw new Error("Reconciliation created a fresh Developer identity or acquired capacity");
        return completed;
      },
      async findRecoverableDeveloperExecution() {
        if (!original) throw new Error("Recovery lookup ran before the original Developer identity existed");
        return original;
      },
    };
  },
  async script(handle, helpers) {
    const blocked = await helpers.drive(handle, { skipReview: true });
    if (blocked.phase !== "delivery_blocked") throw new Error(`Expected recoverable delivery_blocked state, got ${blocked.phase}`);
    const recovered = await handle.executeUpdate(retryDevelopmentUpdate, { args: [{ ...helpers.command(blocked.revision, `${helpers.scenario}-reconcile`), reconcileOnly: true }], updateId: `${helpers.scenario}-reconcile` });
    if (recovered.phase !== "delivery_ready") throw new Error(`Expected reconciled delivery_ready state, got ${recovered.phase}`);
    if ((recovered.developerAttempt ?? 0) !== 1 || !recovered.developerExecutionId) throw new Error("Reconciliation did not retain the original Developer attempt identity");
    return recovered;
  },
} satisfies ReplayScenarioDefinition<"developer_reconciliation_recovery">;
