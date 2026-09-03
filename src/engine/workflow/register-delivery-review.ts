import { at, isBlocked } from "../../issue-phases.js";
import { log, setHandler } from "../registry.js";
import { ApplicationFailure, isCancellation } from "../failures.js";
import { assertPayloadWithinLimit } from "../policy.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { developerExecutionId } from "../deterministic-id.js";
import { classifyRepairFailure } from "./runtime.js";
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

function canRecoverRevalidatedReview(state: contracts.IssueWorkflowState): boolean {
  const recoveryBlocker = state.deliveryReviewBlockerCode === "review-infrastructure-failure"
    || state.deliveryReviewBlockerCode === "subject-changed"
    || state.deliveryReviewBlockerCode === "worktree-unsafe";
  const recoveryPhase = state.step === "delivery_ready"
    ? !state.deliveryReviewBlockerCode || (isBlocked(state) && recoveryBlocker)
    : isBlocked(state) && recoveryBlocker;
  return recoveryPhase
    && state.allowedCommands.includes("review_delivery")
    && !state.resultTree
    && Boolean(state.resultCommit && state.targetBaseSha && state.expectedHeadSha)
    && state.targetBaseOutcome === "revalidated"
    && Boolean(state.forwardMergeId && state.forwardMergeId === state.targetBaseCheckId)
    && Boolean(state.developerExecutionId && state.developerExecutionId === state.mergeResolutionDeveloperExecutionId)
    && Boolean(state.forwardMergePriorHead && state.forwardMergePriorTree && state.forwardMergeTargetBaseSha)
    && Boolean(state.developerSessionRef && state.branchName && state.worktreePath)
    && state.dirtyState === "clean"
    && Boolean(state.deliveryArtifactId && state.developerEvidenceArtifactId)
    && Boolean(state.leadSessionRef && state.leadOutputArtifactId)
    && !state.deliveryReviewId && !state.deliveryReviewOutcome;
}

export async function reviewDelivery(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
    let result: contracts.DeliveryReviewActivityResult | LegacyReviewResult;
    if (canRecoverRevalidatedReview(ctx.state)) {
      let recovered: contracts.RecoverRevalidatedDeliveryReviewResult;
      try {
        recovered = await activityProxies.recoverRevalidatedDeliveryReview({
          taskId: ctx.input.issueId,
          companyId: ctx.input.companyId,
          workflowId: ctx.input.workflowId,
          projectId: ctx.input.projectId,
          projectRevisionId: ctx.input.projectRevisionId,
          forwardMergeId: ctx.state.forwardMergeId!,
          developerExecutionId: ctx.state.developerExecutionId!,
          branchName: ctx.state.branchName!,
          worktreePath: ctx.state.worktreePath!,
          forwardMergePriorHead: ctx.state.forwardMergePriorHead!,
          forwardMergePriorTree: ctx.state.forwardMergePriorTree!,
          forwardMergeTargetBaseSha: ctx.state.forwardMergeTargetBaseSha!,
          developerSessionRef: ctx.state.developerSessionRef!,
          deliveryArtifactId: ctx.state.deliveryArtifactId!,
          developerEvidenceArtifactId: ctx.state.developerEvidenceArtifactId!,
          leadSessionRef: ctx.state.leadSessionRef!,
          leadOutputArtifactId: ctx.state.leadOutputArtifactId!,
        });
      } catch (error) {
        if (isCancellation(error)) throw error;
        log.error("Reviewed delivery recovery failed", { workflowId: ctx.input.workflowId, taskId: ctx.input.issueId, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
        ctx.state = stateTransitions.reviewBlockedState(ctx.state, { attemptId: null, code: "review-infrastructure-failure", summary: "The saved delivery could not be checked right now. Retry the review.", evidenceArtifactId: null }, true);
        await ctx.project();
        void command;
        return ctx.state;
      }
      if (recovered.outcome === "blocked") {
        ctx.state = stateTransitions.reviewBlockedState(ctx.state, { attemptId: null, code: recovered.code, summary: recovered.summary, evidenceArtifactId: null });
        await ctx.project();
        void command;
        return ctx.state;
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({
        ...ctx.state,
        developerExecutionId: recovered.developerExecutionId,
        targetBaseSha: recovered.targetBaseSha,
        resultCommit: recovered.subjectCommit,
        resultTree: recovered.subjectTree,
        expectedHeadSha: recovered.subjectCommit,
        expectedHeadTree: recovered.subjectTree,
      });
      result = recovered.review;
    } else {
    const reviewing = stateTransitions.reviewingDeliveryState(ctx.state);
    ctx.state = reviewing;
    await ctx.project();
    const subject = { planRevision: ctx.state.planRevision ?? ctx.state.revision, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, developerExecutionId: ctx.state.developerExecutionId!, deliveryArtifactId: ctx.state.deliveryArtifactId!, developerEvidenceArtifactId: ctx.state.developerEvidenceArtifactId!, leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef! };
    const common = { taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, branchName: ctx.state.branchName!, ...(ctx.state.deliverySummary ? { deliverySummary: ctx.state.deliverySummary } : {}) };
    try {
      // A CI repair produces a fresh delivery; it does not supersede the last blocking review's subject.
      const ciRepairDelivery = Boolean(ctx.state.ciRepairDeveloperExecutionId) && ctx.state.ciRepairDeveloperExecutionId === ctx.state.developerExecutionId;
      const supersedesReviewId = ctx.state.targetBaseOutcome === "revalidated" || ctx.state.developerTurnKind === "implementation" || !ctx.state.deliveryRepairAttemptId || ciRepairDelivery
        ? null
        : ctx.state.deliveryReviewSupersedesId ?? null;
      result = await ctx.acquireExternalTurn<contracts.DeliveryReviewActivityResult | LegacyReviewResult>(
        { operation: "delivery_review", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => activityProxies.reviewDelivery({ ...common, subject, worktreePath: ctx.state.worktreePath!, supersedesReviewId, ...(ctx.input.visualEvidence !== undefined ? { visualEvidence: ctx.input.visualEvidence } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }) as unknown as Promise<contracts.DeliveryReviewActivityResult | LegacyReviewResult>,
        (value) => "attemptId" in value ? (value.outcome === "completed" ? value.review.leadExecutionId : value.executionId) : undefined,
      );
    } catch (error) {
      if (isCancellation(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log.error("Delivery review turn failed after dispatch", { workflowId: ctx.input.workflowId, taskId: ctx.input.issueId, error: message, stack: error instanceof Error ? error.stack : undefined });
      const completed = await legacyActivityProxies.findCompletedDeliveryReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, subjectCommit: subject.subjectCommit, subjectTree: subject.subjectTree }).catch((lookupError) => {
        log.error("Completed delivery-review lookup failed", { workflowId: ctx.input.workflowId, taskId: ctx.input.issueId, error: lookupError instanceof Error ? lookupError.message : String(lookupError), stack: lookupError instanceof Error ? lookupError.stack : undefined });
        return null;
      });
      if (completed) result = completed;
      else {
      let evidenceArtifactId: string | null = null;
      try { evidenceArtifactId = (await activityProxies.recordDeliveryBlocker({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, operation: "review" })).artifactId; } catch { /* Keep the fixed state transition if blocker recording itself is unavailable. */ }
      ctx.state = stateTransitions.reviewBlockedState(ctx.state, { attemptId: null, code: "review-infrastructure-failure", summary: `The review infrastructure did not complete: ${message.slice(0, 180)}. Retry the review.`, evidenceArtifactId }, true);
      await ctx.project();
      void command;
      return ctx.state;
      }
    }
    }
    const artifactBackedReview = true;
    // Deprecated: histories created before the minimum repair loop recorded this
    // marker here. Keep the call forever so those histories retain command order.
    void true;
    if (!("attemptId" in result)) {
      const legacyResult = result as LegacyReviewResult;
      if (artifactBackedReview && !legacyResult.reviewArtifact) throw ApplicationFailure.nonRetryable("Delivery review artifact is missing", "delivery_review_artifact_missing");
      const openBlocking = (legacyResult.findings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
      const canRepair = legacyResult.outcome === "blocking" && (ctx.state.repairCycle ?? 0) < ctx.repairCycleLimit;
      const nextStep = legacyResult.outcome === "approved" ? "delivery_reviewed" : canRepair ? "repair_required" : "development";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...stateTransitions.revisioned(ctx.state, nextStep, nextStep === "repair_required" ? "lead" : "human", nextStep === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextStep === "development" ? ["record_delivery_decision", "cancel_issue"] : ["publish_draft", "cancel_issue"], nextStep === "repair_required" ? "The Builder fixes the review findings" : nextStep === "development" ? "Your decision is necessary" : "Forge opens the pull request"), deliveryReviewId: legacyResult.reviewId, deliveryReviewOutcome: legacyResult.outcome, deliveryReviewSummary: legacyResult.summary, ...(legacyResult.reviewArtifact ? { deliveryReviewArtifact: legacyResult.reviewArtifact } : {}), deliveryBlockingFindings: openBlocking, repairCycle: ctx.state.repairCycle ?? 0 });
    } else {
      const exactResult = result as contracts.DeliveryReviewActivityResult;
      // A review observes the branch while it runs.  That observation is the
      // authoritative delivery subject; the state snapshot that started the turn
      // is only a hint.  Keep old histories byte-for-byte replayable.
      if (true) {
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
        : stateTransitions.repairRequiredState(ctx.state, exactResult, ctx.repairCycleLimit, true);
    }
    const pushReviewedHead = true;
    const shouldPushReviewedHead = ctx.state.step === "delivery_reviewed"
      && (ctx.input.deliveryTarget === "remote_branch"
        || Boolean(pushReviewedHead && ctx.input.deliveryTarget && ["pull_request_draft", "pull_request_ready", "merged"].includes(ctx.input.deliveryTarget) && ctx.state.pullRequestNumber && ctx.state.resultCommit && ctx.state.resultCommit.toLowerCase() !== ctx.state.expectedHeadSha?.toLowerCase()));
    if (shouldPushReviewedHead) await ctx.project();
    if (ctx.state.step === "delivery_reviewed" && ctx.input.deliveryTarget === "remote_branch") {
      await resumeReviewedDeliveryTarget(ctx);
    } else if (ctx.state.step === "delivery_reviewed" && ctx.input.deliveryTarget === "local_worktree") {
      await resumeReviewedDeliveryTarget(ctx);
    } else if (ctx.state.step === "delivery_reviewed" && pushReviewedHead && ctx.input.deliveryTarget && ["pull_request_draft", "pull_request_ready", "merged"].includes(ctx.input.deliveryTarget) && ctx.state.pullRequestNumber && ctx.state.resultCommit && ctx.state.resultCommit.toLowerCase() !== ctx.state.expectedHeadSha?.toLowerCase()) {
      await activityProxies.pushDeliveryBranch({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName!, commitSha: ctx.state.resultCommit! });
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_reviewed"), expectedHeadSha: ctx.state.resultCommit, expectedHeadTree: ctx.state.resultTree, allowedCommands: ctx.addRevisionCommand(ctx.state.allowedCommands), pendingAction: "Forge pushed the reviewed commit to the pull request", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } else {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, allowedCommands: ctx.addRevisionCommand(ctx.state.allowedCommands) });
    }
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    await ctx.project();
    void command;
    return ctx.state;
}

/** Resume the terminal delivery operation after a crash at delivery_reviewed.
 * Remote/local targets must never enter the PR publication path.
 */
export async function resumeReviewedDeliveryTarget(ctx: IssueWorkflowContext): Promise<contracts.IssueWorkflowState> {
  if (ctx.state.step !== "delivery_reviewed") return ctx.state;
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  if (ctx.input.deliveryTarget === "remote_branch") {
    await activityProxies.pushDeliveryBranch({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, branchName: ctx.state.branchName!, commitSha: ctx.state.resultCommit! });
  } else if (ctx.input.deliveryTarget !== "local_worktree") {
    return ctx.state;
  }
  const pendingAction = ctx.input.deliveryTarget === "remote_branch" ? "Done. Branch pushed." : "Done. Kept in the worktree.";
  ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("done"), owner: "human", allowedCommands: [], pendingAction, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
  await ctx.project();
  return ctx.state;
}

export async function arbitrateReview(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>, answerArtifactId?: string): Promise<contracts.IssueWorkflowState> {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  const runArbitration = (refusedDecision?: "repair") => ctx.acquireExternalTurn<contracts.ReviewArbitrationActivityResult>(
    { operation: "review_arbitration", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
    (capacityRequestId) => activityProxies.arbitrateReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, briefArtifactId: ctx.input.briefArtifactId, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadSessionRef: ctx.state.leadSessionRef!, worktreePath: ctx.state.worktreePath!, repairExhausted: ctx.state.arbitrationRepairExhausted ?? false, ...(answerArtifactId ? { answerArtifactId } : {}), ...(refusedDecision ? { refusedDecision } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
    (value) => value.leadExecutionId,
  );
  let result = await runArbitration();
  if (result.arbitration.decision === "repair" && ctx.state.arbitrationRepairExhausted) result = await runArbitration("repair");
  const base = { ...ctx.state, revision: ctx.state.revision + 1, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, leadExecutionId: result.leadExecutionId, leadSessionRef: result.leadSessionRef };
  if (result.arbitration.decision === "repair") {
    if (ctx.state.arbitrationRepairExhausted) {
      const recommendation = "The Planner could not choose a review outcome.";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...base, ...at("development"), owner: "human", allowedCommands: ["cancel_issue", "respond_plan_blocker"], pendingAction: "The Planner recommends that you cancel the task", planBlockerSubject: { companyId: ctx.input.companyId, issueId: ctx.input.issueId, workflowId: ctx.input.workflowId, artifactId: result.outputArtifactId, leadSessionRef: result.leadSessionRef, leadExecutionId: result.leadExecutionId, category: "human_decision", resumePhase: "review_arbitration" }, blocker: stateTransitions.humanBlocker("member_decision", recommendation, [{ command: "respond_plan_blocker", label: "Answer the Planner", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.outputArtifactId, "decision-blocker")) });
      await ctx.project();
      return ctx.state;
    }
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...base, ...at("repair_required"), owner: "lead", allowedCommands: ["repair_delivery", "cancel_issue"], pendingAction: "The Builder fixes the review findings", repairCycle: 0, arbitrationRepairLimit: 1, deliveryRepairPlan: result.arbitration.repair!.instruction, deliveryBlockingFindings: [{ findingId: result.arbitration.repair!.findingId, severity: "blocking", rationale: result.arbitration.summary, evidenceRef: result.arbitration.repair!.files.join(", "), disposition: "open", repairInstruction: result.arbitration.repair!.instruction }], blocker: null });
  } else if (result.arbitration.decision === "ask") {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...base, ...at("review_arbitration"), owner: "human", allowedCommands: ["respond_plan_blocker", "cancel_issue"], pendingAction: "Your decision is necessary", planBlockerSubject: { companyId: ctx.input.companyId, issueId: ctx.input.issueId, workflowId: ctx.input.workflowId, artifactId: result.outputArtifactId, leadSessionRef: result.leadSessionRef, leadExecutionId: result.leadExecutionId, category: "human_decision", resumePhase: "review_arbitration" }, blocker: stateTransitions.humanBlocker("member_decision", "Your decision is necessary", [{ command: "respond_plan_blocker", label: "Answer the Planner", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.outputArtifactId, "decision-blocker")) });
  } else if (result.arbitration.decision === "accept") {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...base, ...at("delivery_reviewed"), owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "The Planner recommends that you accept the delivery as is", deliveryReviewSummary: result.arbitration.recommendation, blocker: stateTransitions.humanBlocker("member_authorization", result.arbitration.recommendation!, [{ command: "publish_draft", label: "Publish the pull request", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.outputArtifactId, "delivery-review")) });
  } else {
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...base, ...at("development"), owner: "human", allowedCommands: ["cancel_issue", "respond_plan_blocker"], pendingAction: "The Planner recommends that you cancel the task", planBlockerSubject: { companyId: ctx.input.companyId, issueId: ctx.input.issueId, workflowId: ctx.input.workflowId, artifactId: result.outputArtifactId, leadSessionRef: result.leadSessionRef, leadExecutionId: result.leadExecutionId, category: "human_decision", resumePhase: "review_arbitration" }, blocker: stateTransitions.humanBlocker("member_decision", result.arbitration.recommendation!, [{ command: "respond_plan_blocker", label: "Answer the Planner", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.outputArtifactId, "decision-blocker")) });
  }
  await ctx.project();
  void command;
  return ctx.state;
}

export function registerDeliveryReviewHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  setHandler(issueUpdates.review_delivery, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("delivery review command", rawInput);
    return reviewDelivery(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["delivery_ready", "reviewing_delivery", "delivery_reviewed", "final_review"].includes(ctx.state.step)) throw new Error("Delivery review is not available in the current phase");
    if (isBlocked(ctx.state) && !stateTransitions.blockerOffers(ctx.state, "review_delivery") && !ctx.state.deliveryReviewBlockerCode) throw new Error("A review blocker is required before retrying delivery review");
    const completeSubject = ctx.state.developerExecutionId && ctx.state.developerSessionRef && ctx.state.branchName && ctx.state.targetBaseSha && ctx.state.resultCommit && ctx.state.resultTree && ctx.state.deliveryArtifactId && ctx.state.developerEvidenceArtifactId && ctx.state.leadSessionRef && ctx.state.leadOutputArtifactId;
    if (!completeSubject && !canRecoverRevalidatedReview(ctx.state)) throw new Error("An exact Developer delivery and Lead session are required before review");
  } });
  setHandler(issueUpdates.arbitrate_review, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("review arbitration command", rawInput);
    return arbitrateReview(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.step !== "review_arbitration" || ctx.state.owner !== "lead" || (isBlocked(ctx.state) && !stateTransitions.blockerOffers(ctx.state, "arbitrate_review"))) throw new Error("Review arbitration is not available in the current phase");
    if ((ctx.state.arbitrationCount ?? 0) > 2) throw new Error("Review arbitration is exhausted");
  } });
  setHandler(issueUpdates.repair_delivery, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("delivery repair command", rawInput);
    return repairDelivery(ctx, contracts.StartPlanningInputSchema.parse(rawInput));
  }), { validator(rawInput) {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.step !== "repair_required" && !isBlocked(ctx.state) && !ctx.state.allowedCommands.includes("repair_delivery")) throw new Error("Delivery repair is not available in the current phase");
    if (!ctx.state.deliveryReviewId || !(ctx.state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open")) throw new Error("Open blocking findings are required");
    if (isBlocked(ctx.state) && !stateTransitions.blockerOffers(ctx.state, "repair_delivery") && !ctx.state.deliveryRepairBlockerCode) throw new Error("A repair blocker is required before retrying delivery repair");
    if (ctx.input.repairCycleLimit !== undefined && (ctx.state.repairCycle ?? 0) >= ctx.repairCycleLimit) throw new Error("Delivery repair limit is exhausted");
    if (!ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.leadSessionRef) throw new Error("The prior Developer delivery must be preserved before repair");
  } });
  setHandler(issueUpdates.record_delivery_decision, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("delivery decision command", rawInput);
    const command = contracts.PlanCommandInputSchema.parse(rawInput);
    const decision = await activityProxies.recordDeliveryDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, note: command.note?.trim() || "Member decision recorded for blocked delivery" });
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_reviewed"), owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Ready to publish the pull request", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, deliveryDecisionArtifactId: decision.artifactId, blocker: null, stateChangedAt: new Date().toISOString() });
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    await ctx.project();
    return ctx.state;
  }, "record_delivery_decision"), { validator(rawInput) {
    const command = contracts.PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    const offeredDecision = stateTransitions.blockerOffers(ctx.state, "record_delivery_decision");
    const legacyRepairDecision = isBlocked(ctx.state) && ctx.state.allowedCommands.includes("repair_delivery");
    if ((ctx.state.step !== "repair_required" && !isBlocked(ctx.state)) || (!ctx.state.allowedCommands.includes("record_delivery_decision") && !legacyRepairDecision && !offeredDecision) || !ctx.state.deliveryReviewId) throw new Error("A delivery decision is not available in the current phase");
  } });

}

export async function repairDelivery(ctx: IssueWorkflowContext, command: ReturnType<typeof contracts.StartPlanningInputSchema.parse>): Promise<contracts.IssueWorkflowState> {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
    const noProgressEnabled = true;
    const repairCycleLimit = ctx.state.arbitrationRepairLimit ?? ctx.repairCycleLimit;
    const cycle = ctx.state.targetBaseOutcome === "revalidated" ? 1 : (ctx.state.repairCycle ?? 0) + 1;
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const priorExecutionId = ctx.state.developerExecutionId!;
    const turnExecutionId = developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "repair");
    const priorDelivery = { developerSessionRef: ctx.state.developerSessionRef!, reviewId: ctx.state.deliveryReviewId!, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, blockingFindings: ctx.state.deliveryBlockingFindings ?? [] };
    await ctx.withStateMutation(() => {
      if (ctx.state.revision !== command.expectedRevision || (ctx.state.step !== "repair_required" && !isBlocked(ctx.state))) throw new Error("Developer repair was superseded by another command");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: `Builder repair cycle ${cycle}`, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: ctx.supervisedDeveloperTurns ? turnExecutionId : ctx.state.developerExecutionId, developerAttempt, developerTurnKind: "repair", ...ctx.recoveryFields("starting", null, "Starting the bounded Developer repair.", null), activeOperation: { commandId: command.commandId, kind: "repair", startedRevision: ctx.state.revision + 1 } });
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
      repairCycleLimit,
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
      if (isCancellation(error)) throw error;
      log.error("Developer repair turn failed after dispatch", { workflowId: ctx.input.workflowId, taskId: ctx.input.issueId, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      let evidenceArtifactId: string | null = null;
      try { evidenceArtifactId = (await activityProxies.recordDeliveryBlocker({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, operation: "repair" })).artifactId; } catch { /* Keep the fixed state transition if blocker recording itself is unavailable. */ }
      const summary = error instanceof Error ? error.message : "The repair did not complete. Retry the repair.";
      const failure = ctx.permanentActivityFailure(error, true);
      const failureClass = noProgressEnabled ? classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : {}), summary, source: "local_check" }) : "code_failure";
      const evidence = stateTransitions.evidencePointer(evidenceArtifactId ?? failure?.evidenceArtifactId ?? undefined, "developer-repair");
      ctx.state = failureClass === "credential_missing" ? stateTransitions.credentialBlockedState(ctx.state, "repair_delivery", evidence) : failureClass === "transient_infrastructure" || failureClass === "rate_limited" ? stateTransitions.transientRetryState(ctx.state, "repair_delivery", summary) : stateTransitions.repairInfrastructureBlockedState(ctx.state, cycle, repairCycleLimit, evidenceArtifactId, summary, noProgressEnabled);
      await ctx.project();
      void command;
      return ctx.state;
    }
    if (outcome.status !== "completed") {
      await ctx.withStateMutation(() => {
        if (ctx.state.activeOperation?.commandId !== command.commandId) return;
        const allowedCommands = ctx.addRevisionCommand(["repair_delivery", "retry_development", "cancel_issue"]);
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands, pendingAction: outcome.summary, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: priorExecutionId, ...ctx.recoveryFields(outcome.status, outcome.reasonCode, outcome.summary, "lastHeartbeatAt" in outcome ? outcome.lastHeartbeatAt : null), developerEvidenceArtifactId: outcome.status === "failed" ? outcome.evidenceArtifactId : ctx.state.developerEvidenceArtifactId, activeOperation: null });
      });
      await ctx.project();
      return ctx.state;
    }
    const result: contracts.WorkflowDeveloperRepairResult | LegacyDeveloperRepairResult = outcome.result;
    if ("repairAttemptId" in result) {
      ctx.state = result.outcome === "completed"
        ? stateTransitions.repairedDeliveryAwaitingFreshReviewState(ctx.state, result)
        : stateTransitions.repairBlockedState(ctx.state, result, repairCycleLimit, noProgressEnabled);
    } else {
      const nextStep = result.outcome === "completed" ? "delivery_ready" : "development";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...stateTransitions.revisioned(ctx.state, nextStep, result.outcome === "completed" ? "lead" : "human", result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], result.outcome === "completed" ? "The Planner reviews the latest changes" : "Your decision is necessary"), ...(result.outcome === "completed" ? {} : stateTransitions.freshDeliveryLineage()), developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: result.worktreePath, branchName: result.branchName, targetBaseSha: result.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, deliveryReviewSupersedesId: result.outcome === "completed" ? ctx.state.deliveryReviewId : null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, ...(result.outcome === "completed" ? { deliveryBlockingFindings: [], deliveryRepairPlan: null } : {}) });
    }
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, allowedCommands: ctx.addRevisionCommand(ctx.state.allowedCommands), ...ctx.recoveryFields("active", null, "Developer repair result claimed.", null), activeOperation: null });
    if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
    await ctx.project();
    void command;
    return ctx.state;
}
