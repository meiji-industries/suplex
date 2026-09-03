import { at, isBlocked } from "../../issue-phases.js";
import { isCancellation, setHandler, sleep } from "../registry.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { applyTargetBaseRevalidation } from "../target-base.js";
import { developerExecutionId } from "../deterministic-id.js";
import { issueUpdates } from "../issue-updates.js";
import { mergeCommands } from "../../commands/definitions/merge.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerMergeHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  const reconcileMergeTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.releaseId || !ctx.state.expectedHeadSha || !ctx.state.acceptanceId) throw new Error("Exact accepted release head is required for merge reconciliation");
    const attempt = (ctx.state.mergeAttempt ?? 0) + 1;
    if (attempt > ctx.maxReconciliationAttempts) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ["request_delivery_changes", "reconcile_merge", "cancel_issue"], pendingAction: "GitHub did not respond. Retry when ready.", mergeAttempt: attempt, mergeBlockerCode: "merge_reconciliation_exhausted", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    let result;
    try {
      if (ctx.state.releaseRepository && ctx.state.branchName) await activityProxies.observeGithubPullRequest({ repository: ctx.state.releaseRepository, branch: ctx.state.branchName, pullRequestNumber: ctx.state.pullRequestNumber });
      result = await activityProxies.reconcileMerge({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, acceptanceId: ctx.state.acceptanceId });
    } catch (error) {
      if (isCancellation(error)) throw error;
      const failure = ctx.permanentActivityFailure(error, true);
      if (failure && ["login-expired", "unauthenticated"].includes(failure.code)) {
        ctx.state = stateTransitions.credentialBlockedState(ctx.state, "reconcile_merge", stateTransitions.evidencePointer(failure.evidenceArtifactId, "attention-evidence"));
        await ctx.project();
        return ctx.state;
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("manual_merge"), owner: "human", allowedCommands: ["reconcile_merge", "cancel_issue"], pendingAction: "The GitHub merge state is not available now", mergeAttempt: attempt, mergeOutcome: "provider_unavailable", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (result.outcome === "merged" && (!result.mergeObservationId || !result.completionReceiptId || !result.mergedAt)) throw new Error("Merged reconciliation requires an immutable observation and completion receipt");
    if (result.outcome === "changed_head" && result.observedHeadSha) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", expectedHeadSha: result.observedHeadSha, expectedHeadTree: null, resultCommit: result.observedHeadSha, resultTree: null, deliveryReviewId: null, finalReviewId: null, ciRunId: null, acceptanceId: null, mergeOutcome: result.outcome, mergeAttempt: attempt, mergeObservationId: result.mergeObservationId, completionReceiptId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const nextStep = result.outcome === "merged" ? "done" : "manual_merge";
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at(nextStep), owner: "human", allowedCommands: nextStep === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : [], pendingAction: nextStep === "manual_merge" ? "Your merge is necessary" : nextStep === "done" ? "Merged" : "Pull request changed or closed without merge", mergeAttempt: attempt, mergeOutcome: result.outcome, mergeObservationId: result.mergeObservationId, completionReceiptId: result.completionReceiptId, mergeRetryAt: result.retryAt, mergeBlockerCode: result.blockerCode ?? null, mergeBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, pullRequestNumber: result.pullRequestNumber || ctx.state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || ctx.state.pullRequestUrl, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  setHandler(issueUpdates.resolve_merge_conflict, ctx.guarded(async (rawInput: unknown) => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (isBlocked(ctx.state)) return resolveMergeConflict(ctx, command);
    return ctx.retryTargetBaseReconciliation(command);
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    const observedConflict = ctx.state.owner === "human" && ctx.state.githubPullRequestMergeable === "CONFLICTING";
    if (command.expectedRevision !== ctx.state.revision || (!observedConflict && (!isBlocked(ctx.state) || !ctx.state.allowedCommands.includes("resolve_merge_conflict")))) throw new Error("Merge-conflict resolution is not available in the current phase");
  } });

  setHandler(issueUpdates.integrate_remote_conflict, ctx.guarded(async (rawInput: any) => {
    const rawCommand = mergeCommands.integrate_remote_conflict.body!.extend({ actorUserId: contracts.durableId, commandId: contracts.durableId }).parse(rawInput);
    const command = rawCommand;
    if (ctx.commandAlreadyProcessed(rawCommand.commandId)) return ctx.state;
    ctx.markCommandProcessed(rawCommand.commandId);
    ctx.state = contracts.IssueWorkflowStateSchema.parse({
      ...ctx.state,
      revision: ctx.state.revision + 1,
      ...at("merge_conflict_resolving"),
      owner: "lead",
      allowedCommands: ["resolve_merge_conflict", "cancel_issue"],
      pendingAction: "Forge resolves a conflict with commits pushed to the branch",
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
    if (!["ci_waiting", "manual_merge", "delivery_ready", "accepted"].includes(ctx.state.step) || ctx.state.activeOperation !== null) throw new Error("Remote conflict integration is not available in the current phase");
  } });

  ctx.reconcileMergeTurn = reconcileMergeTurn;
}

export async function resolveMergeConflict(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  const block = async (reason: string, developerAttempt = ctx.state.developerAttempt): Promise<contracts.IssueWorkflowState> => {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "human", allowedCommands: [...new Set([...ctx.state.allowedCommands, "resolve_merge_conflict", "cancel_issue"])], pendingAction: reason, lastHandlerError: { command: "resolve_merge_conflict", reason, at: new Date().toISOString() }, developerAttempt, activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  if (command.expectedRevision !== ctx.state.revision || ctx.state.step !== "merge_conflict_resolving") return block("Merge-conflict resolution is not available in the current phase");
  if ((ctx.state.developerAttempt ?? 0) > 20) return block("Developer attempt count was corrupted. Review the last real build before retrying.", 3);
  if ((!ctx.state.forwardMergeId || !ctx.state.mergeResolutionPlanArtifactId) && ctx.state.githubPullRequestMergeable === "CONFLICTING") {
    await ctx.runTargetBaseCheckpoint("pre_release");
    if (!isBlocked(ctx.state) || ctx.state.owner === "human" || !ctx.state.forwardMergeId) return ctx.state;
  }
  if (!ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.leadSessionRef || !ctx.state.leadOutputArtifactId || !ctx.state.branchName || !ctx.state.forwardMergeId || !ctx.state.forwardMergePriorHead || !ctx.state.forwardMergePriorTree || !ctx.state.forwardMergeTargetBaseSha || !ctx.state.forwardMergeConflictArtifact || typeof ctx.state.forwardMergeConflictFileCount !== "number" || !ctx.state.targetBaseSha) return block("An owned build and forward-merge evidence are required");
  const planRevision = ctx.state.planRevision ?? ctx.state.revision;
  if (!ctx.state.mergeResolutionPlanArtifactId) {
    await ctx.withStateMutation(() => {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_reviewing"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge prepares a conflict plan", activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: ctx.state.revision + 1 }, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    });
    await ctx.project();
    try {
      const plan = await ctx.acquireExternalTurn<contracts.MergeConflictPlanActivityResult>(
        { operation: "merge_conflict_plan", ...stateTransitions.integratorTurn(ctx, "planner"), sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => activityProxies.planMergeConflict({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision, roleProfiles: ctx.input.roleProfiles, executionRole: stateTransitions.integratorTurn(ctx, "planner").role === "integrator" ? "integrator" : "planner", leadSessionRef: ctx.state.mergeResolutionLeadSessionRef ?? ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, forwardMergeId: ctx.state.forwardMergeId!, priorHead: ctx.state.forwardMergePriorHead!, targetBaseSha: ctx.state.forwardMergeTargetBaseSha!, conflictArtifact: ctx.state.forwardMergeConflictArtifact!, conflictFileCount: ctx.state.forwardMergeConflictFileCount!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.leadExecutionId,
      );
      await ctx.withStateMutation(() => {
        const productDecision = plan.disposition === "product_decision";
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: productDecision ? "human" : "lead", allowedCommands: productDecision ? ["send_planner_note", "resolve_merge_conflict", "cancel_issue"] : ["resolve_merge_conflict", "cancel_issue"], pendingAction: productDecision ? plan.question! : "Forge resolves the conflict", blocker: productDecision ? stateTransitions.humanBlocker("member_decision", plan.question!, [{ command: "send_planner_note", label: "Send a note to the Planner", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(plan.planArtifactId, "merge-conflict-plan")) : null, mergeDecision: productDecision ? { question: plan.question!, choices: plan.choices!, recommendedChoiceId: plan.recommendedChoiceId! } : null, mergeResolutionPlanId: productDecision ? null : plan.planId, mergeResolutionPlanArtifactId: productDecision ? null : plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      return block("Forge could not prepare a conflict plan");
    }
    await ctx.project();
  }
  if (!ctx.state.mergeResolutionPlanArtifactId && ctx.state.mergeDecision) return ctx.state;
  if (!ctx.state.mergeResolutionPlanArtifactId) return block("A Lead conflict plan is required");
  for (let retry = 0; retry < 2; retry += 1) {
    const automatic = command.commandId.startsWith(`${ctx.state.workflowId}:auto-resolve_merge_conflict:`);
    const progress = automatic
      ? stateTransitions.withRepairProgress(ctx.state, { signature: stateTransitions.repairSignature({ source: "merge", code: "merge_conflict" }), commit: ctx.state.resultCommit ?? null, diagnosticHash: null })
      : ctx.state;
    if (automatic && (progress.repairProgress?.repeats ?? 0) >= (ctx.input.repairCycleLimit ?? 0)) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...progress, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "The merge conflict needs your decision", activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const turnExecutionId = developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "merge_conflict_resolution");
    const prior = { forwardMergeId: ctx.state.forwardMergeId, developerExecutionId: ctx.state.developerExecutionId, developerSessionRef: ctx.state.developerSessionRef, branchName: ctx.state.branchName, priorHead: ctx.state.forwardMergePriorHead, priorTree: ctx.state.forwardMergePriorTree, targetBaseSha: ctx.state.forwardMergeTargetBaseSha, expectedBaseSha: ctx.state.targetBaseSha, conflictArtifact: ctx.state.forwardMergeConflictArtifact, conflictFileCount: ctx.state.forwardMergeConflictFileCount, planArtifactId: ctx.state.mergeResolutionPlanArtifactId };
    await ctx.withStateMutation(() => {
      // A deterministic turn ID is not a The Builder works on the task until the
      // activity has inserted its ledger row. Keep the last persisted ID as
      // the retry anchor while this prospective turn starts.
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...progress, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "The Builder resolves the merge conflicts", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerAttempt, developerTurnKind: "merge_conflict_resolution", ...ctx.recoveryFields("starting", null, "Starting Developer merge-conflict resolution.", null), activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: ctx.state.revision + 1 } });
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
        const interrupted = outcome.status === "interrupted";
        const autoRetry = interrupted && developerAttempt === 1 && retry === 0;
        const applied = await ctx.withStateMutation(() => {
          if (ctx.state.activeOperation?.commandId !== command.commandId) return false;
          const recoveryStatus = interrupted ? "interrupted" : outcome.status;
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: autoRetry ? "lead" : "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: autoRetry ? "The Builder conflict-resolution process ended. Forge makes one automatic retry." : outcome.summary, blocker: autoRetry ? null : stateTransitions.humanBlocker("agent_exhausted", outcome.summary, [{ command: "resolve_merge_conflict", label: "Resolve the merge conflict", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(outcome.status === "failed" ? outcome.evidenceArtifactId ?? undefined : undefined, "merge-conflict-resolution")), developerAttempt, ...ctx.recoveryFields(recoveryStatus, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          return true;
        });
        if (applied) await ctx.project();
        if (!applied || !autoRetry) return ctx.state;
        await sleep("2 seconds");
        command = { ...command, expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-retry-merge-conflict:${ctx.state.revision}` };
        continue;
      }
      const result = outcome.result;
      await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId) return;
        if ("outcome" in result && result.outcome === "verification_blocked") {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: result.summary, targetBaseOutcome: "blocked", targetBaseBlockerCode: result.code, targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", developerEvidenceArtifactId: result.verificationArtifact.id, developerOutcome: "blocked", ...ctx.recoveryFields(null, null, null, null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          return;
        }
        const successfulResult = result as Extract<typeof result, { deliveryArtifactId: string }>;
        ctx.state = applyTargetBaseRevalidation(ctx.state, { outcome: "revalidated", checkId: prior.forwardMergeId, checkpoint: ctx.state.targetBaseCheckpoint ?? "pre_release", expectedBaseSha: prior.expectedBaseSha, observedBaseSha: prior.targetBaseSha, priorHead: prior.priorHead, priorTree: prior.priorTree, headSha: successfulResult.resultCommit, headTree: successfulResult.resultTree, developerExecutionId: successfulResult.developerExecutionId, deliveryArtifact: { id: successfulResult.deliveryArtifactId, kind: "forward-merge-delivery" }, verificationArtifact: { id: successfulResult.verificationArtifactId, kind: "forward-merge-verification" }, developerEvidenceArtifactId: successfulResult.evidenceArtifactId });
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, worktreePath: successfulResult.worktreePath ?? ctx.state.worktreePath, developerSessionRef: successfulResult.developerSessionRef, deliverySummary: successfulResult.summary, developerEvidenceArtifactId: successfulResult.evidenceArtifactId, mergeResolutionDeveloperExecutionId: successfulResult.developerExecutionId, mergeResolutionDeveloperSessionRef: successfulResult.developerSessionRef, ...ctx.recoveryFields("active", null, "Developer merge-conflict result claimed.", null), activeOperation: null });
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId) return;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "The Builder did not resolve the conflicts. Retry.", blocker: stateTransitions.humanBlocker("agent_exhausted", "The Builder did not resolve the conflicts. Retry.", [{ command: "resolve_merge_conflict", label: "Resolve the merge conflict", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], undefined), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      });
    }
    await ctx.project();
    return ctx.state;
  }
  return ctx.state;
}

export function registerMergeReconciliationHandler(ctx: IssueWorkflowContext): void {
  const validateReconcileMerge = (rawInput: contracts.StartPlanningInput): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    const adoptedLiveHead = ctx.state.step === "delivery_ready" && ctx.state.mergeOutcome === "changed_head";
    if (command.expectedRevision !== ctx.state.revision || (ctx.state.step !== "manual_merge" && !adoptedLiveHead)) throw new Error("Merge reconciliation is not available in the current phase");
    return command;
  };
  setHandler(issueUpdates.reconcile_merge, ctx.guarded(async (rawInput: any) => {
    validateReconcileMerge(rawInput);
    if (ctx.state.step === "delivery_ready" && ctx.state.mergeOutcome === "changed_head") return ctx.state;
    return ctx.reconcileMergeTurn();
  }, "reconcile_merge"), { validator(rawInput) { validateReconcileMerge(rawInput); } });
}
