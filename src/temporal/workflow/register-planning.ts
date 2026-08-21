import { CancellationScope, condition, setHandler } from "@temporalio/workflow";

import { routeLeadResult } from "../../plan-governance.js";
import { assertPayloadWithinLimit } from "../policy.js";
import {
  IssueWorkflowStateSchema,
  PlanCommandInputSchema,
  PlanRevisionCommandSchema,
  StartPlanningInputSchema,
  type IssueCommand,
  type IssueWorkflowState,
  type LeadPlanningResult,
  type PlanCommandInput,
} from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import {
  authorizeFinalPlan,
  authorizePlanRevision,
  cancelDeveloperExecution,
  consolidateLeadPlan,
  recordPlanBlockerResponse,
  recordPlanDecision,
  findActiveDeveloperExecution,
  preparePlanRevision,
  runLeadPlanning,
  runSupplementalReview,
} from "./activity-proxies.js";
import { startDevelopment } from "./register-development.js";
import { evidencePointer, humanBlocker } from "./state-transitions.js";
import type { IssueWorkflowContext } from "./context.js";

async function autoApprovePlan(ctx: IssueWorkflowContext): Promise<void> {
  if (!ctx.input.autoApprovePlan || !ctx.input.autoApprovePlanActorUserId || ctx.state.phase !== "approval" || !ctx.state.planMaterial) return;
  const subject = ctx.state.finalPlanSubject && ctx.state.materialityEvidence ? { plan: ctx.state.finalPlanSubject, materiality: ctx.state.materialityEvidence, expectedWorkflowRevision: ctx.state.revision } : undefined;
  const planRevision = subject?.plan.outputRevision ?? ctx.state.planRevision ?? ctx.state.revision;
  const autoApprovalKey = subject ? `auto-approve:${subject.plan.artifactId}` : undefined;
  const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, actorUserId: ctx.input.autoApprovePlanActorUserId, decision: "approve", ...(subject ? { subject } : {}), note: "Plan auto-approved when the task was created", ...(autoApprovalKey ? { idempotencyKey: autoApprovalKey } : {}) });
  // Routine plans are already operator-authorized by task creation.  Do not
  // manufacture a human approval dependency that can later conflict with a
  // regenerated plan artifact.
  const authorization = ctx.isolatedDeveloperExecutionEnabled && subject ? await authorizeFinalPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision, planArtifactId: subject.plan.artifactId, authorizationKind: "routine_auto" }) : undefined;
  ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.state.finalPlanSubject ? ["start_development", "request_plan_revision", "cancel_issue"] : ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, decisionId: decision.decisionId, ...(authorization ? { planRevision: authorization.planRevision, planAuthorizationId: authorization.authorizationId, planAuthorizationKind: authorization.authorizationKind, planAuthorizedAt: authorization.authorizedAt } : {}), blocker: null, stateChangedAt: new Date().toISOString(), ...(subject && autoApprovalKey ? { planDecisionReceipt: { idempotencyKey: autoApprovalKey, decisionId: decision.decisionId, decision: "approve" as const, subjectHash: subject.plan.artifactId } } : {}) });
  // Auto-approve means "run to completion without me": start the Developer turn here instead of parking on a human click.
  if (!ctx.patched("forge-auto-start-development-v1") || ctx.state.phase !== "ready_for_development" || !ctx.state.allowedCommands.includes("start_development")) return;
  // Project the landing revision first: chaining straight into the Developer turn would
  // otherwise leave a gap the timeline and the task view never see.
  if (ctx.patched("forge-auto-chain-lead-phases-v1")) await ctx.project();
  await startDevelopment(ctx,{ expectedRevision: ctx.state.revision, commandId: `${ctx.state.workflowId}:auto-start-development:${ctx.state.revision}`, actorUserId: ctx.input.autoApprovePlanActorUserId });
}

export function registerPlanningHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.start_planning, ctx.guarded(async (rawInput) => {
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
          (capacityRequestId) => runLeadPlanning({
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
        const failure = ctx.permanentActivityFailure(error, ctx.patched(ctx.exhaustedActivityRecoveryPatch));
        if (!failure) throw error;
        const summary = failure.code === "activity-failed" ? "Planning failed; retry is available" : failure.summary;
        const failureBase = durablePlanningCapacity ? ctx.state : next;
        const failureRevision = failureBase.revision + 1;
        const capacityFailure = ["not-found", "not-owner", "duplicate", "conflict", "stale-revision", "profile-unavailable", "invalid-status", "deadline-exhausted"].includes(failure.code);
        ctx.state = IssueWorkflowStateSchema.parse({
          ...failureBase,
          capacity: null,
          capacityBlocker: null,
          phase: capacityFailure ? "backlog" : "failed",
          revision: failureRevision,
          owner: "human",
          allowedCommands: capacityFailure ? ["start_planning", "cancel_issue"] : ctx.reviseContinueEnabled ? ["start_planning", "continue_work", "cancel_issue"] : ["start_planning", "cancel_issue"],
          pendingAction: capacityFailure ? `${summary} Forge reconciled the capacity record; retry planning.` : summary,
          blocker: failure.category ? humanBlocker(failure.category, summary, [{ command: "start_planning", label: "Retry planning", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, failure.evidenceSha256, "attention-evidence")) : null,
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${ctx.state.workflowId}:${failureRevision}`,
        });
        await ctx.project();
        return ctx.state;
      }
      const planningBase = durablePlanningCapacity ? ctx.state : next;
      if (ctx.exactPlanAuthorityEnabled) {
        ctx.state = IssueWorkflowStateSchema.parse({ ...planningBase, ...leadResult, ...(distinctPlanningStates ? { revision: planningBase.revision + 1, lastEventId: `${planningBase.workflowId}:${planningBase.revision + 1}` } : {}), planRevision: next.revision, planMaterial: leadResult.material, materialCategories: leadResult.materialCategories, preservedWorktreeCompatibility: leadResult.preservedWorktreeCompatibility ?? null, supplementalReviewUsed: false, blocker: null, stateChangedAt: new Date().toISOString(), originalPlanSubject: leadResult.planSubject ?? null, finalPlanSubject: leadResult.planSubject ?? null, materialityEvidence: leadResult.materialityEvidence ?? null, planBlockerSubject: leadResult.blockerSubject ?? null });
      } else {
        const routedLeadResult = ctx.leadResultRoutingEnabled() ? ctx.applyLeadResult(next, leadResult) : ctx.applyLegacyLeadResult(next, leadResult);
        ctx.state = IssueWorkflowStateSchema.parse({ ...routedLeadResult, ...(distinctPlanningStates ? { revision: next.revision + 1, lastEventId: `${next.workflowId}:${next.revision + 1}` } : {}), ...(ctx.leadResultKind(leadResult) === "plan" ? { planRevision: next.revision } : {}), supplementalReviewUsed: false });
      }
      if (ctx.state.revisionRequestId && ctx.state.revisedExecutionCoordinates?.disposition === "reuse" && ctx.state.preservedWorktreeCompatibility !== true) {
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "delivery_blocked", owner: "human", allowedCommands: ["revise_plan", "cancel_issue"], pendingAction: "Choose a new exact-base worktree for the incompatible revised plan", blockerCode: "preserved-worktree-incompatible" });
        await ctx.project();
        return ctx.state;
      }
      if (ctx.state.revisionRequestId) await authorizePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revisionRequestId: ctx.state.revisionRequestId, planRevision: ctx.state.planRevision ?? ctx.state.revision });
      if (ctx.planGovernanceEnabled()) {
        const route = routeLeadResult({ kind: leadResult.leadOutputKind, material: leadResult.material });
        const exactSubject = Boolean(ctx.state.finalPlanSubject);
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: route.phase, owner: route.owner, allowedCommands: route.phase === "approval" ? ctx.approvalCommands(exactSubject, ctx.input.supplementalReview) : route.phase === "ready_for_development" && !exactSubject ? ctx.addRevisionCommand(route.allowedCommands as IssueCommand[]) : route.allowedCommands, pendingAction: route.pendingAction, blocker: route.phase === "approval" ? ctx.approvalBlocker(leadResult, exactSubject, ctx.input.supplementalReview) : null, stateChangedAt: new Date().toISOString() });
        if (ctx.isolatedDeveloperExecutionEnabled && route.phase === "ready_for_development" && ctx.state.finalPlanSubject) {
          const authorization = await authorizeFinalPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision: ctx.state.finalPlanSubject.outputRevision, planArtifactId: ctx.state.finalPlanSubject.artifactId, authorizationKind: "routine_auto" });
          ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, planRevision: authorization.planRevision, planAuthorizationId: authorization.authorizationId, planAuthorizationKind: authorization.authorizationKind, planAuthorizedAt: authorization.authorizedAt });
        }
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
  const executeLeadTurn = async (leadSessionRef?: string, revisionNote?: { artifactId: string; sha256: string }, memberResponse?: { artifactId: string; sha256: string }): Promise<IssueWorkflowState> => {
    const leadResult = await runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, ...(leadSessionRef ? { leadSessionRef } : {}), ...(revisionNote ? { revisionNoteArtifactId: revisionNote.artifactId, revisionNoteSha256: revisionNote.sha256 } : {}), ...(memberResponse ? { memberResponseArtifactId: memberResponse.artifactId, memberResponseSha256: memberResponse.sha256 } : {}) });
    const acceptedRevision = ctx.state.revision + 1;
    const route = routeLeadResult({ kind: leadResult.leadOutputKind, material: leadResult.material });
    const exactSubject = Boolean(leadResult.planSubject);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...leadResult, revision: acceptedRevision, phase: route.phase, owner: route.owner, allowedCommands: route.phase === "approval" ? ctx.approvalCommands(exactSubject, ctx.input.supplementalReview) : route.phase === "ready_for_development" && !exactSubject ? ctx.addRevisionCommand(route.allowedCommands as IssueCommand[]) : route.allowedCommands, pendingAction: route.pendingAction, blocker: route.phase === "approval" ? ctx.approvalBlocker(leadResult, exactSubject, ctx.input.supplementalReview) : null, lastEventId: `${ctx.state.workflowId}:${acceptedRevision}`, planRevision: ctx.state.revision, planMaterial: leadResult.material, materialCategories: leadResult.materialCategories, supplementalReviewUsed: false, originalPlanSubject: leadResult.planSubject ?? null, finalPlanSubject: leadResult.planSubject ?? null, materialityEvidence: leadResult.materialityEvidence ?? null, planBlockerSubject: leadResult.blockerSubject ?? null });
    if (ctx.isolatedDeveloperExecutionEnabled && route.phase === "ready_for_development" && ctx.state.finalPlanSubject) {
      const authorization = await authorizeFinalPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision: ctx.state.finalPlanSubject.outputRevision, planArtifactId: ctx.state.finalPlanSubject.artifactId, authorizationKind: "routine_auto" });
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, planRevision: authorization.planRevision, planAuthorizationId: authorization.authorizationId, planAuthorizationKind: authorization.authorizationKind, planAuthorizedAt: authorization.authorizedAt });
    }
    await autoApprovePlan(ctx);
    await ctx.project();
    return ctx.state;
  };

  setHandler(issueUpdates.request_supplemental_review, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("supplemental review command", rawInput);
    const command = validatePlanCommand(rawInput);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "supplemental_review", owner: "lead", allowedCommands: [], revision: ctx.state.revision + 1, pendingAction: "Independent supplemental review", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    const review = await ctx.acquireExternalTurn<import("../issue-contracts.js").SupplementalReviewResult>(
      { operation: "supplemental_review", role: "reviewer", profileId: ctx.input.roleProfiles.reviewer },
      (capacityRequestId) => runSupplementalReview({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.originalPlanSubject?.originalPlanRevision ?? ctx.state.planRevision ?? ctx.state.revision, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, leadEvidenceArtifactId: ctx.state.leadEvidenceArtifactId!, ...(ctx.state.originalPlanSubject ? { originalPlanSubject: ctx.state.originalPlanSubject, primaryLeadSessionRef: ctx.state.originalPlanSubject.leadSessionRef, evidenceManifestArtifactId: ctx.state.originalPlanSubject.evidenceManifestArtifactId, evidenceManifestSha256: ctx.state.originalPlanSubject.evidenceManifestSha256 } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.executionId,
    );
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "plan_consolidation", owner: "lead", allowedCommands: [], revision: ctx.state.revision + 1, pendingAction: "Lead consolidation", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, supplementalReviewUsed: true, supplementalReviewArtifactId: review.reviewArtifactId, supplementalReviewSubject: review.subject ?? null, supplementalReviewArtifactSha256: review.reviewArtifactSha256 ?? null });
    await ctx.project();
    const consolidated = await ctx.acquireExternalTurn<LeadPlanningResult>(
      { operation: "lead_consolidation", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: ctx.state.leadSessionRef },
      (capacityRequestId) => consolidateLeadPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: ctx.state.revision, leadSessionRef: ctx.state.leadSessionRef!, leadOutputArtifactId: ctx.state.leadOutputArtifactId!, supplementalReviewArtifactId: review.reviewArtifactId, ...(ctx.state.originalPlanSubject ? { originalPlanSubject: ctx.state.originalPlanSubject, evidenceManifestArtifactId: ctx.state.originalPlanSubject.evidenceManifestArtifactId, evidenceManifestSha256: ctx.state.originalPlanSubject.evidenceManifestSha256 } : {}), ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (result) => result.leadExecutionId,
    );
    const route = routeLeadResult({ kind: consolidated.leadOutputKind, material: consolidated.material });
    const exactSubject = Boolean(consolidated.planSubject);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...consolidated, revision: ctx.state.revision + 1, phase: route.phase, owner: route.owner, allowedCommands: route.phase === "approval" ? ctx.approvalCommands(exactSubject, false) : route.phase === "ready_for_development" && !exactSubject ? ctx.addRevisionCommand(route.allowedCommands as IssueCommand[]) : route.allowedCommands, pendingAction: route.pendingAction, blocker: route.phase === "approval" ? ctx.approvalBlocker(consolidated, exactSubject, false) : null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, finalPlanSubject: consolidated.planSubject ?? null, originalPlanSubject: ctx.state.originalPlanSubject, materialityEvidence: consolidated.materialityEvidence ?? null, planBlockerSubject: consolidated.blockerSubject ?? null, planMaterial: consolidated.material, materialCategories: consolidated.materialCategories, planRevision: ctx.state.planRevision ?? ctx.state.revision });
    if (ctx.isolatedDeveloperExecutionEnabled && route.phase === "ready_for_development" && ctx.state.finalPlanSubject) {
      const authorization = await authorizeFinalPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision: ctx.state.finalPlanSubject.outputRevision, planArtifactId: ctx.state.finalPlanSubject.artifactId, authorizationKind: "routine_auto" });
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, planRevision: authorization.planRevision, planAuthorizationId: authorization.authorizationId, planAuthorizationKind: authorization.authorizationKind, planAuthorizedAt: authorization.authorizedAt });
    }
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

  setHandler(issueUpdates.approve_plan, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("plan approval command", rawInput);
    const command = validatePlanCommand(rawInput);
    const decisionSubject = ctx.state.finalPlanSubject && ctx.state.materialityEvidence ? { plan: ctx.state.finalPlanSubject, materiality: ctx.state.materialityEvidence, expectedWorkflowRevision: command.expectedRevision } : undefined;
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const planRevision = ctx.state.planRevision ?? ctx.state.revision;
      if (ctx.state.revisionRequestId) await authorizePlanRevision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, revisionRequestId: ctx.state.revisionRequestId, planRevision });
      const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision, actorUserId: command.actorUserId, decision: "approve", ...(command.note !== undefined ? { note: command.note } : {}), ...(decisionSubject ? { subject: decisionSubject } : {}), ...(command.noteStagingRef ? { noteStagingRef: command.noteStagingRef } : {}), ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}), ...(ctx.state.revisionRequestId ? { revisionRequestId: ctx.state.revisionRequestId } : {}) });
      const authorization = ctx.isolatedDeveloperExecutionEnabled && ctx.state.finalPlanSubject ? await authorizeFinalPlan({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, projectId: ctx.input.projectId, workflowId: ctx.input.workflowId, planRevision: ctx.state.finalPlanSubject.outputRevision, planArtifactId: ctx.state.finalPlanSubject.artifactId, authorizationKind: "human_approval", approvalDecisionId: decision.decisionId }) : undefined;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ctx.state.planMaterial && ctx.state.finalPlanSubject ? ["start_development", "request_plan_revision", "cancel_issue"] : ctx.addRevisionCommand(["start_development", "cancel_issue"]), pendingAction: "Start development", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, decisionId: decision.decisionId, ...(authorization ? { planRevision: authorization.planRevision, planAuthorizationId: authorization.authorizationId, planArtifactSha256: authorization.planArtifactSha256, planAuthorizationKind: authorization.authorizationKind, planAuthorizedAt: authorization.authorizedAt } : {}), blocker: null, stateChangedAt: new Date().toISOString(), ...(command.idempotencyKey ? { planDecisionReceipt: { idempotencyKey: command.idempotencyKey, decisionId: decision.decisionId, decision: "approve" as const, subjectHash: decision.noteArtifactSha256 ?? "0".repeat(64) } } : {}) });
      if (ctx.shouldContinueAsNew(ctx.state.revision)) ctx.continuationRequested = true;
      await ctx.project();
      return ctx.state;
    } finally { ctx.decisionInFlight = false; }
  }, "approve_plan"), { validator(rawInput) { validatePlanCommand(rawInput); if (!ctx.state.planMaterial) throw new Error("Routine plans do not require approval"); } });

  setHandler(issueUpdates.request_plan_revision, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("exact plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if ((ctx.state.phase !== "approval" && ctx.state.phase !== "ready_for_development") || !ctx.state.planMaterial || !ctx.state.finalPlanSubject) throw new Error("Exact plan revision is not available in the current phase");
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    const decisionSubject = ctx.state.materialityEvidence ? { plan: ctx.state.finalPlanSubject, materiality: ctx.state.materialityEvidence, expectedWorkflowRevision: command.expectedRevision } : undefined;
    if (!command.idempotencyKey || !command.noteStagingRef || !command.noteSha256) throw new Error("A required revision note and idempotency key are required");
    ctx.decisionInFlight = true;
    try {
      const previousRevision = ctx.state.revision;
      const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.finalPlanSubject.outputRevision, actorUserId: command.actorUserId, decision: "request_revision", ...(decisionSubject ? { subject: decisionSubject } : {}), noteStagingRef: command.noteStagingRef, noteSha256: command.noteSha256, idempotencyKey: command.idempotencyKey });
      const primaryLeadSessionRef = ctx.state.finalPlanSubject.leadSessionRef;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: previousRevision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${ctx.state.workflowId}:${previousRevision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: decision.decisionId, originalPlanSubject: null, finalPlanSubject: null, materialityEvidence: null, planDecisionReceipt: { idempotencyKey: command.idempotencyKey, decisionId: decision.decisionId, decision: "request_revision" as const, subjectHash: decision.noteArtifactSha256 ?? "0".repeat(64) }, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
      await ctx.project();
      return await executeLeadTurn(primaryLeadSessionRef, decision.noteArtifactId && decision.noteArtifactSha256 ? { artifactId: decision.noteArtifactId, sha256: decision.noteArtifactSha256 } : undefined);
    } finally { ctx.decisionInFlight = false; }
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if ((ctx.state.phase !== "approval" && ctx.state.phase !== "ready_for_development") || !ctx.state.planMaterial || !ctx.state.finalPlanSubject) throw new Error("Exact plan revision is not available in the current phase");
  } });

  setHandler(issueUpdates.respond_plan_blocker, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("plan blocker response command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || command.expectedWorkflowRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "blocked" || !ctx.state.planBlockerSubject) throw new Error("Plan blocker response is not available in the current phase");
    if (!command.answerStagingRef || !command.answerSha256 || !command.idempotencyKey) throw new Error("A required blocker answer and idempotency key are required");
    if (ctx.decisionInFlight) throw new Error("A plan decision is already being processed");
    ctx.decisionInFlight = true;
    try {
      const response = await recordPlanBlockerResponse({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, blockerArtifactId: ctx.state.planBlockerSubject.artifactId, blockerArtifactSha256: ctx.state.planBlockerSubject.artifactSha256, expectedWorkflowRevision: command.expectedWorkflowRevision, answerStagingRef: command.answerStagingRef, answerSha256: command.answerSha256, idempotencyKey: command.idempotencyKey });
      const primaryLeadSessionRef = ctx.state.planBlockerSubject.leadSessionRef;
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision after blocker response", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], planBlockerSubject: null, planBlockerResponseReceipt: { idempotencyKey: command.idempotencyKey, responseId: response.responseId, blockerSubjectHash: ctx.state.planBlockerSubject.artifactSha256 }, originalPlanSubject: null, finalPlanSubject: null, materialityEvidence: null, supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null });
      await ctx.project();
      return await executeLeadTurn(primaryLeadSessionRef, undefined, response.answerArtifactId && response.answerArtifactSha256 ? { artifactId: response.answerArtifactId, sha256: response.answerArtifactSha256 } : undefined);
    } finally { ctx.decisionInFlight = false; }
  }), { validator(rawInput) {
    const command = PlanCommandInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || command.expectedWorkflowRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "blocked" || !ctx.state.planBlockerSubject) throw new Error("Plan blocker response is not available in the current phase");
  } });
}

export function registerPlanningHandlersRevision(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.revise_plan, ctx.guarded(async (rawInput) => {
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
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["verify_developer_ownership", "cancel_issue"]), pendingAction: summary, ...ctx.recoveryFields("ownership_ambiguous", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
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
  setHandler(issueUpdates.reject_plan, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("plan revision command", rawInput);
    const command = PlanCommandInputSchema.parse(rawInput);
    const capacityCancellation = ctx.state.phase === "development" && ctx.state.developerExecutionId ? { status: "cancelled" as const } : await ctx.cancelCurrentCapacity();
    if (ctx.state.phase === "development") {
      const cancellation = await cancelDeveloperExecution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, executionId: ctx.state.developerExecutionId! });
      if (cancellation.status === "completed_before_cancellation") {
        if (!ctx.applyCompletedDeveloperResult(cancellation.result, "Developer result claimed before plan revision.")) throw new Error("Completed Developer result is invalid");
        await ctx.project();
        return ctx.state;
      }
      if (cancellation.status !== "cancelled" && cancellation.status !== "cancelled_confirmed") {
        const summary = "summary" in cancellation ? cancellation.summary : "Developer ownership must be precisely cancelled before plan revision";
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["verify_developer_ownership", "cancel_issue"], pendingAction: summary, ...ctx.recoveryFields("ownership_ambiguous", "reasonCode" in cancellation ? cancellation.reasonCode : "developer-termination-unconfirmed", summary, ctx.state.developerLastHeartbeatAt ?? null), activeOperation: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      if (ctx.state.capacity) await ctx.settleCancelledCapacity(ctx.state.developerExecutionId!);
    } else if (capacityCancellation.status === "ownership_ambiguous") {
      await ctx.preserveAmbiguousCapacity();
      return ctx.state;
    }
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false, supplementalReviewArtifactId: null, decisionId: null, blocker: null, stateChangedAt: new Date().toISOString() });
    const decision = await recordPlanDecision({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, planRevision: ctx.state.revision - 1, actorUserId: command.actorUserId, decision: "reject", note: `${command.note ?? "Member requested an explicit plan revision"}; worktree=${command.worktreeDecision ?? "new"}; exactBase=${command.exactBaseSha ?? "recorded-current-base"}` });
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, decisionId: decision.decisionId, leadResumeInstructionArtifactId: decision.noteArtifactId ?? null, leadResumeInstructionSha256: decision.noteArtifactSha256 ?? null, deliveryReviewId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null });
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
