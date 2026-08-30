import { CancellationScope, condition, log, setHandler } from "../registry.js";

import { routeLeadResult } from "../../plan-governance.js";
import { plannerNoteAvailable } from "../../commands/definitions/planning.js";
import { assertPayloadWithinLimit } from "../policy.js";
import {
  IssueWorkflowStateSchema,
  PlanCommandInputSchema,
  PlanRevisionCommandSchema,
  SendPlannerNoteInputSchema,
  StartPlanningInputSchema,
  type IssueCommand,
  type IssueWorkflowState,
  type LeadPlanningResult,
  type PlanCommandInput,
} from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import {
  authorizePlanRevision,
  agentActivities,
  cancelDeveloperExecution,
  recordPlanBlockerResponse,
  recordPlanDecision,
  recordPlannerNote,
  findActiveDeveloperExecution,
  preparePlanRevision,
} from "./activity-proxies.js";
import { retryDevelopment, startDevelopment } from "./register-development.js";
import { resolveMergeConflict } from "./register-merge.js";
import { evidencePointer, humanBlocker } from "./state-transitions.js";
import type { IssueWorkflowContext } from "./context.js";

async function autoApprovePlan(ctx: IssueWorkflowContext, autoStart = true): Promise<void> {
  if (!ctx.input.autoApprovePlan || !ctx.input.autoApprovePlanActorUserId || ctx.state.phase !== "approval" || !ctx.state.planMaterial) return;
  const subject = ctx.state.finalPlanSubject && ctx.state.materialityEvidence ? { plan: ctx.state.finalPlanSubject, materiality: ctx.state.materialityEvidence, expectedWorkflowRevision: ctx.state.revision } : undefined;
  const planRevision = subject?.plan.outputRevision ?? ctx.state.planRevision ?? ctx.state.revision;
  const autoApprovalKey = subject ? `auto-approve:${subject.plan.artifactId}` : undefined;
  const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, actorUserId: ctx.input.autoApprovePlanActorUserId, decision: "approve", ...(subject ? { subject } : {}), note: "Plan auto-approved when the task was created", ...(autoApprovalKey ? { idempotencyKey: autoApprovalKey } : {}) });
  // Routine plans are already operator-authorized by task creation.  Do not
  // manufacture a human approval dependency that can later conflict with a
  // regenerated plan artifact.
  ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.state.finalPlanSubject ? ["start_development", "request_plan_revision", "cancel_issue"] : ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, decisionId: decision.decisionId, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: ctx.input.autoApprovePlanActorUserId, blocker: null, stateChangedAt: new Date().toISOString(), ...(subject && autoApprovalKey ? { planDecisionReceipt: { idempotencyKey: autoApprovalKey, decisionId: decision.decisionId, decision: "approve" as const, subjectArtifactId: subject.plan.artifactId } } : {}) });
  // Auto-approve means "run to completion without me": start the Developer turn here instead of parking on a human click.
  if (!autoStart || !true || ctx.state.phase !== "ready_for_development" || !ctx.state.allowedCommands.includes("start_development")) return;
  // Project the landing revision first: chaining straight into the Developer turn would
  // otherwise leave a gap the timeline and the task view never see.
  if (true) await ctx.project();
  await startDevelopment(ctx,{ expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-start-development:${ctx.state.revision}`, actorUserId: ctx.input.autoApprovePlanActorUserId });
}

async function runPlanReview(ctx: IssueWorkflowContext, plan: LeadPlanningResult): Promise<LeadPlanningResult> {
  // Keep completed histories on their recorded sequence. New tasks place the
  // trusted Reviewer immediately after every Planner turn.
  const reviewEnabled = true;
  const reviewVisibilityEnabled = true;
  const reviewFailure = (reason: string): LeadPlanningResult => {
    if (reviewVisibilityEnabled) ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, lastHandlerError: { command: "supplemental_review", reason, at: new Date().toISOString() } });
    return plan;
  };
  if (!ctx.input.supplementalReview || plan.leadOutputKind !== "plan") return plan;
  if (!reviewEnabled) return reviewFailure("Second review was not scheduled by this workflow version.");
  if (!ctx.input.roleProfiles.reviewer) return reviewFailure("Second review was requested, but no Reviewer profile is assigned.");
  if (!ctx.state.leadOutputArtifactId || !ctx.state.leadEvidenceArtifactId) return reviewFailure("Second review could not start because the Planner output or evidence is unavailable.");
  try {
    const review = await ctx.acquireExternalTurn<import("../issue-contracts.js").SupplementalReviewResult>(
      { operation: "supplemental_review", role: "reviewer", profileId: ctx.input.roleProfiles.reviewer },
      (capacityRequestId) => agentActivities(ctx.herdrExecutionSubstrateEnabled).runSupplementalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.planRevision ?? ctx.state.revision, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadEvidenceArtifactId: ctx.state.leadEvidenceArtifactId!, ...(ctx.state.leadSessionRef ? { primaryLeadSessionRef: ctx.state.leadSessionRef } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.executionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, ...(ctx.state.lastHandlerError?.command === "supplemental_review" ? { lastHandlerError: null } : {}) });
    if (review.verdict !== "revise" || !review.concerns?.some((concern) => concern.severity === "blocking") || !ctx.state.leadSessionRef) return plan;
    const revised = await ctx.acquireExternalTurn<LeadPlanningResult>(
      { operation: "lead_consolidation", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
      (capacityRequestId) => agentActivities(ctx.herdrExecutionSubstrateEnabled).consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.leadExecutionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...revised, leadReviewResponseArtifactId: revised.leadReviewResponseArtifactId ?? null, finalPlanSubject: revised.planSubject ?? ctx.state.finalPlanSubject });
    return revised;
  } catch (error) {
    // A missing second opinion must never hold up a plan.
    const failure = ctx.permanentActivityFailure(error, true);
    return reviewFailure(`Second review did not finish: ${failure?.summary ?? "The reviewer could not be started."}`);
  }
}

export function registerPlanningHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.start_planning, ctx.guarded(async (rawInput: any) => {
    if (!ctx.exactPlanAuthorityEnabled && ctx.captureInitialProjectionState) await condition(() => ctx.initialProjectionComplete);
    if (ctx.initialProjectionBarrierEnabled) await ctx.initialProjection;
    assertPayloadWithinLimit("startPlanning command", rawInput);
    const input = StartPlanningInputSchema.parse(rawInput);
    if (ctx.state.revision !== input.expectedRevision || !ctx.state.allowedCommands.includes("start_planning")) throw new Error("Stale workflow revision");
    const next = IssueWorkflowStateSchema.parse({
      ...ctx.state,
      phase: "planning",
      revision: ctx.state.revision + 1,
      owner: "lead",
      allowedCommands: ctx.continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "Lead planning",
      blocker: null,
      stateChangedAt: new Date().toISOString(),
      lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`,
      continuationCount: ctx.state.continuationCount,
      lastSummaryHash: ctx.state.lastSummaryHash,
    });
    ctx.state = next;
    assertPayloadWithinLimit("Issue Workflow result", next);
    const planningProjection = ctx.planningProjectionFlags();
    const distinctPlanningStates = planningProjection.distinctPlanningStates;
    if (planningProjection.shouldProject) await ctx.projectInitialPlanningState(next, distinctPlanningStates);
    if (ctx.state.phase !== "planning" || ctx.state.revision !== next.revision) return ctx.state;
    if (ctx.leadPlanningEnabled()) {
      let leadResult;
      const durablePlanningCapacity = ctx.durablePlanningCapacityEnabled();
      try {
        const runPlanningTurn = () => ctx.acquireExternalTurn<LeadPlanningResult>(
          { operation: "lead_planning", role: "planner", profileId: ctx.input.roleProfiles.planner },
          (capacityRequestId) => agentActivities(ctx.herdrExecutionSubstrateEnabled).runLeadPlanning({
            taskId: ctx.input.issueId,
            companyId: ctx.input.companyId,
            workflowId: ctx.input.workflowId,
            projectId: ctx.input.projectId,
            projectRevisionId: ctx.input.projectRevisionId,
            briefArtifactId: ctx.input.briefArtifactId,
            imageArtifactIds: ctx.input.imageArtifactIds,
            roleProfiles: ctx.input.roleProfiles,
            revision: next.revision,
            ...(next.revisionRequestId ? { revisionRequestId: next.revisionRequestId } : {}),
            ...(next.revisionRequestId && next.leadSessionRef ? { resumeLeadSessionRef: next.leadSessionRef } : {}),
            ...(capacityRequestId ? { capacityRequestId } : {}),
          }),
          (result) => result.leadExecutionId,
          durablePlanningCapacity,
        );
        if (ctx.exactPlanAuthorityEnabled || durablePlanningCapacity) {
          leadResult = await runPlanningTurn();
        } else {
          const scope = new CancellationScope();
          ctx.planningScope = scope;
          ctx.planningPromise = scope.run(runPlanningTurn);
          try {
            leadResult = await ctx.planningPromise;
          } finally {
            ctx.planningPromise = undefined;
            ctx.planningScope = undefined;
          }
        }
      } catch (error) {
        if (ctx.currentState().phase === "cancelled") return ctx.currentState();
        if (ctx.state.capacityBlocker) return ctx.state;
        // A cancel (e.g. archive) that lands while the Lead turn is running must not be overwritten by the turn's failure.
        if (true && ["cancelled", "done"].includes(ctx.state.phase as string)) return ctx.state;
        const failure = ctx.permanentActivityFailure(error, true);
        if (!failure) throw error;
        const summary = failure.code === "activity-failed" ? "Planning failed; retry is available" : failure.summary;
        const failureBase = durablePlanningCapacity ? ctx.state : next;
        const failureRevision = failureBase.revision + 1;
        const capacityFailure = ["not-found", "not-owner", "duplicate", "conflict", "stale-revision", "profile-unavailable", "invalid-status", "deadline-exhausted"].includes(failure.code);
        const resumeTurn = ["turn_outcome_missing", "turn_stalled"].includes(failure.code) && true;
        const startupBlocked = failure.code === "agent_startup_blocked" && true;
        ctx.state = IssueWorkflowStateSchema.parse({
          ...failureBase,
          capacity: null,
          capacityBlocker: null,
          phase: capacityFailure ? "backlog" : "failed",
          revision: failureRevision,
          owner: "human",
          allowedCommands: resumeTurn ? ["start_planning", "cancel_issue"] : capacityFailure ? ["start_planning", "cancel_issue"] : ctx.reviseContinueEnabled ? ["start_planning", "continue_work", "cancel_issue"] : ["start_planning", "cancel_issue"],
          pendingAction: resumeTurn ? "Resume Lead turn" : capacityFailure ? `${summary} Retry planning.` : summary,
          lastHandlerError: { command: "start_planning", reason: failure.summary, at: new Date().toISOString() },
          blocker: startupBlocked ? humanBlocker("member_authorization", summary, [{ command: "start_planning", label: "Retry after answering the agent prompt", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : resumeTurn ? humanBlocker("agent_exhausted", summary, [{ command: "start_planning", label: "Resume Lead turn", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : failure.category ? humanBlocker(failure.category, summary, [{ command: "start_planning", label: "Retry planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : null,
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${ctx.state.workflowId}:${failureRevision}`,
        });
        await ctx.project();
        return ctx.state;
      }
      // A Lead result that lands after cancel_issue must not resurrect the issue: simple capacity
      // (forge-simple-capacity-v1) runs the turn without the durable stale-turn check.
      if (true && ctx.currentState().phase === "cancelled") return ctx.currentState();
      let planningBase = durablePlanningCapacity ? ctx.state : next;
      const queuedNotes = ctx.state.pendingPlannerNotes ?? [];
      if (queuedNotes.length && leadResult.leadSessionRef) {
        planningBase = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Planner is applying your note", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, pendingPlannerNotes: [] });
        ctx.state = planningBase;
        await ctx.project();
        leadResult = await agentActivities(ctx.herdrExecutionSubstrateEnabled).runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: planningBase.revision, leadSessionRef: leadResult.leadSessionRef, operatorNotes: queuedNotes });
      }
      if (ctx.exactPlanAuthorityEnabled) {
        ctx.state = IssueWorkflowStateSchema.parse({ ...planningBase, ...leadResult, ...(distinctPlanningStates ? { revision: planningBase.revision + 1, lastEventId: `${planningBase.workflowId}:${planningBase.revision + 1}` } : {}), planRevision: next.revision, planMaterial: leadResult.material, materialCategories: leadResult.materialCategories, preservedWorktreeCompatibility: leadResult.preservedWorktreeCompatibility ?? null, supplementalReviewUsed: false, blocker: null, stateChangedAt: new Date().toISOString(), originalPlanSubject: leadResult.planSubject ?? null, finalPlanSubject: leadResult.planSubject ?? null, materialityEvidence: leadResult.materialityEvidence ?? null, planBlockerSubject: leadResult.blockerSubject ?? null });
      } else {
        const routedLeadResult = ctx.leadResultRoutingEnabled() ? ctx.applyLeadResult(next, leadResult) : ctx.applyLegacyLeadResult(next, leadResult);
        ctx.state = IssueWorkflowStateSchema.parse({ ...routedLeadResult, ...(distinctPlanningStates ? { revision: next.revision + 1, lastEventId: `${next.workflowId}:${next.revision + 1}` } : {}), ...(ctx.leadResultKind(leadResult) === "plan" ? { planRevision: next.revision } : {}), supplementalReviewUsed: false });
      }
      if (ctx.state.revisionRequestId && ctx.state.revisedExecutionCoordinates?.disposition === "reuse" && ctx.state.preservedWorktreeCompatibility !== true) {
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "delivery_blocked", owner: "human", allowedCommands: ["revise_plan", "cancel_issue"], pendingAction: "Choose a new worktree for the revised plan", blockerCode: "preserved-worktree-incompatible" });
        await ctx.project();
        return ctx.state;
      }
      if (ctx.state.revisionRequestId) await authorizePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revisionRequestId: ctx.state.revisionRequestId, planRevision: ctx.state.planRevision ?? ctx.state.revision });
      leadResult = await runPlanReview(ctx, leadResult);
      if (ctx.planGovernanceEnabled()) {
        const route = routeLeadResult({ kind: leadResult.leadOutputKind, material: leadResult.material });
        const exactSubject = Boolean(ctx.state.finalPlanSubject);
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: route.phase, owner: route.owner, allowedCommands: route.phase === "approval" ? ctx.approvalCommands(exactSubject, ctx.input.supplementalReview) : route.phase === "ready_for_development" && !exactSubject ? ctx.addRevisionCommand(route.allowedCommands as IssueCommand[]) : route.allowedCommands, pendingAction: route.pendingAction, blocker: route.phase === "approval" ? ctx.approvalBlocker(leadResult, exactSubject, ctx.input.supplementalReview) : null, stateChangedAt: new Date().toISOString() });
        if (route.phase === "ready_for_development") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: null });
        await autoApprovePlan(ctx);
      }
      assertPayloadWithinLimit("Issue Workflow result", ctx.state);
      await ctx.project();
    }
    return ctx.state;
  }), {
    validator(rawInput) {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
      if (ctx.state.phase !== "backlog" && ctx.state.phase !== "planning" && ctx.state.phase !== "failed" && !(ctx.state.phase === "blocked" && ctx.state.blockedCategory !== "human_decision")) throw new Error("Planning can only start from Backlog, Planning, Failed, or an operator-correctable blocked state");
    },
  });
}

export function registerPlanningHandlersContinuation(ctx: IssueWorkflowContext): void {
  const validatePlanCommand = (rawInput: PlanCommandInput): PlanCommandInput => {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "approval") throw new Error("Plan command is not available in the current phase");
    return command;
  };
  const hashFreeArtifacts = true;
  const executeLeadTurn = async (leadSessionRef?: string, revisionNote?: { artifactId: string; sha256?: string }, memberResponse?: { artifactId: string; sha256?: string }, operatorNotes?: string[], resumeDevelopment = false): Promise<IssueWorkflowState> => {
    const leadResult = await agentActivities(ctx.herdrExecutionSubstrateEnabled).runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, ...(leadSessionRef ? { leadSessionRef } : {}), ...(revisionNote ? { revisionNoteArtifactId: revisionNote.artifactId, ...(!hashFreeArtifacts && revisionNote.sha256 ? { revisionNoteSha256: revisionNote.sha256 } : {}) } : {}), ...(memberResponse ? { memberResponseArtifactId: memberResponse.artifactId, ...(!hashFreeArtifacts && memberResponse.sha256 ? { memberResponseSha256: memberResponse.sha256 } : {}) } : {}), ...(operatorNotes?.length ? { operatorNotes } : {}) });
    if (true && ctx.currentState().phase === "cancelled") return ctx.currentState();
    const acceptedRevision = ctx.state.revision + 1;
    const route = routeLeadResult({ kind: leadResult.leadOutputKind, material: leadResult.material });
    const exactSubject = Boolean(leadResult.planSubject);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...leadResult, revision: acceptedRevision, phase: route.phase, owner: route.owner, allowedCommands: route.phase === "approval" ? ctx.approvalCommands(exactSubject, ctx.input.supplementalReview) : route.phase === "ready_for_development" && !exactSubject ? ctx.addRevisionCommand(route.allowedCommands as IssueCommand[]) : route.allowedCommands, pendingAction: route.pendingAction, blocker: route.phase === "approval" ? ctx.approvalBlocker(leadResult, exactSubject, ctx.input.supplementalReview) : null, lastEventId: `${ctx.state.workflowId}:${acceptedRevision}`, planRevision: ctx.state.revision, planMaterial: leadResult.material, materialCategories: leadResult.materialCategories, supplementalReviewUsed: false, originalPlanSubject: leadResult.planSubject ?? null, finalPlanSubject: leadResult.planSubject ?? null, materialityEvidence: leadResult.materialityEvidence ?? null, planBlockerSubject: leadResult.blockerSubject ?? null });
    if (route.phase === "ready_for_development") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: null });
    await autoApprovePlan(ctx, !resumeDevelopment);
    await ctx.project();
    return ctx.state;
  };

  setHandler(issueUpdates.request_supplemental_review, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("supplemental review command", rawInput);
    const command = validatePlanCommand(rawInput);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "supplemental_review", owner: "lead", allowedCommands: [], revision: ctx.state.revision + 1, pendingAction: "Independent supplemental review", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    const review = await ctx.acquireExternalTurn<import("../issue-contracts.js").SupplementalReviewResult>(
      { operation: "supplemental_review", role: "reviewer", profileId: ctx.input.roleProfiles.reviewer },
      (capacityRequestId) => agentActivities(ctx.herdrExecutionSubstrateEnabled).runSupplementalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.originalPlanSubject?.originalPlanRevision ?? ctx.state.planRevision ?? ctx.state.revision, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadEvidenceArtifactId: ctx.state.leadEvidenceArtifactId!, ...(ctx.state.originalPlanSubject ? { originalPlanSubject: ctx.state.originalPlanSubject, primaryLeadSessionRef: ctx.state.originalPlanSubject.leadSessionRef, evidenceManifestArtifactId: ctx.state.originalPlanSubject.evidenceManifestArtifactId, ...(!hashFreeArtifacts && ctx.state.originalPlanSubject.evidenceManifestSha256 ? { evidenceManifestSha256: ctx.state.originalPlanSubject.evidenceManifestSha256 } : {}) } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.executionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "plan_consolidation", owner: "lead", allowedCommands: [], revision: ctx.state.revision + 1, pendingAction: "Lead consolidation", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, supplementalReviewSubject: review.subject ?? null });
    await ctx.project();
    const consolidated = await ctx.acquireExternalTurn<LeadPlanningResult>(
      { operation: "lead_consolidation", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
      (capacityRequestId) => agentActivities(ctx.herdrExecutionSubstrateEnabled).consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(ctx.state.originalPlanSubject ? { originalPlanSubject: ctx.state.originalPlanSubject, evidenceManifestArtifactId: ctx.state.originalPlanSubject.evidenceManifestArtifactId, ...(!hashFreeArtifacts && ctx.state.originalPlanSubject.evidenceManifestSha256 ? { evidenceManifestSha256: ctx.state.originalPlanSubject.evidenceManifestSha256 } : {}) } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.leadExecutionId,
    );
    const route = routeLeadResult({ kind: consolidated.leadOutputKind, material: consolidated.material });
    const exactSubject = Boolean(consolidated.planSubject);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...consolidated, revision: ctx.state.revision + 1, phase: route.phase, owner: route.owner, allowedCommands: route.phase === "approval" ? ctx.approvalCommands(exactSubject, false) : route.phase === "ready_for_development" && !exactSubject ? ctx.addRevisionCommand(route.allowedCommands as IssueCommand[]) : route.allowedCommands, pendingAction: route.pendingAction, blocker: route.phase === "approval" ? ctx.approvalBlocker(consolidated, exactSubject, false) : null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, finalPlanSubject: consolidated.planSubject ?? null, originalPlanSubject: ctx.state.originalPlanSubject, materialityEvidence: consolidated.materialityEvidence ?? null, planBlockerSubject: consolidated.blockerSubject ?? null, planMaterial: consolidated.material, materialCategories: consolidated.materialCategories, planRevision: ctx.state.planRevision ?? ctx.state.revision });
    if (route.phase === "ready_for_development") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: null });
    await autoApprovePlan(ctx);
    await ctx.project();
    void command;
    return ctx.state;
  }), { validator(rawInput) {
    validatePlanCommand(rawInput);
    if (!ctx.input.supplementalReview || ctx.state.supplementalReviewUsed) throw new Error("Supplemental review is not available");
    if (!ctx.state.planMaterial || !ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef || (ctx.exactPlanAuthorityEnabled && !ctx.state.originalPlanSubject)) throw new Error("A material Lead plan is required before supplemental review");
    if (!ctx.input.roleProfiles.reviewer) throw new Error("A supplemental reviewer profile is required");
  } });

  setHandler(issueUpdates.approve_plan, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan approval command", rawInput);
    const command = validatePlanCommand(rawInput);
    const decisionSubject = ctx.state.finalPlanSubject && ctx.state.materialityEvidence ? { plan: ctx.state.finalPlanSubject, materiality: ctx.state.materialityEvidence, expectedWorkflowRevision: command.expectedRevision } : undefined;
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const planRevision = ctx.state.planRevision ?? ctx.state.revision;
      if (ctx.state.revisionRequestId) await authorizePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revisionRequestId: ctx.state.revisionRequestId, planRevision });
      const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, actorUserId: command.actorUserId, decision: "approve", ...(command.note !== undefined ? { note: command.note } : {}), ...(decisionSubject ? { subject: decisionSubject } : {}), ...(command.noteStagingRef ? { noteStagingRef: command.noteStagingRef } : {}), ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}), ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}) });
      const plannerNote = ctx.state.developerExecutionId ? ctx.state.pendingPlannerNotes?.at(-1) : undefined;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.state.planMaterial && ctx.state.finalPlanSubject ? ["start_development", "request_plan_revision", "cancel_issue"] : ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, decisionId: decision.decisionId, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: command.actorUserId, blocker: null, stateChangedAt: new Date().toISOString(), pendingPlannerNotes: [], ...(command.idempotencyKey && decisionSubject ? { planDecisionReceipt: { idempotencyKey: command.idempotencyKey, decisionId: decision.decisionId, decision: "approve" as const, subjectArtifactId: decisionSubject.plan.artifactId } } : {}) });
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      await ctx.project();
      if (ctx.state.developerExecutionId) return await retryDevelopment(ctx, { expectedRevision: ctx.state.revision, actorUserId: command.actorUserId, commandId: `${command.commandId}:resume` }, plannerNote);
      return ctx.state;
    } finally { ctx.decisionInFlight = false; }
  }, "approve_plan"), { validator(rawInput) { validatePlanCommand(rawInput); if (!ctx.state.planMaterial) throw new Error("Routine plans do not require approval"); } });

  setHandler(issueUpdates.request_plan_revision, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("exact plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if ((ctx.state.phase !== "approval" && ctx.state.phase !== "ready_for_development") || !ctx.state.planMaterial || !ctx.state.finalPlanSubject) throw new Error("Exact plan revision is not available in the current phase");
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    const decisionSubject = ctx.state.materialityEvidence ? { plan: ctx.state.finalPlanSubject, materiality: ctx.state.materialityEvidence, expectedWorkflowRevision: command.expectedRevision } : undefined;
    if (!command.idempotencyKey || !command.noteStagingRef || (!hashFreeArtifacts && !command.noteSha256)) throw new Error("A required revision note and idempotency key are required");
    ctx.decisionInFlight = true;
    try {
      const previousRevision = ctx.state.revision;
      const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.finalPlanSubject.outputRevision, actorUserId: command.actorUserId, decision: "request_revision", ...(decisionSubject ? { subject: decisionSubject } : {}), noteStagingRef: command.noteStagingRef, idempotencyKey: command.idempotencyKey });
      const primaryLeadSessionRef = ctx.state.finalPlanSubject.leadSessionRef;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: previousRevision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${ctx.state.workflowId}:${previousRevision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, originalPlanSubject: null, finalPlanSubject: null, materialityEvidence: null, planDecisionReceipt: { idempotencyKey: command.idempotencyKey, decisionId: decision.decisionId, decision: "request_revision" as const, subjectArtifactId: decisionSubject?.plan.artifactId ?? ctx.state.finalPlanSubject.artifactId }, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
      await ctx.project();
      return await executeLeadTurn(primaryLeadSessionRef, decision.noteArtifactId ? { artifactId: decision.noteArtifactId } : undefined);
    } finally { ctx.decisionInFlight = false; }
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if ((ctx.state.phase !== "approval" && ctx.state.phase !== "ready_for_development") || !ctx.state.planMaterial || !ctx.state.finalPlanSubject) throw new Error("Exact plan revision is not available in the current phase");
  } });

  setHandler(issueUpdates.respond_plan_blocker, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan blocker response command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || command.expectedWorkflowRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "blocked" || !ctx.state.planBlockerSubject) throw new Error("Plan blocker response is not available in the current phase");
    if (!command.answerStagingRef || !command.idempotencyKey) throw new Error("A required blocker answer and idempotency key are required");
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const response = await recordPlanBlockerResponse({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, blockerArtifactId: ctx.state.planBlockerSubject.artifactId, ...(ctx.state.planBlockerSubject.artifactSha256 ? { blockerArtifactSha256: ctx.state.planBlockerSubject.artifactSha256 } : {}), expectedWorkflowRevision: command.expectedWorkflowRevision, answerStagingRef: command.answerStagingRef, idempotencyKey: command.idempotencyKey });
      if (!true && (hashFreeArtifacts || !ctx.state.planBlockerSubject.artifactSha256)) throw new Error("legacy receipt");
      const primaryLeadSessionRef = ctx.state.planBlockerSubject.leadSessionRef;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision after blocker response", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], planBlockerSubject: null, planBlockerResponseReceipt: { idempotencyKey: command.idempotencyKey, responseId: response.responseId, blockerSubjectHash: ctx.state.planBlockerSubject.artifactSha256 ?? null }, originalPlanSubject: null, finalPlanSubject: null, materialityEvidence: null, supplementalReviewUsed: false, supplementalReviewArtifactId: null });
      await ctx.project();
      const carryBlockerAnswer = true;
      if (!response.answerArtifactId) log.warn("Plan blocker response has no answer artifact", { workflowId: ctx.input.workflowId, responseId: response.responseId });
      return await executeLeadTurn(primaryLeadSessionRef, undefined, carryBlockerAnswer && response.answerArtifactId ? { artifactId: response.answerArtifactId } : undefined);
    } finally { ctx.decisionInFlight = false; }
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || command.expectedWorkflowRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "blocked" || !ctx.state.planBlockerSubject) throw new Error("Plan blocker response is not available in the current phase");
  } });

  setHandler(issueUpdates.send_planner_note, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("tell Planner command", rawInput);
    const command = SendPlannerNoteInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return ctx.state;
    await recordPlannerNote({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revision: command.expectedRevision, actorUserId: command.actorUserId, commandId: command.commandId, ...("noteId" in command ? { noteId: command.noteId, noteSha256: command.noteSha256 } : { note: command.note }) });
    ctx.markCommandProcessed(command.commandId);
    if (true && ctx.state.phase === "merge_conflict_required" && ctx.state.mergeDecision) {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Applying your decision", mergeResolutionPlanArtifactId: null, mergeDecision: null, pendingPlannerNotes: "note" in command ? [command.note] : [], blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return resolveMergeConflict(ctx, { expectedRevision: ctx.state.revision, actorUserId: command.actorUserId, commandId: `${ctx.state.workflowId}:decision-resolve:${ctx.state.revision}` });
    }
    if (ctx.herdrExecutionSubstrateEnabled) return ctx.state;
    if (["backlog", "planning", "supplemental_review", "plan_consolidation"].includes(ctx.state.phase) || !ctx.state.leadSessionRef) {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, pendingPlannerNotes: [...(ctx.state.pendingPlannerNotes ?? []), ...("note" in command ? [command.note] : [])].slice(-32) });
      return ctx.state;
    }
    const resumeDevelopment = Boolean(ctx.state.developerExecutionId);
    if (ctx.state.phase === "development" && ctx.state.developerExecutionId) {
      const cancellation = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId: ctx.state.developerExecutionId });
      if (!['cancelled', 'cancelled_confirmed', 'interrupted', 'completed_before_cancellation'].includes(cancellation.status)) throw new Error("Developer ownership must be cancelled before Planner feedback is applied");
      if (cancellation.status === "completed_before_cancellation" && !ctx.applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before Planner feedback.")) throw new Error("Completed Developer result is invalid");
      if (ctx.state.capacity) await ctx.settleCancelledCapacity(ctx.state.developerExecutionId);
    }
    const leadSessionRef = ctx.state.leadSessionRef;
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Planner is applying your note", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null, blocker: null, pendingPlannerNotes: [] });
    await ctx.project();
    if (!("note" in command)) return ctx.state;
    await executeLeadTurn(leadSessionRef, undefined, undefined, [command.note], resumeDevelopment);
    if (resumeDevelopment && ctx.state.phase === "approval") ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, pendingPlannerNotes: [command.note] });
    if (resumeDevelopment && ctx.state.phase === "ready_for_development") return retryDevelopment(ctx, { expectedRevision: ctx.state.revision, actorUserId: command.actorUserId, commandId: `${command.commandId}:resume` }, command.note);
    return ctx.state;
  }, "send_planner_note"), { validator(rawInput) {
    const command = SendPlannerNoteInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!plannerNoteAvailable(ctx.state.phase, ctx.state.successorTaskId)) throw new Error("Planner feedback is not available after the task has ended");
  } });
}

export function registerPlanningHandlersRevision(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.revise_plan, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanRevisionCommandSchema.parse(rawInput);
    if (ctx.state.phase === "development") {
      const active = ctx.state.developerExecutionId ? { executionId: ctx.state.developerExecutionId } : await findActiveDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId });
      if (!active) throw new Error("Developer ownership is unavailable for plan revision");
      const cancellation = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId: active.executionId });
      if (cancellation.status === "completed_before_cancellation") {
        if (!ctx.applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before plan revision.")) throw new Error("Completed Developer result is invalid");
        await ctx.project();
        return ctx.state;
      }
      if (!["cancelled", "cancelled_confirmed", "interrupted"].includes(cancellation.status)) {
        const summary = "summary" in cancellation ? cancellation.summary : "Developer ownership must be precisely cancelled before plan revision";
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: summary, ...ctx.recoveryFields("interrupted", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
    }
    const prepared = await preparePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, requestRevision: ctx.state.revision, actorUserId: command.actorUserId, reason: command.reason, worktreeDisposition: command.worktreeDisposition, ...(command.worktreeDisposition === "new" ? { exactBaseSha: command.exactBaseSha } : {}), ...(ctx.state.developerExecutionId ? { developerExecutionId: ctx.state.developerExecutionId } : {}) });
    if (prepared.status === "blocked") {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["revise_plan", "cancel_issue"]), pendingAction: "Plan revision is blocked", blockerCode: prepared.blockerCode, revisionRequestId: prepared.revisionRequestId, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } else {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", blockerCode: null, revisionRequestId: prepared.revisionRequestId, revisedExecutionCoordinates: prepared.coordinates, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    }
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = PlanRevisionCommandSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_blocked", "delivery_ready", "delivery_reviewed", "repair_required"].includes(ctx.state.phase)) throw new Error("Plan revision is not available in the current phase");
  } });
}

export function registerPlanningHandlersReject(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.reject_plan, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (!(ctx.state.phase === "development" && ctx.state.developerExecutionId)) await ctx.cancelCurrentCapacity();
    if (ctx.state.phase === "development") {
      const cancellation = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId: ctx.state.developerExecutionId! });
      if (cancellation.status === "completed_before_cancellation") {
        if (!ctx.applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before plan revision.")) throw new Error("Completed Developer result is invalid");
        await ctx.project();
        return ctx.state;
      }
      if (cancellation.status !== "cancelled" && cancellation.status !== "cancelled_confirmed") {
        const summary = "summary" in cancellation ? cancellation.summary : "Developer ownership must be precisely cancelled before plan revision";
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: summary, ...ctx.recoveryFields("interrupted", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      if (ctx.state.capacity) await ctx.settleCancelledCapacity(ctx.state.developerExecutionId!);
    }
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, blocker: null, stateChangedAt: new Date().toISOString() });
    const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.revision - 1, actorUserId: command.actorUserId, decision: "reject", note: `${command.note ?? "Member requested an explicit plan revision"}; worktree=${command.worktreeDecision ?? "new"}; exactBase=${command.exactBaseSha ?? "recorded-current-base"}` });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, leadResumeInstructionArtifactId: decision.noteArtifactId ?? null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_blocked", "delivery_ready", "delivery_reviewed", "repair_required"].includes(ctx.state.phase)) throw new Error("Plan revision is not available in the current phase");
    if (!ctx.state.planMaterial) throw new Error("Routine plans do not require revision");
    if (ctx.state.phase === "development" && !ctx.state.developerExecutionId) throw new Error("Active Developer execution is unavailable for cancellation");
  } });
}
