import { setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import * as activityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueBlocker } from "../issue-contracts.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerCiHandlers(ctx: IssueWorkflowContext): void {
  const runExactCiRepairTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.ciRepairPlanId || !ctx.state.ciRepairPlanArtifactId || !ctx.state.ciRepairPlanEvidenceArtifactId || !ctx.state.ciAttemptId || !ctx.state.ciRunId || !ctx.state.expectedHeadSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName) throw new Error("The exact CI repair plan and prior Developer delivery are required");
    const ciRunId = ctx.state.ciRunId;
    const ciAttemptId = ctx.state.ciAttemptId;
    const repairPlanId = ctx.state.ciRepairPlanId;
    const repairPlanArtifactId = ctx.state.ciRepairPlanArtifactId;
    const repairPlanEvidenceArtifactId = ctx.state.ciRepairPlanEvidenceArtifactId;
    const failedHeadSha = ctx.state.expectedHeadSha;
    const priorDeveloperExecutionId = ctx.state.developerExecutionId;
    const priorDeveloperSessionRef = ctx.state.developerSessionRef;
    const branchName = ctx.state.branchName;
    const priorCommit = ctx.state.resultCommit;
    const priorTree = ctx.state.resultTree;
    const releaseId = ctx.state.releaseId;
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repairing", owner: "lead", allowedCommands: [], pendingAction: "Developer repairing the exact failed CI result", blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    try {
      const result = await ctx.acquireExternalTurn<contracts.WorkflowCiRepairActivityResult>(
        { operation: "ci_repair_execution", role: "implementer", profileId: ctx.input.roleProfiles.implementer, sessionRef: priorDeveloperSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => activityProxies.runCiRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, ...(releaseId ? { releaseId } : {}), projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, ciRunId, ciAttemptId, repairPlanId, repairPlanArtifactId, repairPlanEvidenceArtifactId, failedHeadSha, priorDeveloperExecutionId, priorDeveloperSessionRef, branchName, priorCommit, priorTree, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (repair) => repair.developerExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["request_delivery_changes", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required after CI repair" : "CI repair is blocked", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.outcome === "completed" ? "clean" : "dirty", deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.summary, developerOutcome: result.outcome === "completed" ? "completed" : "blocked", deliveryReviewId: result.outcome === "completed" ? null : ctx.state.deliveryReviewId, releaseId: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, ciRepairDeveloperExecutionId: result.developerExecutionId, ciRepairDeveloperSessionRef: result.developerSessionRef, blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker("verification_unrecoverable", result.summary, [{ command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.attentionEvidenceArtifactId, result.attentionEvidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } catch (error) {
      const failure = ctx.permanentActivityFailure(error);
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repair_required", owner: "human", allowedCommands: ctx.addRevisionCommand(["repair_ci", "cancel_issue"]), pendingAction: failure?.summary ?? "CI repair failed; retry the same exact repair", blocker: failure?.category ? stateTransitions.humanBlocker(failure.category, failure.summary, [{ command: "repair_ci", label: "Retry CI repair", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    }
    await ctx.project();
    return ctx.state;
  };
  const reconcileCiTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.releaseId || !ctx.state.expectedHeadSha) throw new Error("Exact release head is required for CI reconciliation");
    const attempt = (ctx.state.ciAttempt ?? 0) + 1;
    const expectedReleaseId = ctx.state.releaseId;
    const expectedHeadSha = ctx.state.expectedHeadSha;
    const expectedRevision = ctx.state.revision;
    let result;
    try {
      result = await activityProxies.reconcileCi({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, releaseId: ctx.state.releaseId, expectedHeadSha: ctx.state.expectedHeadSha, attemptNumber: attempt });
    } catch (error) {
      if (ctx.state.phase !== "ci_waiting" || ctx.state.revision !== expectedRevision || ctx.state.releaseId !== expectedReleaseId || ctx.state.expectedHeadSha !== expectedHeadSha) return ctx.state;
      const failure = ctx.permanentActivityFailure(error);
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ciAttempt: attempt, ciOutcome: "provider_unavailable", ciReason: "provider_failure_budget_exhausted", ciOwner: "human", ciRepairable: false, ciNextPollAt: null, phase: "delivery_blocked", owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], pendingAction: failure?.summary ?? "CI provider reconciliation failed", blocker: failure?.category ? stateTransitions.humanBlocker(failure.category, failure.summary, [{ command: "reconcile_ci", label: "Retry CI reconciliation", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (ctx.state.phase !== "ci_waiting" || ctx.state.revision !== expectedRevision || ctx.state.releaseId !== expectedReleaseId || ctx.state.expectedHeadSha !== expectedHeadSha) return ctx.state;
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ciAttempt: result.attemptNumber, ciAttemptId: result.attemptId, ciRunId: result.runId, ciOutcome: result.outcome, ciReason: result.reason, ciOwner: result.owner, ciRepairable: result.repairable, ciEvidenceArtifactId: result.evidenceArtifactId, ciPolicyHash: result.policyHash, ciPropagationDeadline: result.propagationDeadline, ciOverallDeadline: result.overallDeadline, ciNextPollAt: result.nextPollAt, pendingAction: result.outcome === "waiting" || result.outcome === "rate_limited" ? "Waiting for required CI" : result.summary, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    if (result.outcome === "passed") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "final_review", owner: "lead", allowedCommands: [], pendingAction: "Final Lead review", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.runFinalReviewTurn();
    }
    if (result.outcome === "failed" && result.repairable && result.owner === "lead" && result.evidenceArtifactId && ctx.state.leadSessionRef && ctx.state.ciAttemptId) {
      const leadSessionRef = ctx.state.leadSessionRef;
      const ciAttemptId = ctx.state.ciAttemptId;
      const evidenceArtifactId = result.evidenceArtifactId;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repair_planning", owner: "lead", allowedCommands: [], pendingAction: "Lead diagnosis of exact-head CI failure", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      try {
        const plan = await ctx.acquireExternalTurn<contracts.CiRepairPlanActivityResult>(
          { operation: "ci_repair_plan", role: "analyst", profileId: ctx.input.roleProfiles.analyst, sessionRef: leadSessionRef },
          (capacityRequestId) => activityProxies.planCiRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, leadSessionRef, ciRunId: result.runId, ciAttemptId, failedHeadSha: expectedHeadSha, evidenceArtifactId, requiredChecks: [], localVerification: [], ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (repairPlan) => repairPlan.leadExecutionId,
        );
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repair_required", owner: "lead", allowedCommands: [], pendingAction: "Developer repairing the exact failed CI result", ciRepairPlanId: plan.planId, ciRepairPlanArtifactId: plan.planArtifactId, ciRepairPlanEvidenceArtifactId: plan.evidenceArtifactId, ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return runExactCiRepairTurn();
      } catch {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["request_delivery_changes", "cancel_issue"]), pendingAction: "Lead CI repair planning failed; inspect the recorded evidence", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      await ctx.project();
    } else if (!(result.owner === "system" && result.retryAt)) {
      const category: IssueBlocker["category"] = result.outcome === "provider_unavailable" ? "provider_connectivity_exhausted" : result.outcome === "stale_head" ? "target_drift" : "verification_unrecoverable";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["reconcile_ci", "cancel_issue"]), pendingAction: result.summary, blocker: stateTransitions.humanBlocker(category, result.summary, [{ command: "reconcile_ci", label: "Retry CI reconciliation", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.evidenceArtifactId ?? undefined, result.evidenceArtifactSha256, "ci-evidence")), stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
    }
    return ctx.state;
  };
  setHandler(issueUpdates.reconcile_ci, async (rawInput) => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || !["ci_waiting", "delivery_blocked"].includes(ctx.state.phase) || !ctx.state.allowedCommands.includes("reconcile_ci")) throw new Error("CI reconciliation is not available in the current phase");
    if (ctx.state.phase === "delivery_blocked") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Retrying CI reconciliation", ciNextPollAt: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
    }
    return reconcileCiTurn();
  });
  setHandler(issueUpdates.repair_ci, async (rawInput) => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || ctx.state.phase !== "ci_repair_required") throw new Error("CI repair is not available in the current phase");
    if (ctx.state.ciRepairPlanId && ctx.state.ciRepairPlanArtifactId && ctx.state.ciRepairPlanEvidenceArtifactId && ctx.state.ciAttemptId && ctx.state.ciRunId && ctx.state.expectedHeadSha && ctx.state.resultCommit && ctx.state.resultTree && ctx.state.developerExecutionId && ctx.state.developerSessionRef && ctx.state.branchName) return runExactCiRepairTurn();
    if (!ctx.state.deliveryReviewId || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.leadSessionRef) throw new Error("The exact prior Developer delivery is required for CI repair");
    const cycle = (ctx.state.repairCycle ?? 0) + 1;
    if (cycle > ctx.repairCycleLimit) throw new Error("CI repair limit is exhausted");
    const priorDelivery = { leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef!, developerExecutionId: ctx.state.developerExecutionId!, reviewId: ctx.state.deliveryReviewId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, ciOutcome: ctx.state.ciOutcome };
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer CI repair cycle ${cycle}`, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    const ciFindings = (ctx.state.deliveryBlockingFindings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    const repairFindings = ciFindings.length ? ciFindings : [{ findingId: `ci_failure_${ctx.state.revision}`, severity: "blocking" as const, rationale: `Required CI did not pass: ${priorDelivery.ciOutcome ?? "failed"}`, evidenceRef: ctx.state.ciRunId ?? "CI reconciliation", disposition: "open" as const, repairInstruction: "Resolve the exact-head CI failure and rerun the required checks." }];
    const repairPlan = await ctx.acquireExternalTurn<contracts.DeliveryRepairPlanResult>(
      { operation: "delivery_repair_plan", role: "analyst", profileId: ctx.input.roleProfiles.analyst, sessionRef: priorDelivery.leadSessionRef, worktreePath: priorDelivery.worktreePath },
      (capacityRequestId) => activityProxies.planDeliveryRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, source: "ci_failure", leadSessionRef: priorDelivery.leadSessionRef, planRevision: ctx.state.planRevision ?? ctx.state.revision, releaseId: ctx.state.releaseId, deliveryReviewId: ctx.state.deliveryReviewId, ciRunId: ctx.state.ciRunId, evidenceArtifactIds: [ctx.state.developerEvidenceArtifactId, ctx.state.finalReviewEvidenceArtifactId].filter((id): id is string => Boolean(id)), branchName: priorDelivery.branchName, worktreePath: priorDelivery.worktreePath, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, findings: repairFindings, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (plan) => plan.leadExecutionId,
    );
    const result = await ctx.acquireExternalTurn<contracts.WorkflowDeveloperRepairResult>(
      { operation: "developer_repair", role: "implementer", profileId: ctx.input.roleProfiles.implementer, sessionRef: priorDelivery.developerSessionRef, worktreePath: priorDelivery.worktreePath },
      (capacityRequestId) => activityProxies.runDeveloperRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: priorDelivery.leadSessionRef, developerSessionRef: priorDelivery.developerSessionRef, developerExecutionId: priorDelivery.developerExecutionId, reviewId: priorDelivery.reviewId, repairAuthority: "ci_failure", cycle, repairCycleLimit: ctx.repairCycleLimit, worktreePath: priorDelivery.worktreePath, branchName: priorDelivery.branchName, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, blockingFindings: repairFindings, repairPlanArtifactId: repairPlan.planArtifactId, repairPlanSha256: repairPlan.planSha256, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (repair) => repair.developerExecutionId,
    );
    const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Fresh Lead delivery review required" : "Member decision required", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: ctx.state.worktreePath, branchName: result.branchName, targetBaseSha: result.subject.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.outcome === "completed" ? result.deliveryArtifactId : ctx.state.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.outcome === "completed" ? result.summary : ctx.state.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, activeOperation: null, deliveryReviewId: result.outcome === "completed" ? null : ctx.state.deliveryReviewId, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan.planArtifactId, deliveryRepairPlanSha256: repairPlan.planSha256, deliveryRepairAuthority: result.outcome === "completed" ? null : "ci_failure", releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  }, { validator(rawInput) { const command = contracts.StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision"); if (ctx.state.phase !== "ci_repair_required" || !ctx.state.developerExecutionId) throw new Error("CI repair is not available in the current phase"); } });

  ctx.reconcileCiTurn = reconcileCiTurn;
}
