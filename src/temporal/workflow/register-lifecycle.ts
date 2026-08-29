import { ApplicationFailure, condition, setHandler } from "@temporalio/workflow";
import { z } from "zod";

import { TERMINAL_PHASES } from "../../issue-phases.js";
import { assertPayloadWithinLimit } from "../policy.js";
import { ContinueWorkCommandSchema, IssueWorkflowStateSchema, PlanCommandInputSchema, StartPlanningInputSchema } from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import { acceptDelivery, cancelCapacity, cancelCapacityExecution, cancelDeveloperExecution, cleanupTaskWorktree, createSuccessor, finalizeCapacity, inspectCapacity, inspectTaskWorktree, recreateTaskWorktree, recordDeliveryDecision } from "./activity-proxies.js";
import type { IssueWorkflowContext } from "./context.js";
import * as stateTransitions from "./state-transitions.js";

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
  const developerCancellationAvailable = (): boolean => ctx.state.phase === "development" || (ctx.state.phase === "delivery_blocked" && (ctx.state.developerRecoveryStatus === "cancellation_requested" || (ctx.state.developerRecoveryStatus === "interrupted" && ctx.state.capacity !== null)));
  setHandler(issueUpdates.cancel_issue, ctx.guarded(async (rawInput) => {
    if (!ctx.exactPlanAuthorityEnabled && ctx.captureInitialProjectionState) await condition(() => ctx.initialProjectionComplete);
    if (ctx.initialProjectionBarrierEnabled) await ctx.initialProjection;
    const command = PlanCommandInputSchema.parse(rawInput);
    const unconditionalCancellation = true;
    if ((!unconditionalCancellation && command.expectedRevision !== ctx.state.revision) || TERMINAL_PHASES.has(ctx.state.phase)) throw new Error("Issue cancellation is not available in the current phase");
    if (ctx.state.phase === "planning" && ctx.planningScope) {
      ctx.planningScope.cancel();
      await ctx.planningPromise?.catch(() => undefined);
      ctx.planningPromise = undefined;
      ctx.planningScope = undefined;
    }
    if (ctx.state.developerExecutionId && ["starting", "active", "reconnecting", "result_pending_claim", "cancellation_requested", "cancelling"].includes(ctx.state.developerRecoveryStatus ?? "")) {
      const cancellation = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId: ctx.state.developerExecutionId });
      if (cancellation.status === "completed_before_cancellation") {
        if (!unconditionalCancellation && ctx.applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before issue cancellation.")) {
          await ctx.project();
          return ctx.state;
        }
        const result = cancellation.result as { developerExecutionId?: unknown; outcome?: unknown } | undefined;
        if (!unconditionalCancellation && (result?.outcome !== "blocked" || result.developerExecutionId !== ctx.state.developerExecutionId || !ctx.patched(ctx.cancelBlockedDeveloperResultPatch))) throw new Error("Completed Developer result is invalid");
      }
      if (cancellation.status !== "completed_before_cancellation" && !["cancelled", "cancelled_confirmed", "interrupted"].includes(cancellation.status)) {
        const summary = "summary" in cancellation ? cancellation.summary : "Forge could not confirm Developer termination.";
        if (!unconditionalCancellation) {
          ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: summary, ...ctx.recoveryFields("interrupted", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          await ctx.project();
          return ctx.state;
        }
      }
      if (ctx.state.capacity) await settleCancelledCapacity(ctx.state.developerExecutionId);
    } else {
      const cancellation = await cancelCurrentCapacity();
      if (cancellation.executionId) await settleCancelledCapacity(cancellation.executionId);
    }
    let acceptanceStatus = ctx.state.acceptanceStatus;
    let acceptanceReasonArtifactId = ctx.state.acceptanceReasonArtifactId;
    if (ctx.state.acceptanceId && ctx.state.releaseId && ctx.state.deliveryReviewId && ctx.state.finalReviewId && ctx.state.ciRunId && ctx.state.pullRequestNumber && ctx.state.releaseRepository && ctx.state.baseBranch && ctx.state.targetBaseSha && ctx.state.expectedHeadSha && ctx.state.expectedHeadTree && ctx.state.leadSessionRef) {
      const result = await acceptDelivery({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, releaseId: ctx.state.releaseId, deliveryReviewId: ctx.state.deliveryReviewId, finalReviewId: ctx.state.finalReviewId, ciRunId: ctx.state.ciRunId, actorUserId: command.actorUserId, pullRequestNumber: ctx.state.pullRequestNumber, repository: ctx.state.releaseRepository, baseBranch: ctx.state.baseBranch, baseSha: ctx.state.targetBaseSha, leadSessionRef: ctx.state.leadSessionRef, expectedHeadSha: ctx.state.expectedHeadSha, expectedHeadTree: ctx.state.expectedHeadTree, decision: "cancel", ...(command.note !== undefined ? { note: command.note } : {}) });
      acceptanceStatus = result.status;
      acceptanceReasonArtifactId = result.reasonArtifactId ?? acceptanceReasonArtifactId;
    } else if (command.note?.trim()) {
      const decision = await recordDeliveryDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, note: command.note });
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, deliveryDecisionArtifactId: decision.artifactId });
    }
    const resume = ctx.patched("forge-recoverable-cancellation-v1") && ctx.state.branchName ? ["resume_preserved_work" as const] : [];
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "cancelled", owner: "human", allowedCommands: [...(ctx.reviseContinueEnabled ? ["continue_work" as const] : []), ...resume], pendingAction: "Issue cancelled", acceptanceStatus, acceptanceReasonArtifactId, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  }));
  setHandler(issueUpdates.cancel_development, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("cancel development command", rawInput);
    const command = StartPlanningInputSchema.parse(rawInput);
    if (!ctx.durablePlanningCapacityEnabled()) {
      if (ctx.commandAlreadyProcessed(command.commandId)) return ctx.state;
      if (!ctx.state.developerExecutionId) {
        await ctx.withStateMutation(() => {
          if (ctx.state.revision !== command.expectedRevision || !developerCancellationAvailable()) throw new Error("Developer cancellation was superseded by another command");
          ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null });
          ctx.markCommandProcessed(command.commandId);
          if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
        });
        await ctx.project();
        return ctx.state;
      }
      const executionId = ctx.state.developerExecutionId;
      await ctx.withStateMutation(() => {
        if (ctx.state.revision !== command.expectedRevision || !developerCancellationAvailable()) throw new Error("Developer cancellation was superseded by another command");
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: "Cancelling Developer turn", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("cancellation_requested", null, "Cancellation was sent to the recorded Developer supervisor.", ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null });
        ctx.markCommandProcessed(command.commandId);
      });
      await ctx.project();
      const result = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId });
      await ctx.withStateMutation(() => {
        if (result.status === "completed_before_cancellation") {
          if (!ctx.applyCompletedDeveloperResult(result.result, "Developer result won the cancellation race and was claimed.")) throw new Error("Completed Developer result is invalid");
          return;
        }
        const cancelled = result.status === "cancelled" || result.status === "cancelled_confirmed";
        const terminal = result.status === "termination_failed" ? "interrupted" : result.status;
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: cancelled ? "Developer turn cancelled; preserved work is available for retry" : "summary" in result ? result.summary : "Developer process is ready for retry", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerOutcome: null, ...ctx.recoveryFields(cancelled ? "cancelled" : terminal === "interrupted" ? "interrupted" : "result_pending_claim", "reasonCode" in result ? result.reasonCode : null, cancelled ? "Developer termination was confirmed; the worktree was preserved." : "summary" in result ? result.summary : "The Developer result won the cancellation race.", ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null });
        if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      });
      await ctx.project();
      void command;
      return ctx.state;
    }
    if (ctx.commandAlreadyProcessed(command.commandId)) return ctx.state;
    const executionId = ctx.state.developerExecutionId;
    const hasCapacityOwnership = ctx.state.capacity !== null;
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || !developerCancellationAvailable()) throw new Error("Developer cancellation was superseded by another command");
      ctx.state = IssueWorkflowStateSchema.parse({
        ...ctx.state,
        revision: ctx.state.revision + 1,
        phase: executionId || hasCapacityOwnership ? "delivery_blocked" : "ready_for_development",
        owner: executionId || hasCapacityOwnership ? "human" : "lead",
        allowedCommands: executionId || hasCapacityOwnership ? ctx.addRevisionCommand(["retry_development", "cancel_issue"]) : ["start_development", "cancel_issue"],
        pendingAction: executionId || hasCapacityOwnership ? "Cancelling Developer turn" : "Start development",
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
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null });
      });
      await ctx.project();
      return ctx.state;
    }
    const result = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId });
    await ctx.withStateMutation(() => {
      if (result.status === "completed_before_cancellation") {
        if (!ctx.applyCompletedDeveloperResult(result.result, "Developer result won the cancellation race and was claimed.")) throw new Error("Completed Developer result is invalid");
        return;
      }
      const cancelled = result.status === "cancelled" || result.status === "cancelled_confirmed";
        const terminal = result.status === "termination_failed" ? "interrupted" : result.status;
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: cancelled ? "Developer turn cancelled; preserved work is available for retry" : "summary" in result ? result.summary : "Developer process is ready for retry", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerOutcome: null, ...ctx.recoveryFields(cancelled ? "cancelled" : terminal === "interrupted" ? "interrupted" : "result_pending_claim", "reasonCode" in result ? result.reasonCode : null, cancelled ? "Developer termination was confirmed; the worktree was preserved." : "summary" in result ? result.summary : "The Developer result won the cancellation race.", ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null });
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
  setHandler(issueUpdates.delete_worktree, ctx.guarded(async (raw) => {
    const command = expected.extend({ confirmDiscardDirty: z.boolean().optional() }).parse(raw);
    if (ctx.state.worktreeState === "cleaned") return ctx.state;
    const result = await cleanupTaskWorktree({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, ...(command.confirmDiscardDirty !== undefined ? { confirmDiscardDirty: command.confirmDiscardDirty } : {}) });
    if (result.outcome === "cleaned" || result.outcome === "already_absent") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, worktreeState: "cleaned", allowedCommands: ctx.state.allowedCommands.filter((entry) => entry !== "delete_worktree"), pendingAction: TERMINAL_PHASES.has(ctx.state.phase) ? "Archived" : "Worktree deleted", blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    else if (result.outcome === "dirty_confirmation_required") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "human", allowedCommands: ctx.addRevisionCommand(["delete_worktree", "continue_work"]), pendingAction: `Worktree has ${result.dirtyFileCount} uncommitted changes — confirm to discard`, blocker: stateTransitions.humanBlocker("unsafe_recovery", "Worktree has uncommitted changes that require confirmation before deletion.", [{ command: "delete_worktree", label: "Discard changes and delete worktree", requiresNote: false, destructive: false }, { command: "continue_work", label: "Keep worktree", requiresNote: false, destructive: false }], stateTransitions.evidencePointer(result.evidenceArtifactId, "attention-evidence")), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    else if (result.outcome === "not_owned") throw ApplicationFailure.nonRetryable("Forge does not own the requested worktree", "worktree-not-owned");
    await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.extend({ confirmDiscardDirty: z.boolean().optional() }).parse(raw); if (command.expectedRevision !== ctx.state.revision || ctx.state.activeOperation) throw new Error("Worktree deletion was superseded"); } });
  setHandler(issueUpdates.recreate_worktree, ctx.guarded(async (raw) => {
    expected.parse(raw); const result = await recreateTaskWorktree({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha! });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Worktree recreated; resuming Developer", worktreePath: result.worktreePath, worktreeState: "present", blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }); await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.parse(raw); if (command.expectedRevision !== ctx.state.revision || ctx.state.worktreeState !== "removed_externally" || !ctx.state.branchName || !ctx.state.targetBaseSha) throw new Error("Worktree recreation is not available"); } });
  setHandler(issueUpdates.resume_preserved_work, ctx.guarded(async (raw) => {
    expected.parse(raw); ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: `Resuming from preserved branch ${ctx.state.branchName}`, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }); await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.parse(raw); if (command.expectedRevision !== ctx.state.revision || ctx.state.phase !== "cancelled" || !ctx.state.branchName) throw new Error("Preserved work is unavailable"); } });
  setHandler(issueUpdates.report_worktree_missing, ctx.guarded(async (raw) => {
    const command = expected.extend({ worktreePath: z.string().min(1) }).parse(raw); if (["done", "cancelled", "failed"].includes(ctx.state.phase)) { await ctx.recordHandlerNoop("report_worktree_missing", "The terminal task's missing worktree was recorded as history only."); return ctx.state; }
    const inspected = await inspectTaskWorktree({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "human", allowedCommands: ctx.addRevisionCommand(["recreate_worktree", "cancel_issue"]), pendingAction: "Local worktree is missing", worktreeState: "removed_externally", blocker: stateTransitions.humanBlocker("unsafe_recovery", "The local worktree at " + command.worktreePath + " no longer exists.", [{ command: "recreate_worktree", label: "Recreate worktree and resume", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(inspected.evidenceArtifactId, "attention-evidence")), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }); await ctx.project(); return ctx.state;
  }), { validator(raw) { const command = expected.extend({ worktreePath: z.string().min(1) }).parse(raw); if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision"); } });
}

export function registerLifecycleHandlersContinuation(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.continue_work, ctx.guarded(async (rawInput) => {
    const command = ContinueWorkCommandSchema.parse(rawInput);
    const successorTaskId = `${ctx.input.issueId}-successor-${ctx.state.revision}`;
    const successorWorkflowId = `${ctx.input.workflowId}-successor-${ctx.state.revision}`;
    const intentId = `intent_${ctx.input.workflowId}_${ctx.state.revision}`;
    const successor = await createSuccessor({ predecessorTaskId: ctx.input.issueId, predecessorWorkflowId: ctx.input.workflowId, acceptedRevision: ctx.state.revision, successorTaskId, successorWorkflowId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, actorUserId: command.actorUserId, reason: command.reason, intentId });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, successorTaskId: successor.successorTaskId, successorReference: successor, allowedCommands: [], pendingAction: "Continued in a new task", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, revision: ctx.state.revision + 1 });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = ContinueWorkCommandSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["done", "cancelled", "failed"].includes(ctx.state.phase)) throw new Error("Continue work is only available after a terminal issue state");
    if (!ctx.state.allowedCommands.includes("continue_work")) throw new Error("Continue work is not available in the current phase");
  } });
  // Escape hatch: re-persist the projection from the workflow's current in-memory state.
  // No revision check, no phase restriction — it must work even when the DB projection
  // has drifted from ctx.state, which is exactly the situation this command repairs.
  setHandler(issueUpdates.resync_projection, ctx.guarded(async () => {
    await ctx.project();
    return ctx.state;
  }));
}
