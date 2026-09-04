import { at, isBlocked } from "../../issue-phases.js";
import { isCancellation, setHandler } from "../registry.js";
import * as contracts from "../issue-contracts.js";
import * as capacityContracts from "../../capacity-contracts.js";
import { assertPayloadWithinLimit } from "../policy.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { classifyRepairFailure } from "./runtime.js";
import { issueUpdates } from "../issue-updates.js";
import { applyTargetBaseRevalidation } from "../target-base.js";
import { arbitrateReview } from "./register-delivery-review.js";
import type { WorkflowDeliveryReviewResult } from "../issue-contracts.js";
import type { IssueWorkflowContext } from "./context.js";
export function registerCapacityHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  const agent = activityProxies;
  const resumeCapacityOperation = async (operation: capacityContracts.CapacityOperation): Promise<contracts.IssueWorkflowState> => {
    if (operation === "lead_planning") {
      const result = await ctx.acquireExternalTurn<contracts.LeadPlanningResult>(
        { operation, role: "planner", profileId: ctx.input.roleProfiles.planner },
        (capacityRequestId) => agent.runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (value) => value.leadExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...result, planRevision: ctx.state.revision, supplementalReviewUsed: false, ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue", ...(ctx.input.supplementalReview && ctx.input.roleProfiles.reviewer ? ["request_supplemental_review" as const] : [])], pendingAction: "Approve the final plan", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, revision: ctx.state.revision + 1 });
      await ctx.project();
      return ctx.state;
    }
    if (operation === "developer_execution") {
      const result = await ctx.acquireExternalTurn<contracts.WorkflowDeveloperExecutionResult>(
        { operation, role: "builder", profileId: ctx.input.roleProfiles.builder, sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => agent.runDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supersedesExecutionId: ctx.state.developerExecutionId ?? undefined, reuseWorktree: Boolean(ctx.state.worktreePath), ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (value) => value.developerExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at(result.outcome === "completed" ? "delivery_ready" : "development"), owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "The Planner reviews the delivery" : "Resolve the Builder blocker", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, targetBaseSha: result.targetBaseSha, currentStep: result.currentStep, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.deliverySummary, developerOutcome: result.outcome });
      await ctx.project();
      return ctx.state;
    }
    if (operation === "supplemental_review") {
      if (ctx.state.step !== "approval" || !ctx.state.leadOutputArtifactId || !ctx.state.leadEvidenceArtifactId || !ctx.state.leadSessionRef || !ctx.input.roleProfiles.reviewer) throw new Error("Supplemental review prerequisites changed; start the review command again");
      const review = await ctx.acquireExternalTurn<contracts.SupplementalReviewResult>(
        { operation, role: "reviewer", profileId: ctx.input.roleProfiles.reviewer },
        (capacityRequestId) => agent.runSupplementalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.planRevision ?? ctx.state.revision, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadEvidenceArtifactId: ctx.state.leadEvidenceArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.executionId,
      );
      const consolidated = await ctx.acquireExternalTurn<contracts.LeadPlanningResult>(
        { operation: "lead_consolidation", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
        (capacityRequestId) => agent.consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision + 1, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.leadExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...consolidated, revision: ctx.state.revision + 1, ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue"], pendingAction: "Approve the final plan", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, planRevision: ctx.state.planRevision ?? ctx.state.revision });
      await ctx.project();
      return ctx.state;
    }
    if (operation === "lead_consolidation") {
      if (ctx.state.step !== "approval" || !ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef || !ctx.state.supplementalReviewArtifactId) throw new Error("The Planner consolidates the plan prerequisites changed; request supplemental review again");
      const consolidated = await ctx.acquireExternalTurn<contracts.LeadPlanningResult>(
        { operation, role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
        (capacityRequestId) => agent.consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision + 1, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: ctx.state.supplementalReviewArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (result) => result.leadExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...consolidated, revision: ctx.state.revision + 1, ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue"], pendingAction: "Approve the final plan", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, supplementalReviewUsed: true, planRevision: ctx.state.planRevision ?? ctx.state.revision });
      await ctx.project();
      return ctx.state;
    }
    if (operation === "delivery_review") {
      if (ctx.state.step !== "reviewing_delivery" || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.worktreePath || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.deliveryArtifactId || !ctx.state.developerEvidenceArtifactId || !ctx.state.leadSessionRef || !ctx.state.leadOutputArtifactId || !ctx.input.roleProfiles.planner) throw new Error("Delivery review prerequisites changed; start delivery review again");
      const result = await ctx.acquireExternalTurn<WorkflowDeliveryReviewResult>(
        { operation, role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => activityProxies.reviewDelivery({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, subject: { planRevision: ctx.state.planRevision ?? ctx.state.revision, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, developerExecutionId: ctx.state.developerExecutionId!, deliveryArtifactId: ctx.state.deliveryArtifactId!, developerEvidenceArtifactId: ctx.state.developerEvidenceArtifactId!, leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef! }, supersedesReviewId: ctx.state.targetBaseOutcome === "revalidated" ? null : ctx.state.deliveryReviewSupersedesId ?? null, ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (review) => review.outcome === "completed" ? review.review.leadExecutionId : review.executionId,
      );
      ctx.state = result.outcome === "blocked" ? stateTransitions.reviewBlockedState(ctx.state, result) : stateTransitions.repairRequiredState(ctx.state, result, ctx.repairCycleLimit, true);
      await ctx.project();
      return ctx.state;
    }
    if (operation === "developer_repair") {
      const cycle = (ctx.state.repairCycle ?? 0) + 1;
      if (ctx.state.step !== "repair_required" || (ctx.input.repairCycleLimit !== undefined && cycle > ctx.repairCycleLimit) || !ctx.state.deliveryReviewId || (!ctx.state.deliveryReviewArtifact && (!ctx.state.deliveryRepairPlan || !(ctx.state.deliveryBlockingFindings ?? []).some((finding) => finding.severity === "blocking" && finding.disposition === "open"))) || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.leadSessionRef || !ctx.input.roleProfiles.builder) throw new Error("Developer repair prerequisites changed; start delivery repair again");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Builder repair cycle ${cycle}`, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      let result: contracts.WorkflowDeveloperRepairResult;
      try {
        result = await ctx.acquireExternalTurn<contracts.WorkflowDeveloperRepairResult>(
          { operation, role: "builder", profileId: ctx.input.roleProfiles.builder, sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => activityProxies.runDeveloperRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef!, developerExecutionId: ctx.state.developerExecutionId!, reviewId: ctx.state.deliveryReviewId!, repairAuthority: ctx.state.deliveryRepairAuthority ?? "delivery_review", cycle, repairCycleLimit: ctx.repairCycleLimit, ...(ctx.state.worktreePath ? { worktreePath: ctx.state.worktreePath } : {}), branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, ...(ctx.state.deliveryReviewArtifact ? { reviewArtifact: ctx.state.deliveryReviewArtifact } : ctx.state.deliveryRepairPlanArtifactId && ctx.state.deliveryRepairPlanSha256 ? { repairPlanArtifactId: ctx.state.deliveryRepairPlanArtifactId, repairPlanSha256: ctx.state.deliveryRepairPlanSha256 } : { blockingFindings: ctx.state.deliveryBlockingFindings ?? [], repairPlan: ctx.state.deliveryRepairPlan! }), ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (repair) => repair.developerExecutionId,
        );
      } catch (error) {
        if (isCancellation(error)) throw error;
        let evidenceArtifactId: string | null = null;
        try {
          evidenceArtifactId = (await activityProxies.recordDeliveryBlocker({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, operation: "repair" })).artifactId;
        } catch (fallbackError) {
          if (isCancellation(fallbackError)) throw fallbackError;
        }
        const summary = error instanceof Error ? error.message : "The repair did not complete. Retry the repair.";
        const failure = ctx.permanentActivityFailure(error, true);
        const failureClass = classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : {}), summary, source: "local_check" });
        const evidence = stateTransitions.evidencePointer(evidenceArtifactId ?? failure?.evidenceArtifactId ?? undefined, "developer-repair");
        ctx.state = failureClass === "credential_missing" ? stateTransitions.credentialBlockedState(ctx.state, "repair_delivery", evidence) : failureClass === "transient_infrastructure" || failureClass === "rate_limited" ? stateTransitions.transientRetryState(ctx.state, "repair_delivery", summary) : stateTransitions.repairInfrastructureBlockedState(ctx.state, cycle, ctx.repairCycleLimit, evidenceArtifactId, summary, true);
        await ctx.project();
        return ctx.state;
      }
      ctx.state = result.outcome === "completed" ? stateTransitions.repairedDeliveryAwaitingFreshReviewState(ctx.state, result) : stateTransitions.repairBlockedState(ctx.state, result, ctx.repairCycleLimit, true);
      await ctx.project();
      return ctx.state;
    }
    if (operation === "merge_conflict_plan") {
      if (ctx.state.step !== "merge_conflict_reviewing" || !ctx.state.leadSessionRef || !ctx.state.leadOutputArtifactId || !ctx.state.worktreePath || !ctx.state.branchName || !ctx.state.forwardMergeId || !ctx.state.forwardMergePriorHead || !ctx.state.forwardMergeTargetBaseSha || !ctx.state.forwardMergeConflictArtifact || typeof ctx.state.forwardMergeConflictFileCount !== "number" || !stateTransitions.integratorTurn(ctx, "planner").profileId) throw new Error("Conflict-plan prerequisites changed; publish the draft again to revalidate the merge");
      try {
        const plan = await ctx.acquireExternalTurn<contracts.MergeConflictPlanActivityResult>(
          { operation, ...stateTransitions.integratorTurn(ctx, "planner"), sessionRef: ctx.state.leadSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => activityProxies.planMergeConflict({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, executionRole: stateTransitions.integratorTurn(ctx, "planner").role === "integrator" ? "integrator" : "planner", leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, forwardMergeId: ctx.state.forwardMergeId!, priorHead: ctx.state.forwardMergePriorHead!, targetBaseSha: ctx.state.forwardMergeTargetBaseSha!, conflictArtifact: ctx.state.forwardMergeConflictArtifact!, conflictFileCount: ctx.state.forwardMergeConflictFileCount!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (result) => result.leadExecutionId,
        );
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "The Builder waits for the Planner conflict plan", mergeResolutionPlanId: plan.planId, mergeResolutionPlanArtifactId: plan.planArtifactId, mergeResolutionLeadExecutionId: plan.leadExecutionId, mergeResolutionLeadSessionRef: plan.leadSessionRef, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      } catch (error) {
        if (isCancellation(error)) throw error;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Forge did not prepare a conflict plan. Retry the resolution.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      await ctx.project();
      return ctx.state;
    }
    if (operation === "merge_conflict_resolution") {
      if (!isBlocked(ctx.state) || !ctx.state.mergeResolutionPlanArtifactId || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.worktreePath || !ctx.state.branchName || !ctx.state.forwardMergeId || !ctx.state.forwardMergePriorHead || !ctx.state.forwardMergeTargetBaseSha || !ctx.state.forwardMergeConflictArtifact || typeof ctx.state.forwardMergeConflictFileCount !== "number" || !stateTransitions.integratorTurn(ctx, "builder").profileId) throw new Error("Conflict-resolution prerequisites changed; revalidate the Lead plan and Developer worktree");
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "lead", allowedCommands: [], pendingAction: "The Builder resolves the merge conflicts", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      try {
        const result = await ctx.acquireExternalTurn<Awaited<ReturnType<typeof activityProxies.resolveMergeConflict>>>(
          { operation, ...stateTransitions.integratorTurn(ctx, "builder"), sessionRef: ctx.state.developerSessionRef, worktreePath: ctx.state.worktreePath },
          (capacityRequestId) => activityProxies.resolveMergeConflict({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.planRevision ?? ctx.state.revision, forwardMergeId: ctx.state.forwardMergeId!, developerExecutionId: ctx.state.developerExecutionId!, developerSessionRef: ctx.state.developerSessionRef!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, priorHead: ctx.state.forwardMergePriorHead!, targetBaseSha: ctx.state.forwardMergeTargetBaseSha!, conflictArtifact: ctx.state.forwardMergeConflictArtifact!, conflictFileCount: ctx.state.forwardMergeConflictFileCount!, planArtifactId: ctx.state.mergeResolutionPlanArtifactId!, ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (resolution) => resolution.developerExecutionId,
        );
        if ("outcome" in result) {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: result.summary, targetBaseOutcome: "blocked", targetBaseBlockerCode: result.code, targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: result.summary, developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: "clean", developerEvidenceArtifactId: result.verificationArtifact.id, developerOutcome: "blocked", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        } else {
          const successfulResult = result as Extract<typeof result, { deliveryArtifactId: string }>;
          ctx.state = applyTargetBaseRevalidation(ctx.state, { outcome: "revalidated", checkId: ctx.state.forwardMergeId!, checkpoint: ctx.state.targetBaseCheckpoint ?? "pre_release", expectedBaseSha: ctx.state.targetBaseSha!, observedBaseSha: ctx.state.forwardMergeTargetBaseSha!, priorHead: ctx.state.forwardMergePriorHead!, priorTree: ctx.state.forwardMergePriorTree!, headSha: successfulResult.resultCommit, headTree: successfulResult.resultTree, developerExecutionId: successfulResult.developerExecutionId, deliveryArtifact: { id: successfulResult.deliveryArtifactId, kind: "forward-merge-delivery" }, verificationArtifact: { id: successfulResult.verificationArtifactId, kind: "forward-merge-verification" }, developerEvidenceArtifactId: successfulResult.evidenceArtifactId });
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, worktreePath: successfulResult.worktreePath ?? ctx.state.worktreePath, developerSessionRef: successfulResult.developerSessionRef, deliverySummary: successfulResult.summary, developerEvidenceArtifactId: successfulResult.evidenceArtifactId, mergeResolutionDeveloperExecutionId: successfulResult.developerExecutionId, mergeResolutionDeveloperSessionRef: successfulResult.developerSessionRef });
        }
      } catch (error) {
        if (isCancellation(error)) throw error;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "The Builder did not resolve the conflicts. Retry.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      await ctx.project();
      return ctx.state;
    }
    if (operation === "final_review") return ctx.runFinalReviewTurn();
    if (operation === "review_arbitration") return arbitrateReview(ctx, { expectedRevision: ctx.state.revision, actorUserId: "forge-capacity-retry", commandId: `${ctx.state.workflowId}:retry-arbitration:${ctx.state.revision}` });
    throw new Error(`Capacity retry for ${operation} requires the original phase command to revalidate its inputs`);
  };
  setHandler(issueUpdates.retry_capacity, ctx.guarded(async (rawInput: any) => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || !ctx.state.capacityBlocker || !ctx.state.allowedCommands.includes("retry_capacity")) throw new Error("Capacity retry is not available in the current state");
    if (ctx.state.capacity) {
      const request = await activityProxies.inspectCapacity({ requestId: ctx.state.capacity.requestId });
      if (request.status === "active") throw new Error("Capacity cancellation must settle before retry");
    }
    const operation = ctx.state.capacityBlocker.resumeOperation;
    const nextStep = operation === "lead_planning" ? "planning" : operation === "developer_execution" ? "development" : operation === "delivery_review" ? "reviewing_delivery" : operation === "review_arbitration" ? "review_arbitration" : operation === "developer_repair" ? "repair_required" : operation === "final_review" ? "final_review" : operation === "merge_conflict_resolution" ? "merge_conflict_resolving" : operation === "merge_conflict_plan" ? "merge_conflict_reviewing" : "approval";
    const nextCommands = nextStep === "planning" ? [] : nextStep === "development" ? ["cancel_development", "cancel_issue"] : nextStep === "reviewing_delivery" || nextStep === "review_arbitration" ? [] : nextStep === "final_review" ? [] : nextStep === "repair_required" ? ["cancel_issue"] : nextStep === "merge_conflict_resolving" ? ["cancel_issue"] : nextStep === "merge_conflict_reviewing" ? ["cancel_issue"] : ["cancel_issue"];
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, capacity: null, capacityBlocker: null, ...at(nextStep), owner: nextStep === "approval" ? "human" : "lead", allowedCommands: nextCommands, pendingAction: `Retry ${operation.replaceAll("_", " ")}`, revision: ctx.state.revision + 1, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    void command;
    return resumeCapacityOperation(operation);
  }));
  setHandler(issueUpdates.record_progress, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("recordProgress command", rawInput);
    contracts.RecordProgressInputSchema.parse(rawInput);
    const next = contracts.IssueWorkflowStateSchema.parse({
      ...ctx.state,
      revision: ctx.state.revision + 1,
      allowedCommands: ctx.continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "The Planner writes the plan",
      lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`,
      continuationCount: ctx.state.continuationCount,
      lastSummaryHash: ctx.state.lastSummaryHash,
    });
    ctx.state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    if (ctx.shouldContinueAsNew(next.revision)) ctx.continuationRequested = true;
    await ctx.project();
    return next;
  }), {
    validator(rawInput) {
      const command = contracts.RecordProgressInputSchema.parse(rawInput);
      if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
      if (ctx.state.step !== "planning") throw new Error("Progress can only be recorded during Planning");
    },
  });

  ctx.resumeCapacityOperation = resumeCapacityOperation;
}
