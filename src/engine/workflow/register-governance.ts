import { setHandler } from "../registry.js";

import { assertPayloadWithinLimit } from "../policy.js";
import { IssueWorkflowStateSchema, type LeadPlanningResult } from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import { recordDecisionBlockerResolution, runLeadPlanning } from "./activity-proxies.js";
import type { IssueWorkflowContext } from "./context.js";
import { at, isBlocked } from "../../issue-phases.js";
import { evidencePointer, humanBlocker } from "./state-transitions.js";

export function registerGovernanceHandlers(ctx: IssueWorkflowContext): void {
  setHandler(issueUpdates.resolve_decision_blocker, ctx.guarded(async (rawInput: any) => {
    assertPayloadWithinLimit("decision blocker resolution command", rawInput);
    const command = rawInput;
    const blockedRevision = ctx.state.revision;
    const resolution = await recordDecisionBlockerResolution({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, actorUserId: command.actorUserId, blockerOutputArtifactId: ctx.state.blockerArtifactId!, answerArtifactId: command.answerArtifactId });
    if (!isBlocked(ctx.state) || ctx.state.step !== "planning" || ctx.state.revision !== blockedRevision) return ctx.state;
    const next = IssueWorkflowStateSchema.parse({ ...ctx.state, ...at("planning"), revision: blockedRevision + 1, owner: "lead", allowedCommands: [], pendingAction: "The Planner resolves the decision", blocker: null, lastEventId: `${ctx.state.workflowId}:${blockedRevision + 1}`, blockerResolutionId: resolution.resolutionId, leadResumeInstructionArtifactId: command.answerArtifactId });
    ctx.state = next;
    if (!true) await ctx.project();
    if (ctx.state.step !== "planning" || ctx.state.revision !== next.revision) return ctx.state;
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
      const allowedCommands = blockedCategory ? ["start_planning", "cancel_issue"] as const : ["resolve_decision_blocker", "cancel_issue"] as const;
      const pendingAction = blockedCategory ? failure.summary : "The Planner resolves the decision failed; resubmit the decision";
      const blockerCategory = blockedCategory ? "unsafe_recovery" : "member_decision";
      ctx.state = IssueWorkflowStateSchema.parse({ ...next, ...at("planning"), revision: next.revision + 1, owner: "human", allowedCommands, pendingAction, blocker: humanBlocker(blockerCategory, pendingAction, allowedCommands.map((command) => ({ command, label: command === "cancel_issue" ? "Cancel the task" : "Resolve decision", requiresNote: false, destructive: command === "cancel_issue" })), evidencePointer(next.blockerArtifactId ?? command.answerArtifactId, "decision-blocker")), lastEventId: `${ctx.state.workflowId}:${next.revision + 1}`, blockedCategory: blockedCategory ?? "human_decision", blockedResumePhase: "planning" });
      await ctx.project();
      return ctx.state;
    }
    if (ctx.state.revision !== next.revision || ctx.state.step !== "planning") return ctx.state;
    ctx.state = ctx.applyLeadResult(next, leadResult);
    if (!isBlocked(ctx.state)) {
      ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue", ...(ctx.input.supplementalReview && ctx.input.roleProfiles.reviewer ? ["request_supplemental_review" as const] : [])], pendingAction: "Approve the final plan" });
    }
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) {
    const command = rawInput;
    if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision");
    if (!isBlocked(ctx.state) || ctx.state.step !== "planning" || ctx.state.blockedCategory !== "human_decision" || !ctx.state.allowedCommands.includes("resolve_decision_blocker")) throw new Error("Decision blocker resolution is not available in the current phase");
    if (!ctx.state.leadSessionRef || !ctx.state.blockerArtifactId) throw new Error("The Lead blocker evidence is unavailable");
  }});

}
