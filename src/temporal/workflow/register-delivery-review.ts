import { ApplicationFailure, setHandler } from "@temporalio/workflow";
import { assertPayloadWithinLimit } from "../policy.js";
import * as contracts from "../issue-contracts.js";
import * as activityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { developerExecutionId } from "../deterministic-id.js";
import { issueUpdates } from "../issue-updates.js";
import type { LegacyDeveloperRepairResult } from "../issue-contracts.js";
import type { IssueWorkflowContext } from "./context.js";
type LegacyReviewResult = {
  reviewId: string;
  outcome: "approved" | "blocking";
  summary: string;
  repairPlan?: string | null;
  findings?: Array<{ severity: "blocking" | "advisory"; disposition: "open" | "accepted" | "repaired" }>;
  reviewArtifact?: contracts.IssueWorkflowState["deliveryReviewArtifact"];
};

export async function reviewDelivery(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
    const reviewing = stateTransitions.reviewingDeliveryState(ctx.state);
    ctx.state = reviewing;
    await ctx.project();
    let result: contracts.DeliveryReviewActivityResult | LegacyReviewResult;
    try {
      const subject = { planRevision: ctx.state.planRevision ?? ctx.state.revision, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, developerExecutionId: ctx.state.developerExecutionId!, deliveryArtifactId: ctx.state.deliveryArtifactId!, developerEvidenceArtifactId: ctx.state.developerEvidenceArtifactId!, leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef! };
      const common = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, branchName: ctx.state.branchName! };
      const supersedesReviewId = ctx.state.targetBaseOutcome === "revalidated" ? null : ctx.state.deliveryReviewSupersedesId ?? null;
      result = await ctx.acquireExternalTurn<contracts.DeliveryReviewActivityResult | LegacyReviewResult>(
        { operation: "delivery_review", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => activityProxies.reviewDelivery({ ...common, subject, worktreePath: ctx.state.worktreePath!, supersedesReviewId, ...(ctx.input.visualEvidence !== undefined ? { visualEvidence: ctx.input.visualEvidence } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }) as unknown as Promise<contracts.DeliveryReviewActivityResult | LegacyReviewResult>,
        (value) => "attemptId" in value ? (value.outcome === "completed" ? value.review.leadExecutionId : value.executionId) : undefined,
      );
    } catch {
      let evidenceArtifactId: string | null = null;
      try { evidenceArtifactId = (await activityProxies.recordDeliveryBlocker({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, operation: "review" })).artifactId; } catch { /* Keep the fixed state transition if blocker recording itself is unavailable. */ }
      ctx.state = stateTransitions.reviewBlockedState(ctx.state, { attemptId: null, code: "review-infrastructure-failure", summary: "The review infrastructure did not complete; retry the review.", evidenceArtifactId }, true);
      await ctx.project();
      void command;
      return ctx.state;
    }
    const artifactBackedReview = ctx.patched(ctx.artifactBackedReviewPatch);
    // Deprecated: histories created before the minimum repair loop recorded this
    // marker here. Keep the call forever so those histories retain command order.
    void ctx.patched(ctx.exactDeliveryReviewPatch);
    if (!("attemptId" in result)) {
      const legacyResult = result as LegacyReviewResult;
      if (artifactBackedReview && !legacyResult.reviewArtifact) throw ApplicationFailure.nonRetryable("Delivery review artifact is missing", "delivery_review_artifact_missing");
      const openBlocking = (legacyResult.findings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
      const canRepair = legacyResult.outcome === "blocking" && (ctx.state.repairCycle ?? 0) < ctx.repairCycleLimit;
      const nextPhase = legacyResult.outcome === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "delivery_blocked";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...stateTransitions.revisioned(ctx.state, nextPhase, nextPhase === "repair_required" ? "lead" : "human", nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextPhase === "delivery_blocked" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"], nextPhase === "repair_required" ? "Builder is fixing review findings" : nextPhase === "delivery_blocked" ? "Needs your call" : "Opening the pull request"), deliveryReviewId: legacyResult.reviewId, deliveryReviewOutcome: legacyResult.outcome, deliveryReviewSummary: legacyResult.summary, ...(legacyResult.reviewArtifact ? { deliveryReviewArtifact: legacyResult.reviewArtifact } : {}), deliveryBlockingFindings: openBlocking, repairCycle: ctx.state.repairCycle ?? 0 });
    } else {
      const exactResult = result as contracts.DeliveryReviewActivityResult;
      // A review observes the branch while it runs.  That observation is the
      // authoritative delivery subject; the state snapshot that started the turn
      // is only a hint.  Keep old histories byte-for-byte replayable.
      if (ctx.patched("forge-adopt-observed-head-v1")) {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({
          ...ctx.state,
          developerExecutionId: exactResult.subject.developerExecutionId,
          developerSessionRef: exactResult.subject.developerSessionRef,
          targetBaseSha: exactResult.subject.targetBaseSha,
          resultCommit: exactResult.subject.subjectCommit,
          resultTree: exactResult.subject.subjectTree,
          deliveryArtifactId: exactResult.subject.deliveryArtifactId,
          developerEvidenceArtifactId: exactResult.subject.developerEvidenceArtifactId,
        });
      }
      ctx.state = exactResult.outcome === "blocked"
        ? stateTransitions.reviewBlockedState(ctx.state, exactResult)
        : stateTransitions.repairRequiredState(ctx.state, exactResult, ctx.repairCycleLimit);
    }
    if (ctx.state.phase === "delivery_reviewed" && ctx.input.deliveryTarget === "remote_branch") {
      await activityProxies.pushDeliveryBranch({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName!, commitSha: ctx.state.resultCommit! });
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Done — branch pushed", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } else if (ctx.state.phase === "delivery_reviewed" && ctx.input.deliveryTarget === "local_worktree") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Done — kept in worktree", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } else {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, allowedCommands: ctx.addRevisionCommand(ctx.state.allowedCommands) });
    }
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    await ctx.project();
    void command;
    return ctx.state;
}

export function registerDeliveryReviewHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.review_delivery, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("delivery review command", rawInput);
    return reviewDelivery(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "delivery_ready" && ctx.state.phase !== "delivery_blocked") throw new Error("Delivery review is not available in the current phase");
    if (ctx.state.phase === "delivery_blocked" && !ctx.state.deliveryReviewBlockerCode) throw new Error("A review blocker is required before retrying delivery review");
    if (!ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.deliveryArtifactId || !ctx.state.developerEvidenceArtifactId || !ctx.state.leadSessionRef || !ctx.state.leadOutputArtifactId) throw new Error("An exact Developer delivery and Lead session are required before review");
  } });
  setHandler(issueUpdates.repair_delivery, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("delivery repair command", rawInput);
    return repairDelivery(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "repair_required" && ctx.state.phase !== "delivery_blocked") throw new Error("Delivery repair is not available in the current phase");
    if (!ctx.state.deliveryReviewId || !(ctx.state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open")) throw new Error("Open blocking findings are required");
    if (ctx.state.phase === "delivery_blocked" && !ctx.state.deliveryRepairBlockerCode) throw new Error("A repair blocker is required before retrying delivery repair");
    if ((ctx.state.repairCycle ?? 0) >= ctx.repairCycleLimit) throw new Error("Delivery repair limit is exhausted");
    if (!ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.leadSessionRef) throw new Error("The prior Developer delivery must be preserved before repair");
  } });
  setHandler(issueUpdates.record_delivery_decision, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("delivery decision command", rawInput);
    const command = contracts.PlanCommandInputSchema.parse(rawInput);
    const decision = await activityProxies.recordDeliveryDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, note: command.note?.trim() || "Member decision recorded for blocked delivery" });
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_reviewed", owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Ready to create a pull request", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, deliveryDecisionArtifactId: decision.artifactId, blocker: null, stateChangedAt: new Date().toISOString() });
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    await ctx.project();
    return ctx.state;
  }, "record_delivery_decision"), { validator(rawInput) {
    const command = contracts.PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    const legacyRepairDecision = ctx.state.phase === "delivery_blocked" && ctx.state.allowedCommands.includes("repair_delivery");
    if ((ctx.state.phase !== "repair_required" && ctx.state.phase !== "delivery_blocked") || (!ctx.state.allowedCommands.includes("record_delivery_decision") && !legacyRepairDecision) || !ctx.state.deliveryReviewId) throw new Error("A delivery decision is not available in the current phase");
  } });

}

export async function repairDelivery(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
    const cycle = ctx.state.targetBaseOutcome === "revalidated" ? 1 : (ctx.state.repairCycle ?? 0) + 1;
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const priorExecutionId = ctx.state.developerExecutionId!;
    const turnExecutionId = developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "repair");
    const priorDelivery = { developerSessionRef: ctx.state.developerSessionRef!, reviewId: ctx.state.deliveryReviewId!, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, blockingFindings: ctx.state.deliveryBlockingFindings ?? [] };
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || (ctx.state.phase !== "repair_required" && ctx.state.phase !== "delivery_blocked")) throw new Error("Developer repair was superseded by another command");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: `Developer repair cycle ${cycle}`, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: ctx.supervisedDeveloperTurns ? turnExecutionId : ctx.state.developerExecutionId, developerAttempt, developerTurnKind: "repair", ...ctx.recoveryFields("starting", null, "Starting the bounded Developer repair.", null), activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: ctx.state.revision + 1 } });
    });
    await ctx.project();
    const repairInput = {
      taskId: ctx.input.issueId,
      companyId: ctx.input.companyId,
      workflowId: ctx.input.workflowId,
      projectId: ctx.input.projectId,
      projectRevisionId: ctx.input.projectRevisionId,
      planRevision,
      roleProfiles: ctx.input.roleProfiles,
      leadSessionRef: ctx.state.leadSessionRef!,
      developerSessionRef: priorDelivery.developerSessionRef,
      developerExecutionId: priorExecutionId,
      reviewId: priorDelivery.reviewId,
      cycle,
      repairCycleLimit: ctx.repairCycleLimit,
      branchName: priorDelivery.branchName,
      targetBaseSha: priorDelivery.targetBaseSha,
      subjectCommit: priorDelivery.subjectCommit,
      subjectTree: priorDelivery.subjectTree,
      blockingFindings: priorDelivery.blockingFindings,
    };
    let outcome: Awaited<ReturnType<typeof activityProxies.runDeveloperRepairSupervised>> | { status: "completed"; result: contracts.WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult; resultHash: string };
    try {
      outcome = await ctx.acquireExternalTurn(
        { operation: "developer_repair", role: "builder", profileId: ctx.input.roleProfiles.builder, sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => ctx.supervisedDeveloperTurns
          ? activityProxies.runDeveloperRepairSupervised({ ...repairInput, developerTurnExecutionId: turnExecutionId, developerAttempt, turnKind: "repair", ...(capacityRequestId ? { capacityRequestId } : {}) })
          : (activityProxies.runDeveloperRepair({ ...repairInput, ...(capacityRequestId ? { capacityRequestId } : {}) }) as unknown as Promise<contracts.WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult>).then((result) => ({ status: "completed" as const, result, resultHash: "legacy" })),
        (value) => value.status === "completed" ? value.result.developerExecutionId : value.developerExecutionId,
      );
    } catch (error) {
      let evidenceArtifactId: string | null = null;
      try { evidenceArtifactId = (await activityProxies.recordDeliveryBlocker({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, operation: "repair" })).artifactId; } catch { /* Keep the fixed state transition if blocker recording itself is unavailable. */ }
      const summary = error instanceof Error ? error.message : "The repair infrastructure did not complete; retry the repair.";
      ctx.state = stateTransitions.repairInfrastructureBlockedState(ctx.state, cycle, ctx.repairCycleLimit, evidenceArtifactId, summary);
      await ctx.project();
      void command;
      return ctx.state;
    }
    if (outcome.status !== "completed") {
      await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId) return;
        const allowedCommands = ctx.addRevisionCommand(["repair_delivery", "retry_development", "cancel_issue"]);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands, pendingAction: outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null });
      });
      await ctx.project();
      return ctx.state;
    }
    const result: contracts.WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult = outcome.result;
    if ("repairAttemptId" in result) {
      ctx.state = result.outcome === "completed"
        ? stateTransitions.repairedDeliveryAwaitingFreshReviewState(ctx.state, result)
        : stateTransitions.repairBlockedState(ctx.state, result, ctx.repairCycleLimit);
    } else {
      const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...stateTransitions.revisioned(ctx.state, nextPhase, result.outcome === "completed" ? "lead" : "human", result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], result.outcome === "completed" ? "Reviewing the latest changes" : "Needs your call"), developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: result.worktreePath, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, deliveryReviewSupersedesId: result.outcome === "completed" ? ctx.state.deliveryReviewId : ctx.state.deliveryReviewSupersedesId, deliveryReviewId: result.outcome === "completed" ? null : ctx.state.deliveryReviewId, deliveryReviewOutcome: result.outcome === "completed" ? null : ctx.state.deliveryReviewOutcome, deliveryReviewSummary: result.outcome === "completed" ? null : ctx.state.deliveryReviewSummary, ...(result.outcome === "completed" ? { deliveryBlockingFindings: [], deliveryRepairPlan: null } : {}) });
    }
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, allowedCommands: ctx.addRevisionCommand(ctx.state.allowedCommands), ...ctx.recoveryFields("active", null, "Developer repair result claimed.", null), activeOperation: null });
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    await ctx.project();
    void command;
    return ctx.state;
}
