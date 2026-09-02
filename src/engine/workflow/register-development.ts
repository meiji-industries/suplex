import { at, isBlocked } from "../../issue-phases.js";
import { setHandler } from "../registry.js";
import { assertPayloadWithinLimit } from "../policy.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { developerExecutionId } from "../deterministic-id.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueWorkflowContext } from "./context.js";
import { classifyDelivery } from "../../developer-contracts.js";
export async function blockFailedDeveloperStart(ctx: IssueWorkflowContext, command: contracts.StartPlanningInput, executionId: string, error: unknown): Promise<boolean> {
  if (!ctx.supervisedDeveloperTurns || !true || ctx.state.developerExecutionId !== executionId || ctx.state.developerOutcome) return false;
  const failure = typeof ctx.permanentActivityFailure === "function" ? ctx.permanentActivityFailure(error) : undefined;
  const summary = `Developer could not start: ${failure?.summary ?? (error instanceof Error ? error.message : String(error))}`;
  const branchCheckedOut = failure?.code === "branch_checked_out" || /already checked out/i.test(summary);
  const blocked = await ctx.withStateMutation(() => {
    if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") return false;
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("failed", branchCheckedOut ? "branch_checked_out" : failure?.code ?? null, summary, null), activeOperation: null, blocker: stateTransitions.humanBlocker(failure?.category ?? "unsafe_recovery", summary, [{ command: "cancel_issue", label: "Cancel this duplicate task", requiresNote: false, destructive: true }, { command: "retry_development", label: "Retry after the other task finishes", requiresNote: false, destructive: false }], failure?.evidenceArtifactId ? stateTransitions.evidencePointer(failure.evidenceArtifactId ?? undefined, "attention-evidence") : stateTransitions.evidencePointer(ctx.state.leadOutputArtifactId ?? undefined, "lead-plan")) });
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    return true;
  });
  if (blocked) await ctx.project();
  return blocked;
}

export async function startDevelopment(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
    const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
    if (ctx.commandAlreadyProcessed(command.commandId)) {
      await ctx.recordHandlerNoop("start_development", "This development command was already processed.");
      return ctx.state;
    }
    const priorCommit = ctx.state.resultCommit ?? ctx.state.targetBaseSha ?? null;
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const executionId = ctx.supervisedDeveloperTurns ? developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "implementation", true ? command.commandId : undefined) : `developer_${ctx.state.workflowId}_${command.commandId}`.slice(0, 256);
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || ctx.state.step !== "ready_for_development") throw new Error("Development start was superseded by another command");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...stateTransitions.freshDeliveryLineage(), revision: ctx.state.revision + 1, ...at("development"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: "Developer execution", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: executionId, developerAttempt, developerTurnKind: "implementation", ...ctx.recoveryFields("starting", null, null, null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: ctx.state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
      ctx.markCommandProcessed(command.commandId);
    });
    await ctx.project();
    const legacyInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, ...(ctx.state.developerContinuation ? { continuation: { ...ctx.state.developerContinuation, previousDeliverySummary: ctx.state.deliverySummary ?? "Prior delivery" } } : {}), ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}), ...(ctx.state.finalPlanSubject ? { finalPlanSubject: ctx.state.finalPlanSubject } : {}), ...(ctx.state.materialityEvidence ? { materialityEvidence: ctx.state.materialityEvidence } : {}), ...(ctx.state.planDecisionReceipt ? { approvalDecisionId: ctx.state.planDecisionReceipt.decisionId } : {}), ...(ctx.input.runProjectTests !== undefined ? { runProjectTests: ctx.input.runProjectTests } : {}), ...(ctx.input.visualEvidence !== undefined ? { visualEvidence: ctx.input.visualEvidence } : {}) };
    const recoverDeveloperFailures = ctx.supervisedDeveloperTurns ? false : true;
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
      if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") {
        await ctx.recordHandlerNoop("start_development", "Development was superseded before the Developer result could be applied.");
        return ctx.state;
      }
      const failedToStart = ctx.supervisedDeveloperTurns && true && ctx.state.developerExecutionId === executionId && !ctx.state.developerOutcome;
      if (failedToStart) {
        const autoRetryStartFailure = developerAttempt === 1 && true && ctx.permanentActivityFailure(error)?.code !== "branch_checked_out" && !/already checked out/i.test(error instanceof Error ? error.message : String(error));
        if (autoRetryStartFailure) {
          const retried = await ctx.withStateMutation(() => {
            if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") return false;
            ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer could not start; Forge is starting the one automatic retry.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("failed", null, `Developer could not start: ${error instanceof Error ? error.message : String(error)}`, null), activeOperation: null });
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
        if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") return false;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer execution failed; retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null });
        if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
        return true;
      });
      if (recovered) await ctx.project();
      return ctx.state;
    }
    let autoRetry = false;
    let autoContinue = false;
    const applied = await ctx.withStateMutation(() => {
      if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") return false;
      if (outcome.status === "completed") {
        const result = outcome.result;
        const disposition = result.outcome === "blocked" && true ? classifyDelivery({ steps: result.steps ?? [], authorizedStepsNotCompleted: result.authorizedStepsNotCompleted ?? [], dirtyState: result.dirtyState, resultCommit: result.resultCommit ?? null, blocker: result.blocker ?? null }, priorCommit) : "blocked";
        const repeatedContinuation = result.outcome === "blocked" && true
          && ctx.state.developerContinuation
          && result.dirtyState === "clean"
          && (result.authorizedStepsNotCompleted ?? []).join(",") === ctx.state.developerContinuation.remainingSteps.join(",");
        if (disposition === "incomplete" || repeatedContinuation) {
          const remainingSteps = result.authorizedStepsNotCompleted ?? [];
          const completedSteps = (result.steps ?? []).filter((step) => step.status === "completed" || step.status === "not_applicable_locally").map((step) => step.number);
          const progress = stateTransitions.withRepairProgress(ctx.state, { signature: stateTransitions.repairSignature({ source: "review", code: "developer-continuation", firstFailingLine: remainingSteps.join(",") }), commit: result.resultCommit ?? null, diagnosticHash: null });
          const stalled = stateTransitions.noProgress(ctx.state.repairProgress, progress.repairProgress!);
          autoContinue = !stalled;
          const summary = stalled ? `Automatic continuation is not making progress: steps ${remainingSteps.join(",")} remain after ${(ctx.state.developerContinuation?.turnsUsed ?? 0) + 1} turns.` : `Developer completed steps ${completedSteps.join(",")}; continuing with steps ${remainingSteps.join(",")}`;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...progress, revision: ctx.state.revision + 1, ...at(stalled ? "development" : "ready_for_development"), owner: stalled ? "human" : "lead", allowedCommands: stalled ? ctx.addRevisionCommand(["retry_development", "cancel_issue"]) : ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, developerContinuation: { remainingSteps, completedSteps, previousCommit: result.resultCommit!, turnsUsed: (ctx.state.developerContinuation?.turnsUsed ?? 0) + 1 }, activeOperation: null, blocker: stalled ? stateTransitions.humanBlocker("agent_exhausted", summary, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.evidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
          if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
          return true;
        }
        const typedBlockedState = result.outcome === "blocked" && true;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at(result.outcome === "completed" ? "delivery_ready" : "development"), owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, developerContinuation: result.outcome === "completed" ? null : ctx.state.developerContinuation, ...ctx.recoveryFields(typedBlockedState ? "failed" : "active", typedBlockedState ? result.failureCode ?? null : null, typedBlockedState ? result.deliverySummary : "Developer result claimed.", null), activeOperation: null, blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker(result.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
      } else {
        autoRetry = outcome.status === "interrupted" && developerAttempt === 1 && true;
        const resumeTurn = outcome.status === "failed" && ["turn_outcome_missing", "turn_stalled"].includes(outcome.reasonCode ?? "") && true;
        const startupBlocked = outcome.status === "failed" && outcome.reasonCode === "agent_startup_blocked" && true;
        const allowedCommands = autoRetry ? ctx.addRevisionCommand(["start_development", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]);
        const attentionEvidence = outcome.status === "failed" ? outcome.evidenceArtifactId ?? undefined : undefined;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at(autoRetry ? "ready_for_development" : "development"), owner: autoRetry ? "lead" : "human", allowedCommands, pendingAction: resumeTurn ? "Resume Developer turn" : autoRetry ? "Developer process ended; Forge is starting the one automatic retry." : outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null, blocker: startupBlocked ? stateTransitions.humanBlocker("member_authorization", outcome.summary, [{ command: "retry_development", label: "Retry after answering the agent prompt", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : resumeTurn ? stateTransitions.humanBlocker("agent_exhausted", outcome.summary, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : null });
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
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  if (ctx.commandAlreadyProcessed(command.commandId)) {
    await ctx.recordHandlerNoop("retry_development", "This retry command was already processed.");
    return ctx.state;
  }
  // Retain this marker for retries recorded before retry_development always started
  // a fresh turn. Those histories invoked the patch regardless of reconcileOnly.
  const reconciliationEnabled = true;
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
  // A human Resume after automatic continuation stopped is still the same
  // Developer job. Keep its committed progress and send only the remaining work.
  const continuation = true
    && ctx.state.developerContinuation
    && ["blocked", "completed"].includes(ctx.state.developerOutcome ?? "")
    && ctx.state.dirtyState === "clean"
    && ctx.state.resultCommit
    && ctx.state.resultCommit !== ctx.state.targetBaseSha
    ? { ...ctx.state.developerContinuation, previousDeliverySummary: ctx.state.deliverySummary ?? "Prior delivery" }
    : undefined;
  const executionId = recovered?.executionId ?? (ctx.supervisedDeveloperTurns ? developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "implementation", true ? command.commandId : undefined) : `developer_${ctx.state.workflowId}_${command.commandId}`.slice(0, 256));
  await ctx.withStateMutation(() => {
    if (ctx.state.revision !== command.expectedRevision || (reconcileOnly ? !["development"].includes(ctx.state.step) : !["ready_for_development", "development"].includes(ctx.state.step))) throw new Error("Developer retry was superseded by another command");
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...(reconcileOnly ? {} : stateTransitions.freshDeliveryLineage()), revision: ctx.state.revision + 1, ...at("development"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: reconcileOnly ? "Recovering Developer execution" : "Developer retry", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: executionId, developerSessionRef: recovered?.sessionRef ?? ctx.state.developerSessionRef, developerAttempt, developerTurnKind: "implementation", ...ctx.recoveryFields(reconcileOnly ? "reconnecting" : "starting", null, reconcileOnly ? "Resuming the existing Developer execution." : "Starting a linked Developer retry.", null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: ctx.state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
    ctx.markCommandProcessed(command.commandId);
  });
  await ctx.project();
  const legacyInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, ...(continuation ? { continuation } : {}), ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}), ...(reconcileOnly ? { supersedesExecutionId: recovered?.supersedesExecutionId ?? undefined, reuseWorktree: true } : { supersedesExecutionId, reuseWorktree: true }), ...(operatorNote ? { operatorNote } : {}), ...(ctx.state.finalPlanSubject ? { finalPlanSubject: ctx.state.finalPlanSubject } : {}), ...(ctx.state.materialityEvidence ? { materialityEvidence: ctx.state.materialityEvidence } : {}), ...(ctx.state.planDecisionReceipt ? { approvalDecisionId: ctx.state.planDecisionReceipt.decisionId } : {}), ...(ctx.input.runProjectTests != null ? { runProjectTests: ctx.input.runProjectTests } : {}), ...(ctx.input.visualEvidence ? { visualEvidence: ctx.input.visualEvidence } : {}) };
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
    if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") {
      await ctx.recordHandlerNoop("retry_development", "Developer retry was superseded before the result could be applied.");
      return ctx.state;
    }
    const failedToStart = ctx.supervisedDeveloperTurns && true && ctx.state.developerExecutionId === executionId && !ctx.state.developerOutcome;
    if (failedToStart) {
      const autoRetryStartFailure = developerAttempt === 1 && true && ctx.permanentActivityFailure(error)?.code !== "branch_checked_out" && !/already checked out/i.test(error instanceof Error ? error.message : String(error));
      if (autoRetryStartFailure) {
        const retried = await ctx.withStateMutation(() => {
          if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") return false;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Developer could not start; Forge is starting the one automatic retry.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields("failed", null, `Developer could not start: ${error instanceof Error ? error.message : String(error)}`, null), activeOperation: null });
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
    if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.step !== "development") return false;
    if (outcome.status === "completed") {
      const result = outcome.result;
      const typedBlockedState = result.outcome === "blocked" && true;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at(result.outcome === "completed" ? "delivery_ready" : "development"), owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, developerContinuation: result.outcome === "completed" ? null : ctx.state.developerContinuation, ...ctx.recoveryFields(typedBlockedState ? "failed" : "active", typedBlockedState ? result.failureCode ?? null : null, typedBlockedState ? result.deliverySummary : "Developer result claimed.", null), blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker(result.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
    } else {
      const resumeTurn = outcome.status === "failed" && ["turn_outcome_missing", "turn_stalled"].includes(outcome.reasonCode ?? "") && true;
      const startupBlocked = outcome.status === "failed" && outcome.reasonCode === "agent_startup_blocked" && true;
      const allowedCommands = ctx.addRevisionCommand(["retry_development", "cancel_issue"]);
      const attentionEvidence = outcome.status === "failed" ? outcome.evidenceArtifactId ?? undefined : undefined;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands, pendingAction: resumeTurn ? "Resume Developer turn" : outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null, blocker: startupBlocked ? stateTransitions.humanBlocker("member_authorization", outcome.summary, [{ command: "retry_development", label: "Retry after answering the agent prompt", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : resumeTurn ? stateTransitions.humanBlocker("agent_exhausted", outcome.summary, [{ command: "retry_development", label: "Resume Developer turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(attentionEvidence, "attention-evidence")) : null });
    }
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    return true;
  });
  if (applied) await ctx.project();
  else await ctx.recordHandlerNoop("retry_development", "Developer retry was superseded before the result could be applied.");
  return ctx.state;
}

export function registerDevelopmentHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.start_development, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("start development command", rawInput);
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    // An HTTP command can arrive just after the automatic chain claimed the
    // same revision. Treat that request as joining the in-flight start rather
    // than rejecting an otherwise current UI action as stale.
    if (ctx.state.step === "development" && ctx.state.activeOperation?.kind === "development" && ctx.state.activeOperation.commandId.startsWith(`${ctx.state.workflowId}:auto-start_development:`) && command.expectedRevision + 1 === ctx.state.revision) return ctx.state;
    return startDevelopment(ctx, command);
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    const joinsAutomaticStart = ctx.state.step === "development" && ctx.state.activeOperation?.kind === "development" && ctx.state.activeOperation.commandId.startsWith(`${ctx.state.workflowId}:auto-start_development:`) && command.expectedRevision + 1 === ctx.state.revision;
    if (command.expectedRevision !== ctx.state.revision && !joinsAutomaticStart) throw new Error("Stale workflow revision");
    if (joinsAutomaticStart) return;
    if (ctx.state.step !== "ready_for_development") throw new Error("Development can only start after plan approval");
    if (ctx.state.planMaterial === null || ctx.state.planMaterial === undefined || !ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef) throw new Error("A validated Lead plan is required before development");
    if (ctx.state.planApproved !== true) throw new Error("A plan must be approved before development");
  } });
  setHandler(issueUpdates.retry_development, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("retry development command", rawInput);
    return retryDevelopment(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.step !== "development" && !isBlocked(ctx.state) && !(isBlocked(ctx.state) && true && ctx.state.planMaterial === true && ctx.state.leadOutputArtifactId && ctx.state.leadSessionRef)) throw new Error("Developer retry is not available in the current phase");
    // Materiality only has to be decided, not true — same check start_development makes.
    // Truthiness here made every routine (non-material) plan permanently unretryable.
    if (!ctx.state.developerExecutionId || ctx.state.planMaterial === null || ctx.state.planMaterial === undefined || !ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef) throw new Error("A preserved Developer attempt and approved plan are required before retry");
  } });

}
