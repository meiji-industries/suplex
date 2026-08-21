import { setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerTargetBaseHandlers(ctx: IssueWorkflowContext): void {
  const retryTargetBase = async (rawInput: contracts.StartPlanningInput, verificationOnly: boolean): Promise<contracts.IssueWorkflowState> => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    const checkpoint = ctx.state.targetBaseCheckpoint;
    if (command.expectedRevision !== ctx.state.revision || ctx.state.phase !== "delivery_blocked" || !checkpoint) throw new Error("Target-base reconciliation retry is not available in the current phase");
    if (verificationOnly && !["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(ctx.state.targetBaseBlockerCode ?? "")) throw new Error("Verification retry is not available for the current blocker");
    if (!verificationOnly && !ctx.state.targetBaseBlockerRetryable && !(ctx.state.targetBaseBlockerCode === "merge_state_ownership_mismatch" && ctx.state.forwardMergeId)) throw new Error("Target-base reconciliation is not retryable");
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: verificationOnly ? "Retrying pinned forward-merge verification" : "Retrying target-base reconciliation", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    await ctx.runTargetBaseCheckpoint(checkpoint, verificationOnly);
    void command;
    return ctx.state;
  };
  setHandler(issueUpdates.retry_target_base_reconciliation, ctx.guarded((rawInput) => retryTargetBase(rawInput, false)));
  setHandler(issueUpdates.retry_forward_merge_verification, ctx.guarded((rawInput) => retryTargetBase(rawInput, true)));

}
