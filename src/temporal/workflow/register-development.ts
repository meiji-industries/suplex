import { setHandler } from "@temporalio/workflow";
import { assertPayloadWithinLimit } from "../policy.js";
import * as contracts from "../issue-contracts.js";
import * as activityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { developerExecutionId } from "../deterministic-id.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueWorkflowContext } from "./context.js";
export async function startDevelopment(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
    if (ctx.commandAlreadyProcessed(command.commandId)) {
      await ctx.recordHandlerNoop("start_development", "This development command was already processed.");
      return ctx.state;
    }
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const executionId = ctx.supervisedDeveloperTurns ? developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "implementation") : `developer_${ctx.state.workflowId}_${command.commandId}`.slice(0, 256);
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || ctx.state.phase !== "ready_for_development") throw new Error("Development start was superseded by another command");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: "Developer execution", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: executionId, developerAttempt, developerTurnKind: "implementation", ...ctx.recoveryFields("starting", null, null, null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: ctx.state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
      ctx.markCommandProcessed(command.commandId);
    });
    await ctx.project();
    const authorization = ctx.state.planAuthorizationId && ctx.state.planAuthorizationKind && ctx.state.planAuthorizedAt ? { authorizationId: ctx.state.planAuthorizationId, taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision, planArtifactId: ctx.state.leadOutputArtifactId!, authorizationKind: ctx.state.planAuthorizationKind, approvalDecisionId: ctx.state.planAuthorizationKind === "human_approval" ? ctx.state.decisionId ?? null : null, authorizedAt: ctx.state.planAuthorizedAt } : undefined;
    const legacyInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}), ...(ctx.state.finalPlanSubject ? { finalPlanSubject: ctx.state.finalPlanSubject } : {}), ...(ctx.state.materialityEvidence ? { materialityEvidence: ctx.state.materialityEvidence } : {}), ...(ctx.state.planDecisionReceipt ? { approvalDecisionId: ctx.state.planDecisionReceipt.decisionId } : {}), ...(authorization ? { authorization } : {}) };
    const recoverDeveloperFailures = ctx.supervisedDeveloperTurns ? false : ctx.patched(ctx.developerFailureRecoveryPatch);
    let outcome: Awaited<ReturnType<typeof activityProxies.runDeveloperExecutionSupervised>> | { status: "completed"; result: Awaited<ReturnType<typeof activityProxies.runDeveloperExecution>>; resultHash: string };
    try {
      outcome = await ctx.acquireExternalTurn(
        { operation: "developer_execution", role: "builder", profileId: ctx.input.roleProfiles.builder },
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
    const applied = await ctx.withStateMutation(() => {
      if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
      if (outcome.status === "completed") {
        const result = outcome.result;
        const typedBlockedState = result.outcome === "blocked" && ctx.patched(ctx.developerBlockedRecoveryStatePatch);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, ...ctx.recoveryFields(typedBlockedState ? "failed" : "active", typedBlockedState ? result.failureCode ?? null : null, typedBlockedState ? result.deliverySummary : "Developer result claimed.", null), activeOperation: null, blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker(result.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, result.attentionEvidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
      } else {
        autoRetry = outcome.status === "interrupted" && developerAttempt === 1 && ctx.patched("forge-developer-auto-retry-v1");
        const allowedCommands = autoRetry ? ctx.addRevisionCommand(["start_development", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: autoRetry ? "ready_for_development" : "delivery_blocked", owner: autoRetry ? "lead" : "human", allowedCommands, pendingAction: autoRetry ? "Developer process ended; Forge is starting the one automatic retry." : outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null });
      }
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      return true;
    });
    // Snapshot before projecting: the auto-chain can claim the next phase while this
    // command's own result is still being handed back to the caller.
    const settled = ctx.state;
    if (applied) await ctx.project();
    if (applied && autoRetry) return startDevelopment(ctx, { ...command, expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-retry-development:${ctx.state.revision}` });
    void command;
    return settled;
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
    if (ctx.isolatedDeveloperExecutionEnabled && ctx.state.finalPlanSubject && (!ctx.state.planAuthorizationId || !ctx.state.planAuthorizationKind || !ctx.state.planAuthorizedAt)) throw new Error("An authorized final plan is required before development");
    if (ctx.isolatedDeveloperExecutionEnabled && ctx.state.finalPlanSubject && command.planAuthorizationId !== ctx.state.planAuthorizationId) throw new Error("The start command does not match the authorized final plan");
    if (ctx.exactPlanAuthorityEnabled && ctx.state.planMaterial && (ctx.state.finalPlanSubject || ctx.state.materialityEvidence) && (!ctx.state.finalPlanSubject || !ctx.state.materialityEvidence || !ctx.state.planDecisionReceipt || ctx.state.planDecisionReceipt.decision !== "approve")) throw new Error("An approved exact final Lead plan is required before development");
  } });
  setHandler(issueUpdates.retry_development, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("retry development command", rawInput);
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) {
      await ctx.recordHandlerNoop("retry_development", "This retry command was already processed.");
      return ctx.state;
    }
    // Retain this marker for retries recorded before retry_development always started
    // a fresh turn. Those histories invoked the patch regardless of reconcileOnly.
    const reconciliationRecoveryEnabled = ctx.patched(ctx.developerReconciliationRecoveryPatch);
    if (command.reconcileOnly && ctx.state.phase === "delivery_blocked" && ctx.state.developerExecutionId && reconciliationRecoveryEnabled) {
      const priorExecutionId = ctx.state.developerExecutionId;
      const reconciled = await activityProxies.reconcileDeveloperDeliveryEvidence({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, developerExecutionId: priorExecutionId });
      if (reconciled?.outcome === "completed") {
        const applied = await ctx.withStateMutation(() => {
          if (ctx.state.revision !== command.expectedRevision || ctx.state.phase !== "delivery_blocked" || ctx.state.developerExecutionId !== priorExecutionId) return false;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ctx.addRevisionCommand(["review_delivery", "cancel_issue"]), pendingAction: "Lead delivery review", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerSessionRef: reconciled.developerSessionRef, branchName: reconciled.branchName, targetBaseSha: reconciled.targetBaseSha, currentStep: reconciled.currentStep, resultCommit: reconciled.resultCommit, resultTree: reconciled.resultTree, dirtyState: reconciled.dirtyState, deliveryArtifactId: reconciled.deliveryArtifactId, developerEvidenceArtifactId: reconciled.evidenceArtifactId, deliverySummary: reconciled.deliverySummary, developerOutcome: "completed", ...ctx.recoveryFields("active", null, "Stored Developer evidence was reconciled automatically.", null), activeOperation: null, blocker: null, stateChangedAt: new Date().toISOString() });
          ctx.markCommandProcessed(command.commandId);
          return true;
        });
        if (applied) await ctx.project();
        else await ctx.recordHandlerNoop("retry_development", "Developer delivery reconciliation was superseded by another command.");
        return ctx.state;
      }
      if (command.reconcileOnly) {
        await ctx.recordHandlerNoop("retry_development", "Stored Developer evidence did not complete reconciliation.");
        return ctx.state;
      }
    }
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const supersedesExecutionId = ctx.state.developerExecutionId!;
    const executionId = ctx.supervisedDeveloperTurns ? developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "implementation") : `developer_${ctx.state.workflowId}_${command.commandId}`.slice(0, 256);
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || (ctx.state.phase !== "development" && ctx.state.phase !== "delivery_blocked" && !(ctx.state.phase === "failed" && ctx.patched("forge-failed-retry-v1")))) throw new Error("Developer retry was superseded by another command");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "development", owner: "lead", allowedCommands: ctx.addRevisionCommand(["cancel_development", "reject_plan", "cancel_issue"]), pendingAction: "Developer retry", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: executionId, developerAttempt, developerTurnKind: "implementation", ...ctx.recoveryFields("starting", null, "Starting a linked Developer retry.", null), activeOperation: { commandId: command.commandId, kind: "development", startedRevision: ctx.state.revision + 1 }, blocker: null, stateChangedAt: new Date().toISOString() });
      ctx.markCommandProcessed(command.commandId);
    });
    await ctx.project();
    const authorization = ctx.state.planAuthorizationId && ctx.state.planAuthorizationKind && ctx.state.planAuthorizedAt ? { authorizationId: ctx.state.planAuthorizationId, taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision, planArtifactId: ctx.state.leadOutputArtifactId!, authorizationKind: ctx.state.planAuthorizationKind, approvalDecisionId: ctx.state.planAuthorizationKind === "human_approval" ? ctx.state.decisionId ?? null : null, authorizedAt: ctx.state.planAuthorizedAt } : undefined;
    const legacyInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}), supersedesExecutionId, reuseWorktree: true, ...(ctx.state.finalPlanSubject ? { finalPlanSubject: ctx.state.finalPlanSubject } : {}), ...(ctx.state.materialityEvidence ? { materialityEvidence: ctx.state.materialityEvidence } : {}), ...(ctx.state.planDecisionReceipt ? { approvalDecisionId: ctx.state.planDecisionReceipt.decisionId } : {}), ...(authorization ? { authorization } : {}) };
    const outcome = await ctx.acquireExternalTurn(
      { operation: "developer_execution", role: "builder", profileId: ctx.input.roleProfiles.builder, sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath },
      (capacityRequestId) => ctx.supervisedDeveloperTurns
        ? activityProxies.runDeveloperExecutionSupervised({ ...legacyInput, developerTurnExecutionId: executionId, developerAttempt, turnKind: "implementation", ...(capacityRequestId ? { capacityRequestId } : {}) })
        : activityProxies.runDeveloperExecution({ ...legacyInput, executionId, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
      (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
    );
    const applied = await ctx.withStateMutation(() => {
      if (ctx.state.activeOperation?.commandId !== command.commandId || ctx.state.phase !== "development") return false;
      if (outcome.status === "completed") {
        const result = outcome.result;
        const typedBlockedState = result.outcome === "blocked" && ctx.patched(ctx.developerBlockedRecoveryStatePatch);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Lead delivery review" : "Developer retry is available", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, activeOperation: null, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, ...ctx.recoveryFields(typedBlockedState ? "failed" : "active", typedBlockedState ? result.failureCode ?? null : null, typedBlockedState ? result.deliverySummary : "Developer result claimed.", null), blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker(result.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_exhausted", result.deliverySummary, [{ command: "retry_development", label: "Retry Developer", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, result.attentionEvidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString() });
      } else {
        const allowedCommands = ctx.addRevisionCommand(["retry_development", "cancel_issue"]);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands, pendingAction: outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: outcome.developerExecutionId, developerOutcome: null, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null });
      }
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      return true;
    });
    if (applied) await ctx.project();
    else await ctx.recordHandlerNoop("retry_development", "Developer retry was superseded before the result could be applied.");
    void command;
    return ctx.state;
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
