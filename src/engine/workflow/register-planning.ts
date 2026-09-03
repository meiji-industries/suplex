import { at, isBlocked } from "../../issue-phases.js";
import { log, runExecution, setHandler, setInterruptHandler } from "../registry.js";

import { routeLeadResult } from "../../plan-governance.js";
import { plannerNoteAvailable } from "../../commands/definitions/planning.js";
import { assertPayloadWithinLimit } from "../policy.js";
import {
  IssueWorkflowStateSchema,
  PlanCommandInputSchema,
  PlanRevisionCommandSchema,
  SendPlannerNoteInputSchema,
  StartPlanningInputSchema,
  type IssueWorkflowState,
  type LeadPlanningResult,
  type PlanCommandInput,
  type SendPlannerNoteInput,
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
import { arbitrateReview } from "./register-delivery-review.js";
import { evidencePointer, humanBlocker } from "./state-transitions.js";
import type { IssueWorkflowContext } from "./context.js";

async function autoApprovePlan(ctx: IssueWorkflowContext, autoStart = true): Promise<void> {
  if (!ctx.input.autoApprovePlan || !ctx.input.autoApprovePlanActorUserId || ctx.state.step !== "approval") return;
  const planRevision = ctx.state.planRevision ?? ctx.state.revision;
  const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, artifactId: ctx.state.leadOutputArtifactId!, actorUserId: ctx.input.autoApprovePlanActorUserId, decision: "approve", note: "Plan auto-approved when the task was created" });
  ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ["start_development", "request_plan_revision", "cancel_issue"], pendingAction: "Start the build", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, decisionId: decision.decisionId, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: ctx.input.autoApprovePlanActorUserId, blocker: null, stateChangedAt: new Date().toISOString(), planDecisionReceipt: { decisionId: decision.decisionId, decision: "approve" } });
  // Auto-approve means "run to completion without me": start the Developer turn here instead of parking on a human click.
  if (!autoStart || ctx.state.step !== "ready_for_development" || !ctx.state.allowedCommands.includes("start_development")) return;
  // Project the landing revision first: chaining straight into the Developer turn would
  // otherwise leave a gap the timeline and the task view never see.
  await ctx.project();
  await startDevelopment(ctx,{ expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-start-development:${ctx.state.revision}`, actorUserId: ctx.input.autoApprovePlanActorUserId });
}

async function runPlanReview(ctx: IssueWorkflowContext, plan: LeadPlanningResult): Promise<LeadPlanningResult> {
  // Keep completed histories on their recorded sequence. New tasks place the
  // trusted Reviewer immediately after every Planner turn.
  const reviewFailure = (reason: string): LeadPlanningResult => {
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, lastHandlerError: { command: "supplemental_review", reason, at: new Date().toISOString() } });
    return plan;
  };
  if (!ctx.input.supplementalReview || plan.leadOutputKind !== "plan") return plan;
  if (!ctx.input.roleProfiles.reviewer) return reviewFailure("Second review was requested, but no Reviewer profile is assigned.");
  if (!ctx.state.leadOutputArtifactId || !ctx.state.leadEvidenceArtifactId) return reviewFailure("Second review could not start because the Planner output or evidence is unavailable.");
  try {
    const review = await ctx.acquireExternalTurn<import("../issue-contracts.js").SupplementalReviewResult>(
      { operation: "supplemental_review", role: "reviewer", profileId: ctx.input.roleProfiles.reviewer },
      (capacityRequestId) => agentActivities(true).runSupplementalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.planRevision ?? ctx.state.revision, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadEvidenceArtifactId: ctx.state.leadEvidenceArtifactId!, ...(ctx.state.leadSessionRef ? { primaryLeadSessionRef: ctx.state.leadSessionRef } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.executionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, ...(ctx.state.lastHandlerError?.command === "supplemental_review" ? { lastHandlerError: null } : {}) });
    if (review.verdict !== "revise" || !review.concerns?.some((concern) => concern.severity === "blocking") || !ctx.state.leadSessionRef) return plan;
    const revised = await ctx.acquireExternalTurn<LeadPlanningResult>(
      { operation: "lead_consolidation", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
      (capacityRequestId) => agentActivities(true).consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.leadExecutionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...revised, leadReviewResponseArtifactId: revised.leadReviewResponseArtifactId ?? null });
    return revised;
  } catch (error) {
    // A missing second opinion must never hold up a plan.
    const failure = ctx.permanentActivityFailure(error, true);
    return reviewFailure(`Second review did not finish: ${failure?.summary ?? "The reviewer could not be started."}`);
  }
}

export function registerPlanningHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.start_planning, ctx.guarded(async (rawInput: any) => {
    await ctx.initialProjection;
    assertPayloadWithinLimit("startPlanning command", rawInput);
    const input = StartPlanningInputSchema.parse(rawInput);
    if (ctx.state.revision !== input.expectedRevision || !ctx.state.allowedCommands.includes("start_planning")) throw new Error("Stale workflow revision");
    const next = IssueWorkflowStateSchema.parse({
      ...ctx.state,
      ...at("planning"),
      revision: ctx.state.revision + 1,
      owner: "lead",
      allowedCommands: ctx.continueAfter > 0 ? ["record_progress"] : [],
      pendingAction: "The Planner writes the plan",
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
    if (planningProjection.shouldProject) await ctx.projectInitialPlanningState(next);
    if (ctx.state.step !== "planning" || ctx.state.revision !== next.revision) return ctx.state;
    {
      let leadResult;
      try {
        const runPlanningTurn = () => ctx.acquireExternalTurn<LeadPlanningResult>(
          { operation: "lead_planning", role: "planner", profileId: ctx.input.roleProfiles.planner },
          (capacityRequestId) => agentActivities(true).runLeadPlanning({
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
          true,
        );
        leadResult = await runPlanningTurn();
      } catch (error) {
        if (ctx.currentState().step === "cancelled") return ctx.currentState();
        if (ctx.state.capacityBlocker) return ctx.state;
        // A cancel (e.g. archive) that lands while the Lead turn is running must not be overwritten by the turn's failure.
        if (["cancelled", "done"].includes(ctx.state.phase as string)) return ctx.state;
        const failure = ctx.permanentActivityFailure(error, true);
        if (!failure) throw error;
        const unreadablePlannerResult = failure.code === "invalid-output-schema" || failure.code === "awaiting_human";
        const summary = unreadablePlannerResult ? "Planner's result was not readable" : failure.code === "activity-failed" ? "Planning failed; retry is available" : failure.summary;
        const failureBase = ctx.state;
        const failureRevision = failureBase.revision + 1;
        const capacityFailure = ["not-found", "not-owner", "duplicate", "conflict", "stale-revision", "profile-unavailable", "invalid-status", "deadline-exhausted"].includes(failure.code);
        const resumeTurn = ["turn_outcome_missing", "turn_stalled"].includes(failure.code);
        const startupBlocked = failure.code === "agent_startup_blocked";
        ctx.state = IssueWorkflowStateSchema.parse({
          ...failureBase,
          capacity: null,
          capacityBlocker: null,
          ...at(capacityFailure ? "backlog" : "planning"),
          revision: failureRevision,
          owner: "human",
          allowedCommands: unreadablePlannerResult || resumeTurn ? ["start_planning", "cancel_issue"] : capacityFailure ? ["start_planning", "cancel_issue"] : ["start_planning", "continue_work", "cancel_issue"],
          pendingAction: unreadablePlannerResult ? summary : resumeTurn ? "Resume the Planner turn" : capacityFailure ? `${summary} Retry planning.` : summary,
          lastHandlerError: { command: "start_planning", reason: failure.summary, at: new Date().toISOString() },
          blocker: unreadablePlannerResult ? humanBlocker("agent_exhausted", summary, [{ command: "start_planning", label: "Start planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : startupBlocked ? humanBlocker("member_authorization", summary, [{ command: "start_planning", label: "Start planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : resumeTurn ? humanBlocker("agent_exhausted", summary, [{ command: "start_planning", label: "Start planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : failure.category ? humanBlocker(failure.category, summary, [{ command: "start_planning", label: "Start planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : null,
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${ctx.state.workflowId}:${failureRevision}`,
        });
        await ctx.project();
        return ctx.state;
      }
      // A Lead result that lands after cancel_issue must not resurrect the issue: simple capacity
      // (forge-simple-capacity-v1) runs the turn without the durable stale-turn check.
      if (ctx.currentState().step === "cancelled") return ctx.currentState();
      let planningBase = ctx.state;
      const queuedNotes = ctx.state.pendingPlannerNotes ?? [];
      if (queuedNotes.length && leadResult.leadSessionRef) {
        planningBase = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("planning"), owner: "lead", allowedCommands: [], pendingAction: "The Planner applies your note", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, pendingPlannerNotes: [] });
        ctx.state = planningBase;
        await ctx.project();
        leadResult = await agentActivities(true).runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: planningBase.revision, leadSessionRef: leadResult.leadSessionRef, operatorNotes: queuedNotes });
      }
      {
        ctx.state = IssueWorkflowStateSchema.parse({ ...planningBase, ...leadResult, ...(distinctPlanningStates ? { revision: planningBase.revision + 1, lastEventId: `${planningBase.workflowId}:${planningBase.revision + 1}` } : {}), planRevision: next.revision, preservedWorktreeCompatibility: leadResult.preservedWorktreeCompatibility ?? null, supplementalReviewUsed: false, blocker: null, stateChangedAt: new Date().toISOString(), planBlockerSubject: leadResult.blockerSubject ?? null });
      }
      if (ctx.state.revisionRequestId && ctx.state.revisedExecutionCoordinates?.disposition === "reuse" && ctx.state.preservedWorktreeCompatibility !== true) {
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...at("development"), owner: "human", allowedCommands: ["revise_plan", "cancel_issue"], pendingAction: "Select a new worktree for the revised plan", blockerCode: "preserved-worktree-incompatible" });
        await ctx.project();
        return ctx.state;
      }
      if (ctx.state.revisionRequestId) await authorizePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revisionRequestId: ctx.state.revisionRequestId, planRevision: ctx.state.planRevision ?? ctx.state.revision });
      leadResult = await runPlanReview(ctx, leadResult);
      const route = routeLeadResult({ kind: leadResult.leadOutputKind }, { supplementalReview: ctx.input.supplementalReview, reviewerConfigured: Boolean(ctx.input.roleProfiles.reviewer) });
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...at(route.step), owner: route.owner, allowedCommands: route.allowedCommands, pendingAction: route.pendingAction, blocker: route.step === "planning" ? humanBlocker("member_decision", "Your decision is necessary", [{ command: "resolve_decision_blocker", label: "Resolve the decision", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(leadResult.leadOutputArtifactId, "decision-blocker")) : null, stateChangedAt: new Date().toISOString() });
      await autoApprovePlan(ctx);
      assertPayloadWithinLimit("Issue Workflow result", ctx.state);
      await ctx.project();
    }
    return ctx.state;
  }), {
    validator(rawInput) {
      const command = StartPlanningInputSchema.parse(rawInput);
      if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
      if (ctx.state.step !== "backlog" && ctx.state.step !== "planning" && !isBlocked(ctx.state) && !(isBlocked(ctx.state) && ctx.state.blockedCategory !== "human_decision")) throw new Error("Planning can only start from Backlog, Planning, Failed, or an operator-correctable blocked state");
    },
  });
}

export function registerPlanningHandlersContinuation(ctx: IssueWorkflowContext): void {
  const validatePlanCommand = (rawInput: PlanCommandInput): PlanCommandInput => {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.step !== "approval") throw new Error("Plan command is not available in the current phase");
    return command;
  };
  const executeLeadTurn = async (leadSessionRef?: string, revisionNote?: { artifactId: string }, memberResponse?: { artifactId: string }, operatorNotes?: string[], resumeDevelopment = false): Promise<IssueWorkflowState> => {
    const leadResult = await agentActivities(true).runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, ...(leadSessionRef ? { leadSessionRef } : {}), ...(revisionNote ? { revisionNoteArtifactId: revisionNote.artifactId } : {}), ...(memberResponse ? { memberResponseArtifactId: memberResponse.artifactId } : {}), ...(operatorNotes?.length ? { operatorNotes } : {}) });
    if (true && ctx.currentState().step === "cancelled") return ctx.currentState();
    const acceptedRevision = ctx.state.revision + 1;
    const route = routeLeadResult({ kind: leadResult.leadOutputKind }, { supplementalReview: ctx.input.supplementalReview, reviewerConfigured: Boolean(ctx.input.roleProfiles.reviewer) });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...leadResult, revision: acceptedRevision, ...at(route.step), owner: route.owner, allowedCommands: route.allowedCommands, pendingAction: route.pendingAction, blocker: route.step === "planning" ? humanBlocker("member_decision", "Your decision is necessary", [{ command: "resolve_decision_blocker", label: "Resolve the decision", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(leadResult.leadOutputArtifactId, "decision-blocker")) : null, lastEventId: `${ctx.state.workflowId}:${acceptedRevision}`, planRevision: ctx.state.revision, supplementalReviewUsed: false, planBlockerSubject: leadResult.blockerSubject ?? null });
    await autoApprovePlan(ctx, !resumeDevelopment);
    await ctx.project();
    return ctx.state;
  };

  setHandler(issueUpdates.request_supplemental_review, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("supplemental review command", rawInput);
    const command = validatePlanCommand(rawInput);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...at("supplemental_review"), owner: "lead", allowedCommands: [], revision: ctx.state.revision + 1, pendingAction: "The second review is in progress", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    const review = await ctx.acquireExternalTurn<import("../issue-contracts.js").SupplementalReviewResult>(
      { operation: "supplemental_review", role: "reviewer", profileId: ctx.input.roleProfiles.reviewer },
      (capacityRequestId) => agentActivities(true).runSupplementalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.planRevision ?? ctx.state.revision, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadEvidenceArtifactId: ctx.state.leadEvidenceArtifactId!, ...(ctx.state.leadSessionRef ? { primaryLeadSessionRef: ctx.state.leadSessionRef } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.executionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...at("plan_consolidation"), owner: "lead", allowedCommands: [], revision: ctx.state.revision + 1, pendingAction: "The Planner consolidates the plan", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId });
    await ctx.project();
    const consolidated = await ctx.acquireExternalTurn<LeadPlanningResult>(
      { operation: "lead_consolidation", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
      (capacityRequestId) => agentActivities(true).consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.leadExecutionId,
    );
    const route = routeLeadResult({ kind: consolidated.leadOutputKind }, { supplementalReview: false, reviewerConfigured: false });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...consolidated, revision: ctx.state.revision + 1, ...at(route.step), owner: route.owner, allowedCommands: route.allowedCommands, pendingAction: route.pendingAction, blocker: route.step === "planning" ? humanBlocker("member_decision", "Your decision is necessary", [{ command: "resolve_decision_blocker", label: "Resolve the decision", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(consolidated.leadOutputArtifactId, "decision-blocker")) : null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planBlockerSubject: consolidated.blockerSubject ?? null, planRevision: ctx.state.planRevision ?? ctx.state.revision });
    await autoApprovePlan(ctx);
    await ctx.project();
    void command;
    return ctx.state;
  }), { validator(rawInput) {
    validatePlanCommand(rawInput);
    if (!ctx.input.supplementalReview || ctx.state.supplementalReviewUsed) throw new Error("Supplemental review is not available");
    if (!ctx.state.leadOutputArtifactId || !ctx.state.leadSessionRef) throw new Error("A Lead plan is required before supplemental review");
    if (!ctx.input.roleProfiles.reviewer) throw new Error("A supplemental reviewer profile is required");
  } });

  setHandler(issueUpdates.approve_plan, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan approval command", rawInput);
    const command = validatePlanCommand(rawInput);
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const planRevision = ctx.state.planRevision ?? ctx.state.revision;
      if (ctx.state.revisionRequestId) await authorizePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revisionRequestId: ctx.state.revisionRequestId, planRevision });
      const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, artifactId: ctx.state.leadOutputArtifactId!, actorUserId: command.actorUserId, decision: "approve", ...(command.note !== undefined ? { note: command.note } : {}), ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}) });
      const plannerNote = ctx.state.developerExecutionId ? ctx.state.pendingPlannerNotes?.at(-1) : undefined;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ready_for_development"), owner: "lead", allowedCommands: ["start_development", "request_plan_revision", "cancel_issue"], pendingAction: "Start the build", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, decisionId: decision.decisionId, planApproved: true, planApprovedAt: new Date().toISOString(), planApprovedBy: command.actorUserId, blocker: null, stateChangedAt: new Date().toISOString(), pendingPlannerNotes: [], planDecisionReceipt: { decisionId: decision.decisionId, decision: "approve" } });
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      await ctx.project();
      if (ctx.state.developerExecutionId) return await retryDevelopment(ctx, { expectedRevision: ctx.state.revision, actorUserId: command.actorUserId, commandId: `${command.commandId}:resume` }, plannerNote);
      return ctx.state;
    } finally { ctx.decisionInFlight = false; }
  }, "approve_plan"), { validator(rawInput) { validatePlanCommand(rawInput); } });

  setHandler(issueUpdates.request_plan_revision, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("exact plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.step !== "approval" && ctx.state.step !== "ready_for_development") throw new Error("Plan revision is not available in the current phase");
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const previousRevision = ctx.state.revision;
      const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.planRevision ?? ctx.state.revision, artifactId: ctx.state.leadOutputArtifactId!, actorUserId: command.actorUserId, decision: "request_revision", ...(command.note !== undefined ? { note: command.note } : {}) });
      const primaryLeadSessionRef = ctx.state.leadSessionRef;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: previousRevision + 1, ...at("planning"), owner: "lead", allowedCommands: ["start_planning"], pendingAction: "The Planner revises the plan", lastEventId: `${ctx.state.workflowId}:${previousRevision + 1}`, planRevision: null, supplementalReviewUsed: false, supplementalReviewArtifactId: null, planDecisionReceipt: { decisionId: decision.decisionId, decision: "request_revision" }, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
      await ctx.project();
      return await executeLeadTurn(primaryLeadSessionRef ?? undefined, decision.noteArtifactId ? { artifactId: decision.noteArtifactId } : undefined);
    } finally { ctx.decisionInFlight = false; }
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.step !== "approval" && ctx.state.step !== "ready_for_development") throw new Error("Plan revision is not available in the current phase");
  } });

  setHandler(issueUpdates.respond_plan_blocker, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan blocker response command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || command.expectedWorkflowRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!isBlocked(ctx.state) || !ctx.state.planBlockerSubject) throw new Error("Plan blocker response is not available in the current phase");
    if (!command.answerStagingRef || !command.idempotencyKey) throw new Error("A required blocker answer and idempotency key are required");
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const response = await recordPlanBlockerResponse({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, blockerArtifactId: ctx.state.planBlockerSubject.artifactId, expectedWorkflowRevision: command.expectedWorkflowRevision, answerStagingRef: command.answerStagingRef, idempotencyKey: command.idempotencyKey });
      const primaryLeadSessionRef = ctx.state.planBlockerSubject.leadSessionRef;
      if (ctx.state.step === "review_arbitration" || ctx.state.planBlockerSubject.resumePhase === "review_arbitration") {
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("review_arbitration"), owner: "lead", allowedCommands: ["arbitrate_review", "cancel_issue"], pendingAction: "The Planner decides how to resolve the review", repairCycle: 0, planBlockerSubject: null, planBlockerResponseReceipt: { idempotencyKey: command.idempotencyKey, responseId: response.responseId }, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return await arbitrateReview(ctx, { expectedRevision: ctx.state.revision, actorUserId: command.actorUserId, commandId: `${command.commandId}:arbitration` }, response.answerArtifactId);
      }
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("planning"), owner: "lead", allowedCommands: ["start_planning"], pendingAction: "The Planner revises the plan with your answer", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, planBlockerSubject: null, planBlockerResponseReceipt: { idempotencyKey: command.idempotencyKey, responseId: response.responseId }, supplementalReviewUsed: false, supplementalReviewArtifactId: null });
      await ctx.project();
      if (!response.answerArtifactId) log.warn("Plan blocker response has no answer artifact", { workflowId: ctx.input.workflowId, responseId: response.responseId });
      return await executeLeadTurn(primaryLeadSessionRef, undefined, response.answerArtifactId ? { artifactId: response.answerArtifactId } : undefined);
    } finally { ctx.decisionInFlight = false; }
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || command.expectedWorkflowRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!isBlocked(ctx.state) || !ctx.state.planBlockerSubject) throw new Error("Plan blocker response is not available in the current phase");
  } });

  const validatePlannerNote = (rawInput: unknown): boolean => {
    const command = SendPlannerNoteInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return false;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!plannerNoteAvailable(ctx.state.phase, ctx.state.successorTaskId)) throw new Error("Planner feedback is not available after the task has ended");
    return true;
  };
  const recordNote = (command: SendPlannerNoteInput) => recordPlannerNote({
    taskId: ctx.input.issueId,
    companyId: ctx.input.companyId,
    workflowId: ctx.input.workflowId,
    revision: command.expectedRevision,
    actorUserId: command.actorUserId,
    commandId: command.commandId,
    ...("noteId" in command ? { noteId: command.noteId, noteSha256: command.noteSha256 } : { note: command.note }),
  });
  setInterruptHandler(issueUpdates.send_planner_note, {
    validate: validatePlannerNote,
    run: (rawInput: unknown) => recordNote(SendPlannerNoteInputSchema.parse(rawInput)),
  });

  setHandler(issueUpdates.send_planner_note, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("tell Planner command", rawInput);
    const command = SendPlannerNoteInputSchema.parse(rawInput);
    if (ctx.commandAlreadyProcessed(command.commandId)) return ctx.state;
    if (runExecution.current().acceptedInterrupt !== issueUpdates.send_planner_note) await recordNote(command);
    ctx.markCommandProcessed(command.commandId);
    if (true && isBlocked(ctx.state) && ctx.state.mergeDecision) {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Forge applies your decision", mergeResolutionPlanArtifactId: null, mergeDecision: null, pendingPlannerNotes: "note" in command ? [command.note] : [], blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return resolveMergeConflict(ctx, { expectedRevision: ctx.state.revision, actorUserId: command.actorUserId, commandId: `${ctx.state.workflowId}:decision-resolve:${ctx.state.revision}` });
    }
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  }, "send_planner_note"), { validator(rawInput) {
    validatePlannerNote(rawInput);
  } });
}

export function registerPlanningHandlersRevision(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.revise_plan, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanRevisionCommandSchema.parse(rawInput);
    if (ctx.state.step === "development") {
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
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ctx.addRevisionCommand(["retry_development", "cancel_issue"]), pendingAction: summary, ...ctx.recoveryFields("interrupted", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
    }
    const prepared = await preparePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, requestRevision: ctx.state.revision, actorUserId: command.actorUserId, reason: command.reason, worktreeDisposition: command.worktreeDisposition, ...(command.worktreeDisposition === "new" ? { exactBaseSha: command.exactBaseSha } : {}), ...(ctx.state.developerExecutionId ? { developerExecutionId: ctx.state.developerExecutionId } : {}) });
    if (prepared.status === "blocked") {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ctx.addRevisionCommand(["revise_plan", "cancel_issue"]), pendingAction: "The plan revision is blocked", blocker: humanBlocker("unsafe_recovery", "The plan revision is blocked", [{ command: "revise_plan", label: "Revise the plan", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(undefined, "attention-evidence")), blockerCode: prepared.blockerCode, revisionRequestId: prepared.revisionRequestId, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } else {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("planning"), owner: "lead", allowedCommands: ["start_planning"], pendingAction: "The Planner revises the plan", blockerCode: null, revisionRequestId: prepared.revisionRequestId, revisedExecutionCoordinates: prepared.coordinates, planRevision: null, supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    }
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = PlanRevisionCommandSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_ready", "delivery_reviewed", "repair_required"].includes(ctx.state.step)) throw new Error("Plan revision is not available in the current phase");
  } });
}

export function registerPlanningHandlersReject(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.reject_plan, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (!(ctx.state.step === "development" && ctx.state.developerExecutionId)) await ctx.cancelCurrentCapacity();
    if (ctx.state.step === "development") {
      const cancellation = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId: ctx.state.developerExecutionId! });
      if (cancellation.status === "completed_before_cancellation") {
        if (!ctx.applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before plan revision.")) throw new Error("Completed Developer result is invalid");
        await ctx.project();
        return ctx.state;
      }
      if (cancellation.status !== "cancelled" && cancellation.status !== "cancelled_confirmed") {
        const summary = "summary" in cancellation ? cancellation.summary : "Developer ownership must be precisely cancelled before plan revision";
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: summary, ...ctx.recoveryFields("interrupted", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      if (ctx.state.capacity) await ctx.settleCancelledCapacity(ctx.state.developerExecutionId!);
    }
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("planning"), owner: "lead", allowedCommands: ["start_planning"], pendingAction: "The Planner revises the plan", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, supplementalReviewUsed: false, supplementalReviewArtifactId: null, blocker: null, stateChangedAt: new Date().toISOString() });
    const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.revision - 1, artifactId: ctx.state.leadOutputArtifactId!, actorUserId: command.actorUserId, decision: "reject", note: `${command.note ?? "Member requested an explicit plan revision"}; worktree=${command.worktreeDecision ?? "new"}; exactBase=${command.exactBaseSha ?? "recorded-current-base"}` });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, leadResumeInstructionArtifactId: decision.noteArtifactId ?? null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!["approval", "development", "delivery_ready", "delivery_reviewed", "repair_required"].includes(ctx.state.step)) throw new Error("Plan revision is not available in the current phase");
    if (ctx.state.step === "development" && !ctx.state.developerExecutionId) throw new Error("The active build is unavailable for cancellation");
  } });
}
