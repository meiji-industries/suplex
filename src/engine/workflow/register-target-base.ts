import { isBlocked } from "../../issue-phases.js";
import { setHandler } from "../registry.js";
import * as contracts from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import * as stateTransitions from "./state-transitions.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerTargetBaseHandlers(ctx: IssueWorkflowContext): void {
  const makeOwnershipMismatchRetryable = async (): Promise<void> => {
    if (ctx.state.owner !== "human" || ctx.state.targetBaseBlockerCode !== "merge_state_ownership_mismatch") return;
    const summary = ctx.state.targetBaseBlockerSummary ?? "Forge could not match the delivery to the base branch. Retry the base update.";
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: summary, blocker: stateTransitions.humanBlocker("agent_exhausted", summary, [{ command: "retry_target_base_reconciliation", label: "Retry the base update", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence")), targetBaseBlockerRetryable: true, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
  };
  const canSyncBranch = (): boolean => (ctx.state.activeOperation === null || ctx.state.activeOperation === undefined) && Boolean(ctx.state.branchName && ctx.state.developerExecutionId && ctx.state.targetBaseSha && ctx.state.resultCommit && ctx.state.resultTree);
  const validateRetryTargetBase = (rawInput: contracts.StartPlanningInput, verificationOnly: boolean): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    const checkpoint = ctx.state.targetBaseCheckpoint;
    const retryingBlocker = isBlocked(ctx.state) && Boolean(checkpoint);
    if (command.expectedRevision !== ctx.state.revision || (!retryingBlocker && !canSyncBranch())) throw new Error("Target-base reconciliation retry is not available in the current phase");
    if (verificationOnly && !["verification_failed", "verification_timed_out", "verification_evidence_too_large"].includes(ctx.state.targetBaseBlockerCode ?? "")) throw new Error("Verification retry is not available for the current blocker");
    return command;
  };
  const retryTargetBase = async (rawInput: contracts.StartPlanningInput, verificationOnly: boolean): Promise<contracts.IssueWorkflowState> => {
    const checkpoint = ctx.state.targetBaseCheckpoint;
    try {
      validateRetryTargetBase(rawInput, verificationOnly);
    } catch (error) {
      // Kodiak removed this retry path. A previously accepted retry may still
      // be in history, so patched runs must retain its result as a no-op.
      return ctx.state;
      throw error;
    }
    if (!checkpoint && canSyncBranch()) {
      const previous = { step: ctx.state.step, owner: ctx.state.owner, allowedCommands: ctx.state.allowedCommands, pendingAction: ctx.state.pendingAction };
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: "Forge merges the latest base branch", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      if (await ctx.runTargetBaseCheckpoint("pre_release") && ctx.state.step === previous.step) {
        // A no-drift check outside a blocked transition only needs to undo the
        // transient "Forge merges the pull request" status. A checkpoint that changes phase owns its
        // review tuple, so restoring it would revive stale retry commands.
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...previous, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
      }
      await makeOwnershipMismatchRetryable();
      return ctx.state;
    }
    if (!checkpoint) return ctx.state;
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: verificationOnly ? "Checking the merge again" : "Checking for updates", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    await ctx.runTargetBaseCheckpoint(checkpoint, verificationOnly);
    await makeOwnershipMismatchRetryable();
    if (checkpoint === "pre_acceptance" && ctx.input.deliveryTarget === "merged" && ctx.input.autoMergeActorUserId && ctx.state.step === "accepted") return ctx.retryAcceptDelivery({ expectedRevision: ctx.state.revision, actorUserId: ctx.input.autoMergeActorUserId, commandId: `${ctx.state.workflowId}:auto-accept-target-base:${ctx.state.revision}` });
    return ctx.state;
  };
  setHandler(issueUpdates.retry_target_base_reconciliation, ctx.guarded((rawInput) => retryTargetBase(rawInput, false), "retry_target_base_reconciliation"), { validator(rawInput) { validateRetryTargetBase(rawInput, false); } });
  setHandler(issueUpdates.retry_forward_merge_verification, ctx.guarded((rawInput) => retryTargetBase(rawInput, true), "retry_forward_merge_verification"), { validator(rawInput) { validateRetryTargetBase(rawInput, true); } });
  ctx.retryTargetBaseReconciliation = (command) => retryTargetBase(command, false);

}
