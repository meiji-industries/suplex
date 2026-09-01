import { setHandler } from "../registry.js";

import { assertPayloadWithinLimit } from "../policy.js";
import { IssueWorkflowStateSchema, type LeadPlanningResult } from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import { recordDecisionBlockerResolution, runLeadPlanning } from "./activity-proxies.js";
import type { IssueWorkflowContext } from "./context.js";

export function registerGovernanceHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.resolve_decision_blocker, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("decision blocker resolution command", rawInput);
    const command = rawInput;
    const blockedRevision = ctx.state.revision;
    const resolution = await recordDecisionBlockerResolution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, blockerOutputArtifactId: ctx.state.blockerArtifactId!, answerArtifactId: command.answerArtifactId });
    if (ctx.state.phase !== "blocked" || ctx.state.revision !== blockedRevision) return ctx.state;
    const next = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: blockedRevision + 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead decision resolution", lastEventId: `${ctx.state.workflowId}:${blockedRevision + 1}`, blockerResolutionId: resolution.resolutionId, leadResumeInstructionArtifactId: command.answerArtifactId });
    ctx.state = next;
    if (!true) await ctx.project();
    if (ctx.state.phase !== "planning" || ctx.state.revision !== next.revision) return ctx.state;
    let leadResult: LeadPlanningResult;
    try {      ctx.planningPromise = runLeadPlanning({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, briefArtifactId: ctx.input.briefArtifactId, imageArtifactIds: ctx.input.imageArtifactIds, roleProfiles: ctx.input.roleProfiles, revision: next.revision, resume: { leadSessionRef: next.leadSessionRef!, reason: "decision_resolution", instructionArtifactId: command.answerArtifactId } });
      leadResult = await ctx.planningPromise;
      ctx.planningPromise = undefined;
    } catch (error) {
      ctx.planningPromise = undefined;
      const failure = ctx.permanentActivityFailure(error, true);
      if (!failure) throw error;
      if (ctx.currentState().phase === "cancelled") return ctx.currentState();
      const blockedCategory = ctx.failureBlockCategory(failure.code);
      ctx.state = IssueWorkflowStateSchema.parse({ ...next, phase: "blocked", revision: next.revision + 1, owner: "human", allowedCommands: blockedCategory ? ["start_planning", "cancel_issue"] : ["resolve_decision_blocker", "cancel_issue"], pendingAction: blockedCategory ? failure.summary : "Lead decision resolution failed; resubmit the decision", lastEventId: `${ctx.state.workflowId}:${next.revision + 1}`, blockedCategory: blockedCategory ?? "human_decision", blockedResumePhase: "planning" });
      await ctx.project();
      return ctx.state;
    }
    if (ctx.state.revision !== next.revision || ctx.state.phase !== "planning") return ctx.state;
    ctx.state = ctx.applyLeadResult(next, leadResult);
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
    if (!ctx.state.leadSessionRef || !ctx.state.blockerArtifactId) throw new Error("The Lead blocker evidence is unavailable");
  }});

}
