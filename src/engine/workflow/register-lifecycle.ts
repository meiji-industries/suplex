import { at, isBlocked } from "../../issue-phases.js";
import { runExecution, setHandler, setInterruptHandler } from "../registry.js";
import { ApplicationFailure } from "../failures.js";
import { z } from "zod";

import { TERMINAL_PHASES } from "../../issue-phases.js";
import { assertPayloadWithinLimit } from "../policy.js";
import { IssueWorkflowStateSchema, type DeveloperCancellationResult } from "../issue-contracts.js";
import { ContinueWorkCommandSchema, PlanCommandInputSchema, StartPlanningInputSchema } from "../../commands/inputs.js";
import { issueUpdates } from "../issue-updates.js";
import { acceptDelivery, cancelCapacity, cancelCapacityExecution, cancelDeveloperExecution, cleanupTaskWorktree, createSuccessor, finalizeCapacity, inspectCapacity, recreateTaskWorktree, recordDeliveryDecision } from "./activity-proxies.js";
import type { IssueWorkflowContext } from "./context.js";
import * as stateTransitions from "./state-transitions.js";

type DeveloperCancellationInterruptResult = {
  executionId: string;
  result: DeveloperCancellationResult;
};

export function registerLifecycleHandlers(ctx: IssueWorkflowContext): void {
  const cancelQueuedCapacity = async (): Promise<void> => {
    if (!ctx.state.capacity || !["queued", "rate_limited"].includes(ctx.state.capacity.status)) return;
    await cancelCapacity({ requestId: ctx.state.capacity.requestId, reason: "workflow phase changed" });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, capacity: null, revision: ctx.state.revision + 1, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
  };
  const cancelCurrentCapacity = async (): Promise<{ status: "cancelled"; executionId?: string | undefined }> => {
    if (!ctx.state.capacity) return { status: "cancelled" };
    if (["queued", "rate_limited"].includes(ctx.state.capacity.status)) {
      await cancelQueuedCapacity();
      return { status: "cancelled" };
    }
    if (ctx.state.capacity.status === "active") {
      return cancelCapacityExecution({ requestId: ctx.state.capacity.requestId });
    }
    return { status: "cancelled" };
  };
  const settleCancelledCapacity = async (executionId: string): Promise<"settled" | "none"> => {
    if (!ctx.state.capacity) return "none";
    const request = await inspectCapacity({ requestId: ctx.state.capacity.requestId });
    if (request.status === "active" && request.executionId === executionId) {
      await finalizeCapacity({ requestId: request.id, expectedExecutionId: executionId, terminalReason: "cancelled" });
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, capacity: null, capacityBlocker: null, revision: ctx.state.revision + 1, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return "settled";
    }
    return "none";
  };
  const developerCancellationAvailable = (): boolean => ctx.state.step === "development" || (isBlocked(ctx.state) && (ctx.state.developerRecoveryStatus === "cancellation_requested" || (ctx.state.developerRecoveryStatus === "interrupted" && ctx.state.capacity !== null)));
  const interruptDeveloperCancellation = (): Promise<DeveloperCancellationInterruptResult> | undefined => {
    const executionId = ctx.state.developerExecutionId;
    if (!executionId || !["starting", "active", "reconnecting", "result_pending_claim", "cancellation_requested", "cancelling"].includes(ctx.state.developerRecoveryStatus ?? "")) return undefined;
    return cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId }).then((result) => ({ executionId, result }));
  };
  const developerCancellationKey = (): string | undefined => ctx.state.developerExecutionId ? `developer-cancellation:${ctx.state.revision}:${ctx.state.developerExecutionId}` : undefined;
  const acceptedDeveloperCancellation = (name: string, executionId: string): DeveloperCancellationResult | undefined => {
    const execution = runExecution.current();
    if (execution.acceptedInterrupt !== name || execution.interruptResult === undefined) return undefined;
    // The matching interrupt hook above is the only producer for this in-process result.
    const interrupted = execution.interruptResult as DeveloperCancellationInterruptResult;
    return interrupted.executionId === executionId ? interrupted.result : undefined;
  };
  setInterruptHandler(issueUpdates.cancel_issue, {
    cancelActive: true,
    coalesceKey: developerCancellationKey,
    validate: (rawInput: unknown) => {
      PlanCommandInputSchema.parse(rawInput);
      if (TERMINAL_PHASES.has(ctx.state.phase)) throw new Error("Issue cancellation is not available in the current phase");
    },
    run: interruptDeveloperCancellation,
  });
  setHandler(issueUpdates.cancel_issue, ctx.guarded(async (rawInput: any) => {
    await ctx.initialProjection;
    const command = PlanCommandInputSchema.parse(rawInput);
    if (TERMINAL_PHASES.has(ctx.state.phase)) throw new Error("Issue cancellation is not available in the current phase");
    const executionId = ctx.state.developerExecutionId;
    const interruptedCancellation = executionId ? acceptedDeveloperCancellation(issueUpdates.cancel_issue, executionId) : undefined;
    if (executionId && ["starting", "active", "reconnecting", "result_pending_claim", "cancellation_requested", "cancelling"].includes(ctx.state.developerRecoveryStatus ?? "")) {
      await (interruptedCancellation ?? cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId }));
      if (ctx.state.capacity) await settleCancelledCapacity(executionId);
    } else {
      const cancellation = await cancelCurrentCapacity();
      if (cancellation.executionId) await settleCancelledCapacity(cancellation.executionId);
    }
    let acceptanceStatus = ctx.state.acceptanceStatus;
    let acceptanceReasonArtifactId = ctx.state.acceptanceReasonArtifactId;
    if (ctx.state.acceptanceId && ctx.state.expectedHeadSha) {
      const result = await acceptDelivery({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, expectedHeadSha: ctx.state.expectedHeadSha, decision: "cancel", ...(command.note !== undefined ? { note: command.note } : {}) });
      acceptanceStatus = result.status;
      acceptanceReasonArtifactId = result.reasonArtifactId ?? acceptanceReasonArtifactId;
    } else if (command.note?.trim()) {
      const decision = await recordDeliveryDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, note: command.note });
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, deliveryDecisionArtifactId: decision.artifactId });
    }
    const resume = ctx.state.branchName ? ["resume_preserved_work" as const] : [];
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("cancelled"), owner: "human", allowedCommands: ["continue_work", ...resume], pendingAction: "Task cancelled", acceptanceStatus, acceptanceReasonArtifactId, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  }));
  setInterruptHandler(issueUpdates.cancel_development, {
    cancelActive: true,
    coalesceKey: developerCancellationKey,
    validate: (rawInput: unknown) => {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (ctx.commandAlreadyProcessed(command.commandId)) return false;
      if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
      if (!developerCancellationAvailable()) throw new Error("Developer cancellation is not available in the current phase");
      return true;
    },
    run: interruptDeveloperCancellation,
  });
  setHandler(issueUpdates.cancel_development, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("cancel development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return ctx.state;
    const executionId = ctx.state.developerExecutionId;
    const interruptedCancellation = executionId ? acceptedDeveloperCancellation(issueUpdates.cancel_development, executionId) : undefined;
    const hasCapacityOwnership = ctx.state.capacity !== null;
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || !developerCancellationAvailable()) throw new Error("Developer cancellation was superseded by another command");
      ctx.state = IssueWorkflowStateSchema.parse({
        ...ctx.state,
        revision: ctx.state.revision + 1,
        ...at(executionId || hasCapacityOwnership ? "development" : "ready_for_development"),
        owner: executionId || hasCapacityOwnership ? "human" : "lead",
        allowedCommands: executionId || hasCapacityOwnership ? ctx.addRevisionCommand(["retry_development", "cancel_issue"]) : ["start_development", "cancel_issue"],
        pendingAction: executionId || hasCapacityOwnership ? "Forge cancels the Builder turn" : "Start the build",
        lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`,
        ...(executionId || hasCapacityOwnership ? ctx.recoveryFields("cancellation_requested", null, "Cancellation was sent to the recorded Developer supervisor.", ctx.state.developerLastHeartbeatAt ?? null) : {}),
        activeOperation: null,
      });
      ctx.markCommandProcessed(command.commandId);
      if (!executionId && !hasCapacityOwnership && ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    });
    await ctx.project();
    if (!executionId && !hasCapacityOwnership) return ctx.state;
    if (!executionId) {
      await ctx.cancelCurrentCapacity();
      await ctx.withStateMutation(() => {
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start the build", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null });
      });
      await ctx.project();
      return ctx.state;
    }
    const result = interruptedCancellation ?? await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId });
    await ctx.withStateMutation(() => {
      if (result.status === "completed_before_cancellation") {
        if (!ctx.applyCompletedDeveloperResult(result.result, "Developer result won the cancellation race and was claimed.")) throw new Error("Completed Developer result is invalid");
        return;
      }
      const cancelled = result.status === "cancelled" || result.status === "cancelled_confirmed";
        const terminal = result.status === "termination_failed" ? "interrupted" : result.status;
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: cancelled ? "The Builder turn was cancelled. The saved work is available for retry." : "summary" in result ? result.summary : "The Builder process is ready for retry", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerOutcome: null, ...ctx.recoveryFields(cancelled ? "cancelled" : terminal === "interrupted" ? "interrupted" : "result_pending_claim", "reasonCode" in result ? result.reasonCode : null, cancelled ? "Developer termination was confirmed; the worktree was preserved." : "summary" in result ? result.summary : "The Developer result won the cancellation race.", ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null });
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    });
    let capacityStateProjected = false;
    if (["cancelled", "cancelled_confirmed", "interrupted"].includes(result.status) && ctx.state.capacity) {
      capacityStateProjected = (await ctx.settleCancelledCapacity(executionId)) !== "none";
    }
    if (!capacityStateProjected) await ctx.project();
    void command;
    return ctx.state;
  }), { validator(rawInput) {
    const command = StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!developerCancellationAvailable()) throw new Error("Developer cancellation is not available in the current phase");
  } });
  ctx.cancelCurrentCapacity = cancelCurrentCapacity;
  ctx.settleCancelledCapacity = settleCancelledCapacity;
  const expected = z.object({ expectedRevision: z.number().int().nonnegative() });
  setHandler(issueUpdates.delete_worktree, ctx.guarded(async (raw: any) => {
    const command = expected.extend({ confirmDiscardDirty: z.boolean().optional() }).parse(raw);
    const result = await cleanupTaskWorktree({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, ...(command.confirmDiscardDirty !== undefined ? { confirmDiscardDirty: command.confirmDiscardDirty } : {}) });
    if (result.outcome === "cleaned" || result.outcome === "already_absent") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, allowedCommands: TERMINAL_PHASES.has(ctx.state.phase) ? ctx.state.allowedCommands.filter((entry) => entry !== "delete_worktree") : ctx.addRevisionCommand([...ctx.state.allowedCommands.filter((entry) => entry !== "delete_worktree"), "recreate_worktree"]), pendingAction: TERMINAL_PHASES.has(ctx.state.phase) ? "Archived" : "Worktree deleted", blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    else if (result.outcome === "dirty_confirmation_required") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "human", allowedCommands: ctx.addRevisionCommand(["delete_worktree", "continue_work"]), pendingAction: `The worktree has ${result.dirtyFileCount} uncommitted changes. Confirm to discard them.`, blocker: stateTransitions.humanBlocker("unsafe_recovery", "The worktree has uncommitted changes. Confirm before Forge deletes them.", [{ command: "delete_worktree", label: "Delete the worktree", requiresNote: false, destructive: false }, { command: "continue_work", label: "Continue in a new task", requiresNote: false, destructive: false }], stateTransitions.evidencePointer(result.evidenceArtifactId, "attention-evidence")), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    else if (result.outcome === "not_owned") throw ApplicationFailure.nonRetryable("Forge does not own the requested worktree", "worktree-not-owned");
    await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.extend({ confirmDiscardDirty: z.boolean().optional() }).parse(raw); if (command.expectedRevision !== ctx.state.revision || ctx.state.activeOperation) throw new Error("Worktree deletion was superseded"); } });
  setHandler(issueUpdates.recreate_worktree, ctx.guarded(async (raw: any) => {
    expected.parse(raw); const result = await recreateTaskWorktree({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha! });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Worktree recreated. The Builder resumes.", worktreePath: result.worktreePath, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }); await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.parse(raw); if (command.expectedRevision !== ctx.state.revision || !ctx.state.allowedCommands.includes("recreate_worktree") || !ctx.state.branchName || !ctx.state.targetBaseSha) throw new Error("Worktree recreation is not available"); } });
  setHandler(issueUpdates.resume_preserved_work, ctx.guarded(async (raw: any) => {
    expected.parse(raw); ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: `The Builder resumes from the saved branch ${ctx.state.branchName}`, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }); await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.parse(raw); if (command.expectedRevision !== ctx.state.revision || ctx.state.step !== "cancelled" || !ctx.state.branchName) throw new Error("Preserved work is unavailable"); } });
}

export function registerLifecycleHandlersContinuation(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.continue_work, ctx.guarded(async (rawInput: any) => {
    const command = ContinueWorkCommandSchema.parse(rawInput);
    const successorTaskId = `${ctx.input.issueId}-successor-${ctx.state.revision}`;
    const successorWorkflowId = `${ctx.input.workflowId}-successor-${ctx.state.revision}`;
    const intentId = `intent_${ctx.input.workflowId}_${ctx.state.revision}`;
    const successor = await createSuccessor({ predecessorTaskId: ctx.input.issueId, predecessorWorkflowId: ctx.input.workflowId, acceptedRevision: ctx.state.revision, successorTaskId, successorWorkflowId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, actorUserId: command.actorUserId, reason: command.reason, intentId });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, successorTaskId: successor.successorTaskId, successorReference: successor, allowedCommands: [], pendingAction: "Work continues in a new task", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, revision: ctx.state.revision + 1 });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = ContinueWorkCommandSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["done", "cancelled", "failed"].includes(ctx.state.step)) throw new Error("Continue work is only available after a terminal issue state");
    if (!ctx.state.allowedCommands.includes("continue_work")) throw new Error("Continue work is not available in the current phase");
  } });
}
