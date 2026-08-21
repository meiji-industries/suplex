import { CancellationScope, setHandler } from "@temporalio/workflow";

import { assertPayloadWithinLimit } from "../policy.js";
import { IssueWorkflowStateSchema, type LeadPlanningResult } from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import { recordDecisionBlockerResolution, runLeadPlanning } from "./activity-proxies.js";
import type { IssueWorkflowContext } from "./context.js";

export function registerGovernanceHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.resolve_decision_blocker, ctx.guarded(async (rawInput) => {
    assertPayloadWithinLimit("decision blocker resolution command", rawInput);
    const command = rawInput;
    const blockedRevision = ctx.state.revision;
    const resolution = await recordDecisionBlockerResolution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, blockerOutputArtifactId: ctx.state.blockerArtifactId!, blockerOutputSha256: ctx.state.blockerArtifactSha256!, answerArtifactId: command.answerArtifactId, answerSha256: command.answerSha256 });
    if (ctx.state.phase !== "blocked" || ctx.state.revision !== blockedRevision) return ctx.state;
    const next = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: blockedRevision + 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead decision resolution", lastEventId: `${ctx.state.workflowId}:${blockedRevision + 1}`, blockerResolutionId: resolution.resolutionId, leadResumeInstructionArtifactId: command.answerArtifactId, leadResumeInstructionSha256: command.answerSha256 });
    ctx.state = next;
    if (!ctx.decisionResolutionProjectionEnabled()) await ctx.project();
    if (ctx.state.phase !== "planning" || ctx.state.revision !== next.revision) return ctx.state;
    let leadResult: LeadPlanningResult;
    try {
      const scope = new CancellationScope();
      ctx.planningScope = scope;
      ctx.planningPromise = scope.run(() => runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: next.revision, resume: { leadSessionRef: next.leadSessionRef!, reason: "decision_resolution", instructionArtifactId: command.answerArtifactId, instructionSha256: command.answerSha256 } }));
      leadResult = await ctx.planningPromise;
      ctx.planningPromise = undefined;
      ctx.planningScope = undefined;
    } catch (error) {
      ctx.planningPromise = undefined;
      ctx.planningScope = undefined;
      const failure = ctx.permanentActivityFailure(error, ctx.patched(ctx.exhaustedActivityRecoveryPatch));
      if (!failure) throw error;
      if (ctx.currentState().phase === "cancelled") return ctx.currentState();
      const blockedCategory = ctx.failureBlockCategory(failure.code);
      ctx.state = IssueWorkflowStateSchema.parse({ ...next, phase: "blocked", revision: next.revision + 1, owner: "human", allowedCommands: blockedCategory ? ["start_planning", "cancel_issue"] : ["resolve_decision_blocker", "cancel_issue"], pendingAction: blockedCategory ? failure.summary : "Lead decision resolution failed; resubmit the decision", lastEventId: `${ctx.state.workflowId}:${next.revision + 1}`, blockedCategory: blockedCategory ?? "human_decision", blockedResumePhase: "planning" });
      await ctx.project();
      return ctx.state;
    }
    if (ctx.state.revision !== next.revision || ctx.state.phase !== "planning") return ctx.state;
    ctx.state = ctx.leadResultRoutingEnabled() ? ctx.applyLeadResult(next, leadResult) : ctx.applyLegacyLeadResult(next, leadResult);
    if (ctx.state.phase !== "blocked") {
      ctx.state = ctx.state.planMaterial
        ? IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "approval", owner: "human", allowedCommands: ["approve_plan", "reject_plan", "cancel_issue", ...(ctx.input.supplementalReview ? ["request_supplemental_review" as const] : [])], pendingAction: "Approve final plan" })
        : IssueWorkflowStateSchema.parse({ ...ctx.state, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development" });
    }
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = rawInput;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (ctx.state.phase !== "blocked" || ctx.state.blockedCategory !== "human_decision" || !ctx.state.allowedCommands.includes("resolve_decision_blocker")) throw new Error("Decision blocker resolution is not available in the current phase");
    if (!ctx.state.leadSessionRef || !ctx.state.blockerArtifactId || !ctx.state.blockerArtifactSha256) throw new Error("The Lead blocker evidence is unavailable");
  }});

}
