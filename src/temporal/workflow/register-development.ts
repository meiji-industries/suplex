import { setHandler } from "@temporalio/workflow";
import { assertPayloadWithinLimit } from "../policy.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { developerExecutionId } from "../deterministic-id.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueWorkflowContext } from "./context.js";
import { classifyDelivery } from "../../developer-contracts.js";
export async function blockFailedDeveloperStart(ctx: IssueWorkflowContext, command: contracts.StartPlanningInput, executionId: string, error: unknown): Promise<boolean> {
  if (!ctx.supervisedDeveloperTurns || !ctx.patched("forge-developer-start-failure-blocked-v1") || ctx.state.developerExecutionId !== executionId || ctx.state.developerOutcome) return false;
  const summary = `Developer could not start: ${error instanceof Error ? error.message : String(error)}`;
  const blocked = await ctx.withStateMutation(() => {
    if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("failed", null, summary, null), activeOperation: null });
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    return true;
  });
  if (blocked) await ctx.project();
  return blocked;
}

export async function startDevelopment(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
    const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(ctx.herdrExecutionSubstrateEnabled) };
    if (ctx.commandAlreadyProcessed(command.commandId)) {
      await ctx.recordHandlerNoop("start_development", "This development command was already processed.");
      return ctx.state;
    }
    const priorCommit = ctx.state.resultCommit ?? ctx.state.targetBaseSha ?? null;
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const executionId = ctx.supervisedDeveloperTurns ? developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "implementation", ctx.patched("forge-unique-developer-execution-id-v1") ? command.commandId : undefined) : `developer_${ctx.state.workflowId}_${command.commandId}`.slice(0, 256);
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || ctx.state.phase !== "ready_for_development") throw new Error("Development start was superseded by another command");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...stateTransitions.freshDeliveryLineage(), revision: ctx.state.revision + 1, phase: "development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: "Developer execution", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: executionId, developerAttempt, developerTurnKind: "implementation", ...ctx.recoveryFields("starting", null, null, null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: ctx.state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
      ctx.markCommandProcessed(command.commandId);
    });
    await ctx.project();
    const legacyInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, ...(ctx.state.developerContinuation ? { continuation: { ...ctx.state.developerContinuation, previousDeliverySummary: ctx.state.deliverySummary ?? "Prior delivery" } } : {}), ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}), ...(ctx.state.finalPlanSubject ? { finalPlanSubject: ctx.state.finalPlanSubject } : {}), ...(ctx.state.materialityEvidence ? { materialityEvidence: ctx.state.materialityEvidence } : {}), ...(ctx.state.planDecisionReceipt ? { approvalDecisionId: ctx.state.planDecisionReceipt.decisionId } : {}), ...(ctx.input.runProjectTests !== undefined ? { runProjectTests: ctx.input.runProjectTests } : {}), ...(ctx.input.visualEvidence !== undefined ? { visualEvidence: ctx.input.visualEvidence } : {}) };
    const recoverDeveloperFailures = ctx.supervisedDeveloperTurns ? false : ctx.patched(ctx.developerFailureRecoveryPatch);
    let outcome: Awaited<ReturnType<typeof activityProxies.runDeveloperExecutionSupervised>> | { status: "completed"; result: Awaited<ReturnType<typeof activityProxies.runDeveloperExecution>>; resultHash: string };
    try {
      outcome = await ctx.acquireExternalTurn(
        { operation: "developer_execution", role: "builder", profileId: ctx.input.roleProfiles.builder, ...(ctx.state.developerContinuation ? { sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath } : {}) },
        (capacityRequestId) => ctx.supervisedDeveloperTurns
          ? activityProxies.runDeveloperExecutionSupervised({ ...legacyInput, developerTurnExecutionId: executionId, developerAttempt, turnKind: "implementation", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : activityProxies.runDeveloperExecution({ ...legacyInput, executionId, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
    } catch (error) {
      if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") {
        await ctx.recordHandlerNoop("start_development", "Development was superseded before the Developer result could be applied.");
        return ctx.state;
      }
      const failedToStart = ctx.supervisedDeveloperTurns && ctx.patched("forge-developer-start-failure-blocked-v1") && ctx.state.developerExecutionId === executionId && !ctx.state.developerOutcome;
      if (failedToStart) {
        const autoRetryStartFailure = developerAttempt === 1 && ctx.patched("forge-developer-start-failure-auto-retry-v1");
        if (autoRetryStartFailure) {
          const retried = await ctx.withStateMutation(() => {
            if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
            ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer could not start; Forge is starting the one automatic retry.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("failed", null, `Developer could not start: ${error instanceof Error ? error.message : String(error)}`, null), activeOperation: null });
            if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
            return true;
          });
          if (retried) {
            await ctx.project();
            return startDevelopment(ctx, { ...command, expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-retry-development-start:${ctx.state.revision}` });
          }
        }
        if (await blockFailedDeveloperStart(ctx, command, executionId, error)) return ctx.state;
        await ctx.recordHandlerNoop("start_development", "Development was superseded before the Developer result could be applied.");
        return ctx.state;
      }
      if (ctx.supervisedDeveloperTurns || !recoverDeveloperFailures) throw error;
      const recovered = await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer execution failed; retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null });
        if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
        return true;
      });
      if (recovered) await ctx.project();
      return ctx.state;
    }
    let autoRetry = false;
    let autoContinue = false;
    const applied = await ctx.withStateMutation(() => {
      if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
      if (outcome.status === "completed") {
        const result = outcome.result;
        const disposition = result.outcome === "blocked" && ctx.patched("forge-developer-continuation-v1") ? classifyDelivery({ steps: result.steps ?? [], authorizedStepsNotCompleted: result.authorizedStepsNotCompleted ?? [], dirtyState: result.dirtyState, resultCommit: result.resultCommit ?? null, blocker: result.blocker ?? null }, priorCommit) : "blocked";
        if (disposition === "incomplete") {
          const remainingSteps = result.authorizedStepsNotCompleted ?? [];
          const completedSteps = (result.steps ?? []).filter((step) => step.status === "completed" || step.status === "not_applicable_locally").map((step) => step.number);
          const progress = stateTransitions.withRepairProgress(ctx.state, { signature: stateTransitions.repairSignature({ source: "review", code: "developer-continuation", firstFailingLine: remainingSteps.join(",") }), commit: result.resultCommit ?? null, diagnosticHash: null });
          const stalled = stateTransitions.noProgress(ctx.state.repairProgress, progress.repairProgress!);
          autoContinue = !stalled;
          const summary = stalled ? `Automatic continuation is not making progress: steps ${remainingSteps.join(",")} remain after ${(ctx.state.developerContinuation?.turnsUsed ?? 0) + 1} turns.` : `Developer completed steps ${completedSteps.join(",")}; continuing with steps ${remainingSteps.join(",")}`;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...progress, revision: ctx.state.revision + 1, phase: stalled ? "delivery_blocked" : "ready_for_development", owner: stalled ? "human" : "lead", allowedCommands: stalled ? ctx.addRevisionCommand(["retry_development", "cancel_issue"]) : ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, developerContinuation: { remainingSteps, completedSteps, previousCommit: result.resultCommit!, turnsUsed: (ctx.state.developerContinuation?.turnsUsed ?? 0) + 1 }, activeOperation: null, blocker: stalled ? stateTransitions.humanBlocker("agent_exhausted", summary, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.evidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
          if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
          return true;
        }
        const typedBlockedState = result.outcome === "blocked" && ctx.patched(ctx.developerBlockedRecoveryStatePatch);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, ...ctx.recoveryFields(typedBlockedState ? "failed" : "active", typedBlockedState ? result.failureCode ?? null : null, typedBlockedState ? result.deliverySummary : "Developer result claimed.", null), activeOperation: null, blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker(result.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
      } else {
        autoRetry = outcome.status === "interrupted" && developerAttempt === 1 && ctx.patched("forge-developer-auto-retry-v1");
        const resumeTurn = outcome.status === "failed" && ["turn_outcome_missing", "turn_stalled"].includes(outcome.reasonCode ?? "") && ctx.patched("forge-turn-outcome-recovery-v1");
        const startupBlocked = outcome.status === "failed" && outcome.reasonCode === "agent_startup_blocked" && ctx.patched("forge-turn-outcome-recovery-v1");
        const allowedCommands = autoRetry ? ctx.addRevisionCommand(["start_development", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]);
        const attentionEvidence = outcome.status === "failed" ? outcome.evidenceArtifactId ?? undefined : undefined;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: autoRetry ? "ready_for_development" : "delivery_blocked", owner: autoRetry ? "lead" : "human", allowedCommands, pendingAction: resumeTurn ? "Resume Developer turn" : autoRetry ? "Developer process ended; Forge is starting the one automatic retry." : outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null, blocker: startupBlocked ? stateTransitions.humanBlocker("member_authorization", outcome.summary, [{ command: "retry_development", label: "Retry after answering the agent prompt", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : resumeTurn ? stateTransitions.humanBlocker("agent_exhausted", outcome.summary, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : null });
      }
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      return true;
    });
    // Snapshot before projecting: the auto-chain can claim the next phase while this
    // command's own result is still being handed back to the caller.
    const settled = ctx.state;
    if (applied) await ctx.project();
    if (applied && (autoRetry || autoContinue)) return startDevelopment(ctx, { ...command, expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:${autoContinue ? "continue-development" : "auto-retry-development"}:${ctx.state.revision}` });
    void command;
    return settled;
}

export async function retryDevelopment(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>, operatorNote?: string): Promise<contracts.IssueWorkflowState> {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(ctx.herdrExecutionSubstrateEnabled) };
  if (ctx.commandAlreadyProcessed(command.commandId)) {
    await ctx.recordHandlerNoop("retry_development", "This retry command was already processed.");
    return ctx.state;
  }
  // Retain this marker for retries recorded before retry_development always started
  // a fresh turn. Those histories invoked the patch regardless of reconcileOnly.
  const reconciliationEnabled = ctx.patched(ctx.developerReconciliationRecoveryPatch);
  const reconcileOnly = command.reconcileOnly === true;
  const recovered = reconcileOnly && reconciliationEnabled
    ? await activityProxies.findRecoverableDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId })
    : null;
  if (reconcileOnly && !recovered) {
    await ctx.recordHandlerNoop("retry_development", "No recoverable Developer execution exists; Forge did not start a retry.");
    return ctx.state;
  }
  const planRevision = recovered?.planRevision ?? ctx.state.planRevision ?? ctx.state.revision;
  const developerAttempt = recovered?.attempt ?? (ctx.state.developerAttempt ?? 0) + 1;
  const supersedesExecutionId = ctx.state.developerExecutionId!;
  const executionId = recovered?.executionId ?? (ctx.supervisedDeveloperTurns ? developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "implementation", ctx.patched("forge-unique-developer-execution-id-v1") ? command.commandId : undefined) : `developer_${ctx.state.workflowId}_${command.commandId}`.slice(0, 256));
  await ctx.withStateMutation(() => {
    if (ctx.state.revision !== command.expectedRevision || (reconcileOnly ? !["development", "delivery_blocked"].includes(ctx.state.phase) : !["ready_for_development", "development", "delivery_blocked", "failed"].includes(ctx.state.phase))) throw new Error("Developer retry was superseded by another command");
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...(reconcileOnly ? {} : stateTransitions.freshDeliveryLineage()), revision: ctx.state.revision + 1, phase: "development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: reconcileOnly ? "Recovering Developer execution" : "Developer retry", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: executionId, developerSessionRef: recovered?.sessionRef ?? ctx.state.developerSessionRef, developerAttempt, developerTurnKind: "implementation", ...ctx.recoveryFields(reconcileOnly ? "reconnecting" : "starting", null, reconcileOnly ? "Resuming the existing Developer execution." : "Starting a linked Developer retry.", null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: ctx.state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
    ctx.markCommandProcessed(command.commandId);
  });
  await ctx.project();
  const legacyInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}), ...(reconcileOnly ? { reuseWorktree: true } : { supersedesExecutionId, reuseWorktree: true }), ...(operatorNote ? { operatorNote } : {}), ...(ctx.state.finalPlanSubject ? { finalPlanSubject: ctx.state.finalPlanSubject } : {}), ...(ctx.state.materialityEvidence ? { materialityEvidence: ctx.state.materialityEvidence } : {}), ...(ctx.state.planDecisionReceipt ? { approvalDecisionId: ctx.state.planDecisionReceipt.decisionId } : {}), ...(ctx.input.runProjectTests != null ? { runProjectTests: ctx.input.runProjectTests } : {}), ...(ctx.input.visualEvidence ? { visualEvidence: ctx.input.visualEvidence } : {}) };
  let outcome: Awaited<ReturnType<typeof activityProxies.runDeveloperExecutionSupervised>> | { status: "completed"; result: Awaited<ReturnType<typeof activityProxies.runDeveloperExecution>>; resultHash: string };
  try {
    outcome = reconcileOnly
      ? await (ctx.supervisedDeveloperTurns
        ? activityProxies.runDeveloperExecutionSupervised({ ...legacyInput, developerTurnExecutionId: executionId, developerAttempt, turnKind: "implementation" })
        : activityProxies.runDeveloperExecution({ ...legacyInput, executionId }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })))
      : await ctx.acquireExternalTurn(
        { operation: "developer_execution", role: "builder", profileId: ctx.input.roleProfiles.builder, sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => ctx.supervisedDeveloperTurns
          ? activityProxies.runDeveloperExecutionSupervised({ ...legacyInput, developerTurnExecutionId: executionId, developerAttempt, turnKind: "implementation", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : activityProxies.runDeveloperExecution({ ...legacyInput, executionId, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
  } catch (error) {
    if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") {
      await ctx.recordHandlerNoop("retry_development", "Developer retry was superseded before the result could be applied.");
      return ctx.state;
    }
    const failedToStart = ctx.supervisedDeveloperTurns && ctx.patched("forge-developer-start-failure-blocked-v1") && ctx.state.developerExecutionId === executionId && !ctx.state.developerOutcome;
    if (failedToStart) {
      const autoRetryStartFailure = developerAttempt === 1 && ctx.patched("forge-developer-start-failure-auto-retry-v1");
      if (autoRetryStartFailure) {
        const retried = await ctx.withStateMutation(() => {
          if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer could not start; Forge is starting the one automatic retry.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("failed", null, `Developer could not start: ${error instanceof Error ? error.message : String(error)}`, null), activeOperation: null });
          if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
          return true;
        });
        if (retried) {
          await ctx.project();
          return retryDevelopment(ctx, { ...command, expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-retry-development-start:${ctx.state.revision}` }, operatorNote);
        }
      }
      if (await blockFailedDeveloperStart(ctx, command, executionId, error)) return ctx.state;
      await ctx.recordHandlerNoop("retry_development", "Developer retry was superseded before the result could be applied.");
      return ctx.state;
    }
    throw error;
  }
  const applied = await ctx.withStateMutation(() => {
    if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
    if (outcome.status === "completed") {
      const result = outcome.result;
      const typedBlockedState = result.outcome === "blocked" && ctx.patched(ctx.developerBlockedRecoveryStatePatch);
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, ...ctx.recoveryFields(typedBlockedState ? "failed" : "active", typedBlockedState ? result.failureCode ?? null : null, typedBlockedState ? result.deliverySummary : "Developer result claimed.", null), blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker(result.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
    } else {
      const resumeTurn = outcome.status === "failed" && ["turn_outcome_missing", "turn_stalled"].includes(outcome.reasonCode ?? "") && ctx.patched("forge-turn-outcome-recovery-v1");
      const startupBlocked = outcome.status === "failed" && outcome.reasonCode === "agent_startup_blocked" && ctx.patched("forge-turn-outcome-recovery-v1");
      const allowedCommands = ctx.addRevisionCommand(["retry_development", "cancel_issue"]);
      const attentionEvidence = outcome.status === "failed" ? outcome.evidenceArtifactId ?? undefined : undefined;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands, pendingAction: resumeTurn ? "Resume Developer turn" : outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null, blocker: startupBlocked ? stateTransitions.humanBlocker("member_authorization", outcome.summary, [{ command: "retry_development", label: "Retry after answering the agent prompt", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : resumeTurn ? stateTransitions.humanBlocker("agent_exhausted", outcome.summary, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : null });
    }
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    return true;
  });
  if (applied) await ctx.project();
  else await ctx.recordHandlerNoop("retry_development", "Developer retry was superseded before the result could be applied.");
  return ctx.state;
}

export function registerDevelopmentHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.start_development, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("start development command", rawInput);
    return startDevelopment(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "ready_for_development") throw new Error("Development can only start after plan approval");
    if (ctx.state.planMaterial === null || ctx.state.planMaterial === undefined || !ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef) throw new Error("A validated Lead plan is required before development");
    if (ctx.state.planApproved !== true) throw new Error("A plan must be approved before development");
  } });
  setHandler(issueUpdates.retry_development, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("retry development command", rawInput);
    return retryDevelopment(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "development" && ctx.state.phase !== "delivery_blocked" && !(ctx.state.phase === "failed" && ctx.patched("forge-failed-retry-v1") && ctx.state.planMaterial === true && ctx.state.leadOutputArtifactId && ctx.state.leadSessionRef)) throw new Error("Developer retry is not available in the current phase");
    // Materiality only has to be decided, not true — same check start_development makes.
    // Truthiness here made every routine (non-material) plan permanently unretryable.
    if (!ctx.state.developerExecutionId || ctx.state.planMaterial === null || ctx.state.planMaterial === undefined || !ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef) throw new Error("A preserved Developer attempt and approved plan are required before retry");
  } });

}
