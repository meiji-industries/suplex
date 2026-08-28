import { setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { applyTargetBaseRevalidation } from "../target-base.js";
import { developerExecutionId } from "../deterministic-id.js";
import { issueUpdates } from "../issue-updates.js";
import { mergeCommands } from "../../commands/definitions/merge.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerMergeHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(ctx.herdrExecutionSubstrateEnabled) };
  const reconcileMergeTurn = async (): Promise<contracts.IssueWorkflowState> => {
    const exactAcceptanceReceipts = ctx.patched(ctx.exactAcceptanceReceiptPatch);
    if (!ctx.state.releaseId || !ctx.state.expectedHeadSha || !ctx.state.acceptanceId) throw new Error("Exact accepted release head is required for merge reconciliation");
    const attempt = (ctx.state.mergeAttempt ?? 0) + 1;
    if (attempt > ctx.maxReconciliationAttempts) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "reconcile_merge", "cancel_issue"], pendingAction: "Gave up waiting for GitHub — retry when ready", mergeAttempt: attempt, mergeBlockerCode: "merge_reconciliation_exhausted", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    let result;
    try {
      if (ctx.patched("forge-github-sync-v1") && ctx.state.releaseRepository && ctx.state.branchName) await activityProxies.observeGithubPullRequest({ repository: ctx.state.releaseRepository, branch: ctx.state.branchName, pullRequestNumber: ctx.state.pullRequestNumber });
      result = await activityProxies.reconcileMerge({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, acceptanceId: ctx.state.acceptanceId });
    } catch (error) {
      const failure = ctx.permanentActivityFailure(error, true);
      if (ctx.patched("forge-repair-no-progress-v1") && failure && ["login-expired", "unauthenticated"].includes(failure.code)) {
        ctx.state = stateTransitions.credentialBlockedState(ctx.state, "reconcile_merge", stateTransitions.evidencePointer(failure.evidenceArtifactId, "attention-evidence"));
        await ctx.project();
        return ctx.state;
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "manual_merge", owner: "human", allowedCommands: ["reconcile_merge", "cancel_issue"], pendingAction: "GitHub merge state is temporarily unavailable", mergeAttempt: attempt, mergeOutcome: "provider_unavailable", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (exactAcceptanceReceipts && result.outcome === "merged" && (!result.mergeObservationId || !result.completionReceiptId || !result.mergedAt)) throw new Error("Merged reconciliation requires an immutable observation and completion receipt");
    const liveHead = ctx.patched("forge-live-head-v1");
    if (liveHead && result.outcome === "changed_head" && result.observedHeadSha) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", expectedHeadSha: result.observedHeadSha, expectedHeadTree: null, resultCommit: result.observedHeadSha, resultTree: null, deliveryReviewId: null, finalReviewId: null, ciRunId: null, acceptanceId: null, mergeOutcome: result.outcome, mergeAttempt: attempt, mergeObservationId: result.mergeObservationId, completionReceiptId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const nextPhase = result.outcome === "merged" ? "done" : result.outcome === "open" || result.outcome === "provider_unavailable" ? "manual_merge" : "delivery_blocked";
    if (!exactAcceptanceReceipts) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "reconcile_merge", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for your merge" : nextPhase === "done" ? "Merged" : "Pull request changed or closed without merge", mergeOutcome: result.outcome, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["request_delivery_changes", "reconcile_merge", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for your merge" : nextPhase === "done" ? "Merged" : "Pull request changed or closed without merge", mergeAttempt: attempt, mergeOutcome: result.outcome, mergeObservationId: result.mergeObservationId, completionReceiptId: result.completionReceiptId, mergeRetryAt: result.retryAt, mergeBlockerCode: result.blockerCode ?? null, mergeBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, pullRequestNumber: result.pullRequestNumber || ctx.state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || ctx.state.pullRequestUrl, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  setHandler(issueUpdates.resolve_merge_conflict, ctx.guarded(async (rawInput) => resolveMergeConflict(ctx, contracts.StartPlanningInputSchema.parse(rawInput))), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "merge_conflict_required" || !ctx.state.allowedCommands.includes("resolve_merge_conflict")) throw new Error("Merge-conflict resolution is not available in the current phase");
  } });

  setHandler(issueUpdates.integrate_remote_conflict, ctx.guarded(async (rawInput) => {
    const rawCommand = mergeCommands.integrate_remote_conflict.body!.extend({ actorUserId: contracts.durableId, commandId: contracts.durableId }).parse(rawInput);
    const command = rawCommand;
    if (ctx.commandAlreadyProcessed(rawCommand.commandId)) return ctx.state;
    if (!ctx.patched("forge-merge-resolution-loop-v1")) return ctx.state;
    ctx.markCommandProcessed(rawCommand.commandId);
    ctx.state = contracts.IssueWorkflowStateSchema.parse({
      ...ctx.state,
      revision: ctx.state.revision + 1,
      phase: "merge_conflict_required",
      owner: "lead",
      allowedCommands: ["resolve_merge_conflict", "cancel_issue"],
      pendingAction: "Resolving a conflict with commits pushed to the branch",
      forwardMergeId: command.forwardMergeId,
      forwardMergePriorHead: command.priorHead,
      forwardMergePriorTree: command.priorTree,
      forwardMergeTargetBaseSha: command.remoteHead,
      forwardMergeConflictArtifact: command.conflictArtifact,
      forwardMergeConflictFileCount: command.conflictFileCount,
      mergeResolutionPlanArtifactId: null,
      mergeDecision: null,
      lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`,
    });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = mergeCommands.integrate_remote_conflict.body!.extend({ actorUserId: contracts.durableId, commandId: contracts.durableId }).parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["ci_waiting", "manual_merge", "delivery_ready", "delivery_blocked", "accepted"].includes(ctx.state.phase) || ctx.state.activeOperation !== null) throw new Error("Remote conflict integration is not available in the current phase");
  } });

  ctx.reconcileMergeTurn = reconcileMergeTurn;
}

export async function resolveMergeConflict(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(ctx.herdrExecutionSubstrateEnabled) };
    if (command.expectedRevision !== ctx.state.revision || ctx.state.phase !== "merge_conflict_required") throw new Error("Merge-conflict resolution is not available in the current phase");
    if (!ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.leadSessionRef || !ctx.state.leadOutputArtifactId || !ctx.state.branchName || !ctx.state.forwardMergeId || !ctx.state.forwardMergePriorHead || !ctx.state.forwardMergePriorTree || !ctx.state.forwardMergeTargetBaseSha || !ctx.state.forwardMergeConflictArtifact || typeof ctx.state.forwardMergeConflictFileCount !== "number" || !ctx.state.targetBaseSha) throw new Error("An owned Developer execution and forward-merge evidence are required");
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    if (!ctx.state.mergeResolutionPlanArtifactId) {
      await ctx.withStateMutation(() => {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_reviewing", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Preparing a conflict plan", activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: ctx.state.revision + 1 }, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      });
      await ctx.project();
      try {
        const plan = await ctx.acquireExternalTurn<contracts.MergeConflictPlanActivityResult>(
          { operation: "merge_conflict_plan", ...stateTransitions.integratorTurn(ctx, "planner"), sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => activityProxies.planMergeConflict({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision, roleProfiles: ctx.input.roleProfiles, executionRole: stateTransitions.integratorTurn(ctx, "planner").role === "integrator" ? "integrator" : "planner", leadSessionRef: ctx.state.mergeResolutionLeadSessionRef ?? ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, forwardMergeId: ctx.state.forwardMergeId!, priorHead: ctx.state.forwardMergePriorHead!, targetBaseSha: ctx.state.forwardMergeTargetBaseSha!, conflictArtifact: ctx.state.forwardMergeConflictArtifact!, conflictFileCount: ctx.state.forwardMergeConflictFileCount!, ...(ctx.state.pendingPlannerNotes?.length ? { operatorNotes: ctx.state.pendingPlannerNotes } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (result) => result.leadExecutionId,
        );
        await ctx.withStateMutation(() => {
          const productDecision = ctx.patched("forge-merge-resolution-loop-v1") && plan.disposition === "product_decision";
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: productDecision ? "human" : "lead", allowedCommands: productDecision ? ["send_planner_note", "resolve_merge_conflict", "cancel_issue"] : ["resolve_merge_conflict", "cancel_issue"], pendingAction: productDecision ? plan.question! : "Resolving the conflict", blocker: productDecision ? stateTransitions.humanBlocker("member_decision", plan.question!, [{ command: "send_planner_note", label: "Choose a behavior", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(plan.planArtifactId, "merge-conflict-plan")) : null, mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: productDecision ? null : plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, mergeDecision: productDecision ? { question: plan.question!, choices: plan.choices!, recommendedChoiceId: plan.recommendedChoiceId! } : null, activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        });
      } catch {
        await ctx.withStateMutation(() => {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Forge could not prepare a conflict plan. Try resolving again.", activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        });
        await ctx.project();
        return ctx.state;
      }
    }
    if (!ctx.state.mergeResolutionPlanArtifactId && ctx.state.mergeDecision) {
      await ctx.project();
      return ctx.state;
    }
    if (!ctx.state.mergeResolutionPlanArtifactId) throw new Error("A Lead conflict plan is required");
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const turnExecutionId = developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "merge_conflict_resolution");
    const prior = { forwardMergeId: ctx.state.forwardMergeId, developerExecutionId: ctx.state.developerExecutionId, developerSessionRef: ctx.state.developerSessionRef, branchName: ctx.state.branchName, priorHead: ctx.state.forwardMergePriorHead, priorTree: ctx.state.forwardMergePriorTree, targetBaseSha: ctx.state.forwardMergeTargetBaseSha, expectedBaseSha: ctx.state.targetBaseSha, conflictArtifact: ctx.state.forwardMergeConflictArtifact, conflictFileCount: ctx.state.forwardMergeConflictFileCount, planArtifactId: ctx.state.mergeResolutionPlanArtifactId };
    await ctx.withStateMutation(() => {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_resolving", owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer resolving forward-merge conflicts", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: ctx.supervisedDeveloperTurns ? turnExecutionId : ctx.state.developerExecutionId, developerAttempt, developerTurnKind: "merge_conflict_resolution", ...ctx.recoveryFields("starting", null, "Starting Developer merge-conflict resolution.", null), activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: ctx.state.revision + 1 } });
    });
    await ctx.project();
    try {
      const mergeInput = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, ...prior };
      const outcome = await ctx.acquireExternalTurn(
        { operation: "merge_conflict_resolution", ...stateTransitions.integratorTurn(ctx, "builder"), sessionRef: prior.developerSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => ctx.supervisedDeveloperTurns
          ? activityProxies.resolveMergeConflictSupervised({ ...mergeInput, developerTurnExecutionId: turnExecutionId, developerAttempt, turnKind: "merge_conflict_resolution", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : activityProxies.resolveMergeConflict({ ...mergeInput, ...(capacityRequestId ? { capacityRequestId } : {}) }).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
      if (outcome.status !== "completed") {
        let autoRetry = false;
        const applied = await ctx.withStateMutation(() => {
          if (ctx.state.activeOperation?.commandId !== command.commandId) return false;
          // In the trusted single-operator environment an unconfirmed process is
          // treated as interrupted. The first loss is retried immediately; later
          // losses leave the normal retry command available without a dead-end
          // ownership-verification gate.
          const interrupted = outcome.status === "interrupted";
          autoRetry = interrupted && developerAttempt === 1 && ctx.patched("forge-merge-conflict-auto-retry-v1");
          const recoveryStatus = interrupted ? "interrupted" : outcome.status;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: autoRetry ? "lead" : "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: autoRetry ? "Developer conflict-resolution process ended; Forge is starting the one automatic retry." : outcome.summary, ...ctx.recoveryFields(recoveryStatus, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          return true;
        });
        if (applied) await ctx.project();
        if (applied && autoRetry) return resolveMergeConflict(ctx, { ...command, expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-retry-merge-conflict:${ctx.state.revision}` });
        return ctx.state;
      }
      const result = outcome.result;
      await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId) return;
        if ("outcome" in result && result.outcome === "verification_blocked") {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: result.summary, targetBaseOutcome: "blocked", targetBaseBlockerCode: result.code, targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", developerEvidenceArtifactId: result.verificationArtifact.id, developerOutcome: "blocked", ...ctx.recoveryFields(null, null, null, null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          return;
        }
        const successfulResult = result as Extract<typeof result, { deliveryArtifactId: string }>;
        ctx.state = applyTargetBaseRevalidation(ctx.state, { outcome: "revalidated", checkId: prior.forwardMergeId, checkpoint: ctx.state.targetBaseCheckpoint ?? "pre_release", expectedBaseSha: prior.expectedBaseSha, observedBaseSha: prior.targetBaseSha, priorHead: prior.priorHead, priorTree: prior.priorTree, headSha: successfulResult.resultCommit, headTree: successfulResult.resultTree, developerExecutionId: successfulResult.developerExecutionId, deliveryArtifact: { id: successfulResult.deliveryArtifactId, kind: "forward-merge-delivery" }, verificationArtifact: { id: successfulResult.verificationArtifactId, kind: "forward-merge-verification" }, developerEvidenceArtifactId: successfulResult.evidenceArtifactId });
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, developerSessionRef: successfulResult.developerSessionRef, deliverySummary: successfulResult.summary, developerEvidenceArtifactId: successfulResult.evidenceArtifactId, mergeResolutionDeveloperExecutionId: successfulResult.developerExecutionId, mergeResolutionDeveloperSessionRef: successfulResult.developerSessionRef, ...ctx.recoveryFields("active", null, "Developer merge-conflict result claimed.", null), activeOperation: null });
      });
    } catch {
      await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId) return;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Builder didn't finish resolving conflicts — retry", activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      });
    }
    await ctx.project();
    void command;
    return ctx.state;
}

export function registerMergeReconciliationHandler(ctx: IssueWorkflowContext): void {
  const validateReconcileMerge = (rawInput: contracts.StartPlanningInput): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    const adoptedLiveHead = ctx.patched("forge-live-head-v1") && ctx.state.phase === "delivery_ready" && ctx.state.mergeOutcome === "changed_head";
    if (command.expectedRevision !== ctx.state.revision || (ctx.state.phase !== "manual_merge" && !adoptedLiveHead)) throw new Error("Merge reconciliation is not available in the current phase");
    return command;
  };
  setHandler(issueUpdates.reconcile_merge, ctx.guarded(async (rawInput) => {
    validateReconcileMerge(rawInput);
    if (ctx.patched("forge-live-head-v1") && ctx.state.phase === "delivery_ready" && ctx.state.mergeOutcome === "changed_head") return ctx.state;
    return ctx.reconcileMergeTurn();
  }, "reconcile_merge"), { validator(rawInput) { validateReconcileMerge(rawInput); } });
}
