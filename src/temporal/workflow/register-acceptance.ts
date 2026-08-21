import { setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import * as activityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { issueUpdates } from "../issue-updates.js";
import type { AcceptDeliveryActivityInput } from "../issue-contracts.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerAcceptanceHandlers(ctx: IssueWorkflowContext): void {
  const validateFinalReview = (rawInput: contracts.StartPlanningInput): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || (ctx.state.phase !== "final_review" && !(ctx.state.phase === "delivery_blocked" && ctx.state.finalReviewFailureCode === "final_review_unavailable"))) throw new Error("Final review is not available in the current phase");
    return command;
  };
  const validateReconcileAcceptance = (rawInput: contracts.StartPlanningInput): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || ctx.state.phase !== "ready_reconciliation" || !ctx.state.acceptanceId) throw new Error("Acceptance reconciliation is not available in the current phase");
    return command;
  };
  let accept: (rawInput: contracts.PlanCommandInput, decision: "accept" | "request_changes") => Promise<contracts.IssueWorkflowState>;
  const runFinalReviewTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.releaseId || !ctx.state.deliveryReviewId || !ctx.state.ciRunId || !ctx.state.leadSessionRef || !ctx.state.leadOutputArtifactId || !ctx.state.developerExecutionId || !ctx.state.deliveryArtifactId || !ctx.state.developerEvidenceArtifactId || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree) throw new Error("Exact release, pull request, delivery review, CI, Lead, and Developer evidence is required for final review");
    if (!ctx.patched("forge-kodiak-merge-v1") && !(await ctx.runTargetBaseCheckpoint("pre_final_review"))) return ctx.state;
    let result;
    try {
      result = await ctx.acquireExternalTurn<contracts.FinalReviewActivityResult>(
        { operation: "final_review", ...stateTransitions.finalReviewerTurn(ctx), sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => activityProxies.finalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, roleProfiles: ctx.input.roleProfiles, releaseId: ctx.state.releaseId!, deliveryReviewId: ctx.state.deliveryReviewId!, ciRunId: ctx.state.ciRunId!, ...(ctx.state.releaseRepository && ctx.state.baseBranch && ctx.state.pullRequestNumber ? { pullRequestNumber: ctx.state.pullRequestNumber, repository: ctx.state.releaseRepository, baseBranch: ctx.state.baseBranch } : {}), planRevision: ctx.state.planRevision ?? ctx.state.revision, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, developerExecutionId: ctx.state.developerExecutionId!, deliveryArtifactId: ctx.state.deliveryArtifactId!, evidenceArtifactId: ctx.state.developerEvidenceArtifactId!, ...(ctx.state.worktreePath ? { worktreePath: ctx.state.worktreePath } : {}), branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (review) => review.leadExecutionId,
      );
    } catch (error) {
      const failure = ctx.permanentActivityFailure(error);
      const summary = failure?.summary ?? "Final review did not finish. Try again, or request changes to send the work back.";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["final_review", "request_delivery_changes", "cancel_issue"], pendingAction: summary, finalReviewFailureCode: "final_review_unavailable", blocker: failure?.category ? stateTransitions.humanBlocker(failure.category, summary, [{ command: "final_review", label: "Retry final review", requiresNote: false, destructive: false }, { command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    let repairPlan = result.outcome === "blocking" ? {
      planArtifactId: result.repairPlanArtifactId,
      planSha256: result.repairPlanSha256,
      findings: result.findings,
    } : undefined;
    if (result.outcome === "blocking") {
      try {
        const planned = await ctx.acquireExternalTurn<contracts.DeliveryRepairPlanResult>(
          { operation: "delivery_repair_plan", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => activityProxies.planDeliveryRepair({
          taskId: ctx.input.issueId,
          companyId: ctx.input.companyId,
          workflowId: ctx.input.workflowId,
          projectId: ctx.input.projectId,
          projectRevisionId: ctx.input.projectRevisionId,
          source: "final_review_blocking",
          leadSessionRef: ctx.state.leadSessionRef!,
          planRevision: ctx.state.planRevision ?? ctx.state.revision,
          releaseId: ctx.state.releaseId,
          deliveryReviewId: ctx.state.deliveryReviewId,
          finalReviewId: result.finalReviewId,
          ciRunId: ctx.state.ciRunId,
          evidenceArtifactIds: [result.evidenceArtifactId, result.opinionArtifactId],
          branchName: ctx.state.branchName!,
          worktreePath: ctx.state.worktreePath ?? ".",
          targetBaseSha: ctx.state.targetBaseSha!,
          subjectCommit: ctx.state.resultCommit!,
          subjectTree: ctx.state.resultTree!,
          findings: result.findings,
          ...(capacityRequestId ? { capacityRequestId } : {}),
          }),
          (plan) => plan.leadExecutionId,
        );
        repairPlan = { planArtifactId: planned.planArtifactId, planSha256: planned.planSha256, findings: planned.findings };
      } catch {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["record_delivery_decision", "cancel_issue"], pendingAction: "Final-review repair planning failed; inspect the recorded evidence", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, finalReviewSummary: result.summary, finalReviewOpinionArtifactId: result.opinionArtifactId, finalReviewEvidenceArtifactId: result.evidenceArtifactId, finalReviewFindings: result.findings, blocker: stateTransitions.humanBlocker("agent_exhausted", result.summary, [{ command: "record_delivery_decision", label: "Record delivery decision", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.reviewArtifact.artifactId, result.reviewArtifact.sha256, "delivery-review")), stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
    }
    const nextPhase = result.outcome === "approved" ? "accepted" : "repair_required";
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: result.outcome === "approved" ? "human" : "lead", allowedCommands: result.outcome === "approved" ? ["accept_delivery", "request_delivery_changes", "cancel_issue"] : ["repair_delivery", "cancel_issue"], pendingAction: result.outcome === "approved" ? "Member acceptance required" : "Lead repair plan required", finalReviewId: result.finalReviewId, finalReviewOutcome: result.outcome, finalReviewSummary: result.summary, finalReviewOpinionArtifactId: result.opinionArtifactId, finalReviewEvidenceArtifactId: result.evidenceArtifactId, finalReviewFailureCode: null, finalReviewFindings: result.findings, finalReviewRepairPlanArtifactId: repairPlan?.planArtifactId ?? null, finalReviewRepairPlanSha256: repairPlan?.planSha256 ?? null, deliveryBlockingFindings: result.outcome === "blocking" ? repairPlan?.findings ?? result.findings : ctx.state.deliveryBlockingFindings, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan?.planArtifactId ?? null, deliveryRepairPlanSha256: repairPlan?.planSha256 ?? null, deliveryRepairAuthority: result.outcome === "blocking" ? "final_review" : null, blocker: result.outcome === "approved" ? stateTransitions.humanBlocker("member_authorization", "Final delivery approval is required.", [{ command: "accept_delivery", label: "Accept delivery", requiresNote: false, destructive: false }, { command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }], stateTransitions.evidencePointer(result.reviewArtifact.artifactId, result.reviewArtifact.sha256, "delivery-review")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    if (result.outcome === "approved" && ctx.input.pullRequestMode === "auto_merge" && ctx.input.autoMergeActorUserId) return accept({ expectedRevision: ctx.state.revision, actorUserId: ctx.input.autoMergeActorUserId }, "accept");
    return ctx.state;
  };
  setHandler(issueUpdates.final_review, ctx.guarded(async (rawInput) => {
    validateFinalReview(rawInput);
    return ctx.runFinalReviewTurn();
  }, "final_review"), { validator(rawInput) { validateFinalReview(rawInput); } });
  accept = async (rawInput: contracts.PlanCommandInput, decision: "accept" | "request_changes"): Promise<contracts.IssueWorkflowState> => {
    const command = contracts.PlanCommandInputSchema.parse(rawInput);
    const exactAcceptanceReceipts = ctx.patched(ctx.exactAcceptanceReceiptPatch);
    const requestChangesFromBlockingReview = decision === "request_changes" && ctx.state.phase === "repair_required" && ctx.state.finalReviewOutcome === "blocking";
    const preIntentProviderRetry = decision === "accept" && ctx.state.phase === "delivery_blocked" && (ctx.state.acceptanceId ?? null) === null && ctx.state.acceptanceBlockerCode === "provider_unavailable" && ctx.state.allowedCommands.includes("accept_delivery");
    if (command.expectedRevision !== ctx.state.revision || (decision === "accept" ? ctx.state.phase !== "accepted" && !preIntentProviderRetry : ctx.state.phase !== "accepted" && !requestChangesFromBlockingReview)) throw new Error("Delivery acceptance is not available in the current phase");
    if (!ctx.state.releaseId || !ctx.state.finalReviewId || !ctx.state.ciRunId || !ctx.state.expectedHeadSha || !ctx.state.expectedHeadTree) throw new Error("Final review, CI, release, and GitHub evidence are required for acceptance");
    if (exactAcceptanceReceipts && (!ctx.state.deliveryReviewId || !ctx.state.pullRequestNumber || !ctx.state.releaseRepository || !ctx.state.baseBranch || !ctx.state.targetBaseSha || !ctx.state.leadSessionRef)) throw new Error("Final review, CI, release, and GitHub evidence are required for acceptance");
    if (!(await ctx.runTargetBaseCheckpoint("pre_acceptance"))) return ctx.state;
    const result = exactAcceptanceReceipts
      ? await activityProxies.acceptDelivery({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, releaseId: ctx.state.releaseId, deliveryReviewId: ctx.state.deliveryReviewId!, finalReviewId: ctx.state.finalReviewId, ciRunId: ctx.state.ciRunId, actorUserId: command.actorUserId, pullRequestNumber: ctx.state.pullRequestNumber!, repository: ctx.state.releaseRepository!, baseBranch: ctx.state.baseBranch!, baseSha: ctx.state.targetBaseSha!, leadSessionRef: ctx.state.leadSessionRef!, expectedHeadSha: ctx.state.expectedHeadSha, expectedHeadTree: ctx.state.expectedHeadTree, decision, autoMerge: decision === "accept" && ctx.input.pullRequestMode === "auto_merge", ...(command.note !== undefined ? { note: command.note } : {}) })
      : await activityProxies.acceptDelivery({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, releaseId: ctx.state.releaseId, finalReviewId: ctx.state.finalReviewId, ciRunId: ctx.state.ciRunId, actorUserId: command.actorUserId, expectedHeadSha: ctx.state.expectedHeadSha, expectedHeadTree: ctx.state.expectedHeadTree, decision } as unknown as AcceptDeliveryActivityInput);
    if (!exactAcceptanceReceipts) {
      const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "requested_changes" ? "repair_required" : "cancelled";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "repair_required" ? "Lead repair plan required" : "Issue cancelled", acceptanceId: result.acceptanceId, acceptedHeadSha: result.status === "accepted" ? ctx.state.expectedHeadSha : null, pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    let memberRepairPlan: { planArtifactId: string; planSha256: string; findings: typeof ctx.state.deliveryBlockingFindings } | undefined;
    if (decision === "request_changes" && result.status === "requested_changes") {
      const note = command.note?.trim() || "Member requested changes to the exact delivery";
      const finding = { findingId: `member_requested_changes_${ctx.state.revision}`, severity: "blocking" as const, rationale: note, evidenceRef: result.reasonArtifactId ?? "member acceptance decision", disposition: "open" as const, repairInstruction: note };
      try {
        const planned = await ctx.acquireExternalTurn<contracts.DeliveryRepairPlanResult>(
          { operation: "delivery_repair_plan", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => activityProxies.planDeliveryRepair({
          taskId: ctx.input.issueId,
          companyId: ctx.input.companyId,
          workflowId: ctx.input.workflowId,
          projectId: ctx.input.projectId,
          projectRevisionId: ctx.input.projectRevisionId,
          source: "member_requested_changes",
          leadSessionRef: ctx.state.leadSessionRef!,
          planRevision: ctx.state.planRevision ?? ctx.state.revision,
          releaseId: ctx.state.releaseId,
          deliveryReviewId: ctx.state.deliveryReviewId,
          finalReviewId: ctx.state.finalReviewId,
          ciRunId: ctx.state.ciRunId,
          acceptanceId: result.acceptanceId,
          reasonArtifactId: result.reasonArtifactId ?? null,
          evidenceArtifactIds: [ctx.state.finalReviewEvidenceArtifactId, ctx.state.finalReviewOpinionArtifactId, ...(result.reasonArtifactId ? [result.reasonArtifactId] : [])].filter((id): id is string => Boolean(id)),
          branchName: ctx.state.branchName ?? "delivery",
          worktreePath: ctx.state.worktreePath ?? ".",
          targetBaseSha: ctx.state.targetBaseSha!,
          subjectCommit: ctx.state.expectedHeadSha!,
          subjectTree: ctx.state.expectedHeadTree!,
          findings: [finding],
          ...(capacityRequestId ? { capacityRequestId } : {}),
          }),
          (plan) => plan.leadExecutionId,
        );
        memberRepairPlan = planned;
      } catch {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Member-requested repair planning failed; inspect the recorded evidence", acceptanceId: result.acceptanceId, acceptanceStatus: result.status, acceptanceReasonArtifactId: result.reasonArtifactId ?? null, acceptanceBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
    }
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "pending_ready" ? "ready_reconciliation" : result.status === "requested_changes" ? "repair_required" : result.status === "blocked" ? "delivery_blocked" : "cancelled";
    const preIntentProviderFailure = result.status === "blocked" && result.acceptanceId === null && result.outcome === "provider_unavailable";
    const clearReviewAuthority = decision === "request_changes" && result.status === "requested_changes" && memberRepairPlan ? { releaseId: null, releaseRepository: null, baseBranch: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciAttempt: 0, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, finalReviewSummary: null, finalReviewOpinionArtifactId: null, finalReviewEvidenceArtifactId: null, finalReviewFailureCode: null, finalReviewFindings: [], finalReviewRepairPlanArtifactId: null, finalReviewRepairPlanSha256: null, acceptanceId: null, acceptanceStatus: null, acceptanceAttempt: 0, acceptanceRetryAt: null, acceptanceBlockerCode: null, acceptanceBlockerEvidenceArtifactId: null, acceptanceReasonArtifactId: null, acceptedAt: null, readyAt: null, acceptedHeadSha: null, mergeAttempt: 0, mergeRetryAt: null, mergeObservationId: null, mergeBlockerCode: null, mergeBlockerEvidenceArtifactId: null, completionReceiptId: null, mergeOutcome: null, deliveryRepairAuthority: "member_requested_changes" as const } : {};
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...clearReviewAuthority, revision: ctx.state.revision + 1, phase: nextPhase, owner: nextPhase === "repair_required" ? "lead" : "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ready_reconciliation" ? ["reconcile_acceptance", "cancel_issue"] : nextPhase === "repair_required" ? ["repair_delivery", "cancel_issue"] : nextPhase === "delivery_blocked" ? (preIntentProviderFailure ? ["accept_delivery", "cancel_issue"] : result.acceptanceId ? ["reconcile_merge", "request_delivery_changes", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"]) : [], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ready_reconciliation" ? "Reconciling ready-for-review" : nextPhase === "repair_required" ? "Lead repair plan required" : nextPhase === "delivery_blocked" ? (preIntentProviderFailure ? "GitHub acceptance evidence unavailable; retry acceptance" : result.blockerSummary ?? "Delivery is blocked") : "Issue cancelled", acceptanceId: clearReviewAuthority.acceptanceId !== undefined ? clearReviewAuthority.acceptanceId : result.acceptanceId, acceptanceStatus: clearReviewAuthority.acceptanceStatus !== undefined ? clearReviewAuthority.acceptanceStatus : result.status, acceptanceAttempt: clearReviewAuthority.acceptanceAttempt !== undefined ? clearReviewAuthority.acceptanceAttempt : (ctx.state.acceptanceAttempt ?? 0) + 1, acceptanceRetryAt: clearReviewAuthority.acceptanceRetryAt !== undefined ? clearReviewAuthority.acceptanceRetryAt : result.retryAt ?? null, acceptanceBlockerCode: clearReviewAuthority.acceptanceBlockerCode !== undefined ? clearReviewAuthority.acceptanceBlockerCode : result.blockerCode ?? null, acceptanceBlockerEvidenceArtifactId: clearReviewAuthority.acceptanceBlockerEvidenceArtifactId !== undefined ? clearReviewAuthority.acceptanceBlockerEvidenceArtifactId : result.evidenceArtifactId ?? null, acceptanceReasonArtifactId: clearReviewAuthority.acceptanceReasonArtifactId !== undefined ? clearReviewAuthority.acceptanceReasonArtifactId : result.reasonArtifactId ?? ctx.state.acceptanceReasonArtifactId ?? null, acceptedAt: clearReviewAuthority.acceptedAt !== undefined ? clearReviewAuthority.acceptedAt : (decision === "accept" && exactAcceptanceReceipts ? result.acceptedAt ?? null : null), readyAt: clearReviewAuthority.readyAt !== undefined ? clearReviewAuthority.readyAt : result.readyAt ?? null, acceptedHeadSha: clearReviewAuthority.acceptedHeadSha !== undefined ? clearReviewAuthority.acceptedHeadSha : (decision === "accept" ? ctx.state.expectedHeadSha : null), pullRequestNumber: clearReviewAuthority.pullRequestNumber !== undefined ? clearReviewAuthority.pullRequestNumber : result.pullRequestNumber ?? ctx.state.pullRequestNumber, pullRequestUrl: clearReviewAuthority.pullRequestUrl !== undefined ? clearReviewAuthority.pullRequestUrl : result.pullRequestUrl ?? ctx.state.pullRequestUrl, deliveryBlockingFindings: memberRepairPlan?.findings ?? ctx.state.deliveryBlockingFindings, deliveryRepairPlan: memberRepairPlan ? null : ctx.state.deliveryRepairPlan, deliveryRepairPlanArtifactId: memberRepairPlan?.planArtifactId ?? ctx.state.deliveryRepairPlanArtifactId, deliveryRepairPlanSha256: memberRepairPlan?.planSha256 ?? ctx.state.deliveryRepairPlanSha256, deliveryRepairAuthority: memberRepairPlan ? "member_requested_changes" : ctx.state.deliveryRepairAuthority, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  const reconcileAcceptanceTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.acceptanceId) throw new Error("Acceptance reconciliation requires an acceptance intent");
    if ((ctx.state.acceptanceAttempt ?? 0) >= ctx.maxReconciliationAttempts) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Ready reconciliation retry limit exhausted", acceptanceBlockerCode: "acceptance_reconciliation_exhausted", acceptanceRetryAt: null, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const result = await activityProxies.reconcileAcceptance({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, acceptanceId: ctx.state.acceptanceId });
    const nextPhase = result.status === "accepted" ? "manual_merge" : result.status === "blocked" ? "delivery_blocked" : "ready_reconciliation";
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: "human", allowedCommands: nextPhase === "manual_merge" ? ["reconcile_merge", "cancel_issue"] : nextPhase === "ready_reconciliation" ? ["reconcile_acceptance", "cancel_issue"] : ["request_delivery_changes", "cancel_issue"], pendingAction: nextPhase === "manual_merge" ? "Waiting for member merge" : nextPhase === "ready_reconciliation" ? "Waiting for ready-for-review" : (result.blockerSummary ?? "Ready reconciliation is blocked"), acceptanceStatus: result.status, acceptanceAttempt: (ctx.state.acceptanceAttempt ?? 0) + 1, acceptanceRetryAt: result.retryAt, acceptanceBlockerCode: result.blockerCode ?? null, acceptanceBlockerEvidenceArtifactId: result.evidenceArtifactId ?? null, acceptedAt: result.acceptedAt, readyAt: result.readyAt, pullRequestNumber: result.pullRequestNumber || ctx.state.pullRequestNumber, pullRequestUrl: result.pullRequestUrl || ctx.state.pullRequestUrl, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  };
  setHandler(issueUpdates.accept_delivery, ctx.guarded((rawInput) => accept(rawInput, "accept"), "accept_delivery"));
  setHandler(issueUpdates.request_delivery_changes, ctx.guarded((rawInput) => accept(rawInput, "request_changes"), "request_delivery_changes"));
  setHandler(issueUpdates.reconcile_acceptance, ctx.guarded(async (rawInput) => {
    validateReconcileAcceptance(rawInput);
    return reconcileAcceptanceTurn();
  }, "reconcile_acceptance"), { validator(rawInput) { validateReconcileAcceptance(rawInput); } });
  ctx.runFinalReviewTurn = runFinalReviewTurn;
  ctx.reconcileAcceptanceTurn = reconcileAcceptanceTurn;
  ctx.retryAcceptDelivery = (command) => accept(command, "accept");
}
