import { setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerTargetBaseHandlers(ctx: IssueWorkflowContext): void {
  const validateRetryTargetBase = (rawInput: contracts.StartPlanningInput, verificationOnly: boolean): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    const checkpoint = ctx.state.targetBaseCheckpoint;
    if (command.expectedRevision !== ctx.state.revision || ctx.state.phase !== "delivery_blocked" || !checkpoint) throw new Error("Target-base reconciliation retry is not available in the current phase");
    if (verificationOnly && !["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(ctx.state.targetBaseBlockerCode ?? "")) throw new Error("Verification retry is not available for the current blocker");
    if (!verificationOnly && !ctx.state.targetBaseBlockerRetryable && !(ctx.state.targetBaseBlockerCode === "merge_state_ownership_mismatch" && ctx.state.forwardMergeId)) throw new Error("Target-base reconciliation is not retryable");
    return command;
  };
  const retryTargetBase = async (rawInput: contracts.StartPlanningInput, verificationOnly: boolean): Promise<contracts.IssueWorkflowState> => {
    const checkpoint = ctx.state.targetBaseCheckpoint;
    try {
      validateRetryTargetBase(rawInput, verificationOnly);
    } catch (error) {
      // Kodiak removed this retry path. A previously accepted retry may still
      // be in history, so patched runs must retain its result as a no-op.
      if (ctx.patched("forge-kodiak-merge-v1")) return ctx.state;
      throw error;
    }
    if (!checkpoint) return ctx.state;
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: verificationOnly ? "Retrying pinned forward-merge verification" : "Retrying target-base reconciliation", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    await ctx.runTargetBaseCheckpoint(checkpoint, verificationOnly);
    return ctx.state;
  };
  setHandler(issueUpdates.retry_target_base_reconciliation, ctx.guarded((rawInput) => retryTargetBase(rawInput, false), "retry_target_base_reconciliation"), { validator(rawInput) { validateRetryTargetBase(rawInput, false); } });
  setHandler(issueUpdates.retry_forward_merge_verification, ctx.guarded((rawInput) => retryTargetBase(rawInput, true), "retry_forward_merge_verification"), { validator(rawInput) { validateRetryTargetBase(rawInput, true); } });

}
