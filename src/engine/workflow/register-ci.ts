import { at, isBlocked } from "../../issue-phases.js";
import { shouldUpdateFromBaseBeforeCiRepair } from "../../ci.js";
import { isCancellation, runExecution, setHandler } from "../registry.js";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import { findCiRepairPriorDelivery } from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { issueUpdates } from "../issue-updates.js";
import { developerExecutionId } from "../deterministic-id.js";
import { classifyRepairFailure } from "./runtime.js";
import type { IssueBlocker } from "../issue-contracts.js";
import type { IssueWorkflowContext } from "./context.js";
import type { GithubPullRequestObservationResult } from "../contracts/activities/github-sync.js";

/** Reruns are for flaky/unrelated failures; two per CI cycle, then repair the code. */
export const CI_RERUN_LIMIT = 2;
const CI_RERUN_POLL_DELAY_MS = 60_000;
const CI_PENDING_POLL_DELAY_MS = 15_000;
const CI_OBSERVATION_FAILURE_POLL_DELAY_MS = 60_000;
const CI_COMMAND_STEPS = new Set(["ci_waiting", "ci_repair_planning", "ci_repairing"]);

export function deferCiReconciliation(state: contracts.IssueWorkflowState, now: string): contracts.IssueWorkflowState {
  const summary = "Forge waits for CI — release evidence is unavailable";
  return contracts.IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("ci_waiting"), owner: "human", allowedCommands: ["reconcile_ci", "repair_ci", "cancel_issue"], pendingAction: summary, blocker: stateTransitions.humanBlocker("verification_unrecoverable", summary, [{ command: "reconcile_ci", label: "Check CI", requiresNote: false, destructive: false }, { command: "repair_ci", label: "Repair CI", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(state.ciEvidenceArtifactId ?? undefined, "attention-evidence")), stateChangedAt: now, lastEventId: `${state.workflowId}:${state.revision + 1}` });
}

export function ciDeadlineBlockedState(state: contracts.IssueWorkflowState, summary: string, now: string): contracts.IssueWorkflowState {
  return contracts.IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, ...at("ci_waiting"), owner: "human", allowedCommands: ["repair_ci", "reconcile_ci", "cancel_issue"], pendingAction: summary, blocker: stateTransitions.humanBlocker("verification_unrecoverable", summary, [{ command: "repair_ci", label: "Repair CI", requiresNote: false, destructive: false }, { command: "reconcile_ci", label: "Check CI", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(state.ciEvidenceArtifactId ?? undefined, "attention-evidence")), stateChangedAt: now, lastEventId: `${state.workflowId}:${state.revision + 1}` });
}

export function adoptCiPullRequestRelease(state: contracts.IssueWorkflowState, release: { releaseId: string; repository: string; baseBranch: string; targetBaseSha: string; pullRequestNumber: number; pullRequestUrl: string; headSha: string; headTree: string }): contracts.IssueWorkflowState {
  return contracts.IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, releaseId: release.releaseId, releaseRepository: release.repository, baseBranch: release.baseBranch, targetBaseSha: release.targetBaseSha, pullRequestNumber: release.pullRequestNumber, pullRequestUrl: release.pullRequestUrl, expectedHeadSha: release.headSha, expectedHeadTree: release.headTree, resultCommit: release.headSha, resultTree: release.headTree, lastEventId: `${state.workflowId}:${state.revision + 1}` });
}

export function registerCiHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(true) };
  const agent = activityProxies;
  const validateReconcileCi = (rawInput: contracts.StartPlanningInput): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || !CI_COMMAND_STEPS.has(ctx.state.step) || !ctx.state.allowedCommands.includes("reconcile_ci")) throw new Error("CI reconciliation is not available in the current phase");
    return command;
  };
  const runExactCiRepairTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.ciRepairPlanId || !ctx.state.ciRepairPlanArtifactId || !ctx.state.ciRepairPlanEvidenceArtifactId || !ctx.state.ciAttemptId || !ctx.state.ciRunId || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.branchName) throw new Error("The exact CI repair plan and prior Developer delivery are required");
    const ciRunId = ctx.state.ciRunId;
    const ciAttemptId = ctx.state.ciAttemptId;
    const repairPlanId = ctx.state.ciRepairPlanId;
    const repairPlanArtifactId = ctx.state.ciRepairPlanArtifactId;
    const repairPlanEvidenceArtifactId = ctx.state.ciRepairPlanEvidenceArtifactId;
    const failedHeadSha = ctx.state.resultCommit;
    const prior = await findCiRepairPriorDelivery({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, resultCommit: failedHeadSha });
    if (!prior) {
      const summary = "Forge cannot find the delivery that CI tested. Retry the CI check or cancel the task.";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "human", allowedCommands: ctx.addRevisionCommand(["reconcile_ci", "cancel_issue"]), pendingAction: summary, blocker: stateTransitions.humanBlocker("unsafe_recovery", summary, [{ command: "reconcile_ci", label: "Check CI", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(ctx.state.ciEvidenceArtifactId ?? undefined, "attention-evidence")), stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    const priorDeveloperExecutionId = prior.developerExecutionId;
    const priorDeveloperSessionRef = prior.developerSessionRef;
    const branchName = ctx.state.branchName;
    const priorCommit = ctx.state.resultCommit;
    const priorTree = ctx.state.resultTree;
    const releaseId = ctx.state.releaseId;
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const turnExecutionId = developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "repair");
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_repairing"), owner: "lead", allowedCommands: [], pendingAction: "The Builder repairs the failed CI job", developerExecutionId: priorDeveloperExecutionId, developerAttempt, developerTurnKind: "repair", ...ctx.recoveryFields("starting", null, "Starting Developer CI repair.", null), blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    try {
      const result = await ctx.acquireExternalTurn<contracts.WorkflowCiRepairActivityResult>(
        { operation: "ci_repair_execution", ...stateTransitions.integratorTurn(ctx, "builder"), worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => agent.runCiRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, ...(releaseId ? { releaseId } : {}), projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, ciRunId, ciAttemptId, repairPlanId, repairPlanArtifactId, repairPlanEvidenceArtifactId, failedHeadSha, priorDeveloperExecutionId, priorDeveloperSessionRef, worktreePath: prior.worktreePath, branchName, priorCommit, priorTree, developerTurnExecutionId: turnExecutionId, developerAttempt, turnKind: "repair", ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (repair) => repair.developerExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at(result.outcome === "completed" ? "delivery_ready" : ctx.state.step), owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["request_delivery_changes", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "The Planner reviews the latest changes" : "CI repair is blocked", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.outcome === "completed" ? "clean" : "dirty", deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.summary, developerOutcome: result.outcome === "completed" ? "completed" : "blocked", deliveryReviewId: result.outcome === "completed" ? null : ctx.state.deliveryReviewId, ...(result.outcome === "completed" ? { deliveryRepairAttemptId: null, deliveryReviewSupersedesId: null, deliveryReviewOutcome: null, deliveryReviewSummary: null, deliveryBlockingFindings: [], deliveryRepairPlan: null } : {}), releaseId: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, ciRepairDeveloperExecutionId: result.developerExecutionId, ciRepairDeveloperSessionRef: result.developerSessionRef, blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker("verification_unrecoverable", result.summary, [{ command: "request_delivery_changes", label: "Request changes", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.evidenceArtifactId, "attention-evidence")) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } catch (error) {
      if (isCancellation(error)) throw error;
      const failure = ctx.permanentActivityFailure(error);
      const failureClass = classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : {}), summary: failure?.summary ?? "The CI repair failed. Retry.", source: "ci" });
      const evidence = stateTransitions.evidencePointer(failure?.evidenceArtifactId ?? ctx.state.ciEvidenceArtifactId ?? undefined, "attention-evidence");
      if (failureClass === "credential_missing") ctx.state = stateTransitions.credentialBlockedState(ctx.state, "repair_ci", evidence);
      else if (failureClass === "transient_infrastructure" || failureClass === "rate_limited") ctx.state = stateTransitions.transientRetryState(ctx.state, "repair_ci", failure?.summary ?? "The CI repair failed. Retry.");
      else {
        const summary = `The CI repair could not start: ${failure?.summary ?? "The CI repair failed."}`;
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "human", allowedCommands: ctx.addRevisionCommand(["repair_ci", "cancel_issue"]), pendingAction: summary, blocker: stateTransitions.humanBlocker(failure?.category ?? "verification_unrecoverable", summary, [{ command: "repair_ci", label: "Repair CI", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidence), stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
    }
    await ctx.project();
    return ctx.state;
  };
  const reconcileCiTurn = async (initialObservation?: GithubPullRequestObservationResult | null): Promise<contracts.IssueWorkflowState> => {
    const expectedBaseSha = ctx.state.targetBaseSha;
    const deferObservationFailure = async (error: unknown): Promise<contracts.IssueWorkflowState> => {
      if (isCancellation(error)) throw error;
      const failure = ctx.permanentActivityFailure(error);
      const failureClass = classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : failure?.code === "authentication-required" ? { category: "provider_authentication" } : {}), summary: failure?.summary ?? "Forge could not check CI. Retry.", source: "ci" });
      const evidence = stateTransitions.evidencePointer(failure?.evidenceArtifactId ?? ctx.state.ciEvidenceArtifactId ?? ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence");
      if (failureClass === "credential_missing") ctx.state = stateTransitions.credentialBlockedState(ctx.state, "reconcile_ci", evidence);
      else {
        const deferred = deferCiReconciliation(ctx.state, new Date(runExecution.current().now()).toISOString());
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...deferred, ciNextPollAt: new Date(runExecution.current().now() + CI_OBSERVATION_FAILURE_POLL_DELAY_MS).toISOString() });
      }
      await ctx.project();
      return ctx.state;
    };
    let observed = initialObservation;
    if (observed === undefined && ctx.state.releaseRepository && ctx.state.branchName) {
      try {
        observed = await activityProxies.observeGithubPullRequest({ repository: ctx.state.releaseRepository, branch: ctx.state.branchName, pullRequestNumber: ctx.state.pullRequestNumber });
      } catch (error) {
        return deferObservationFailure(error);
      }
    }
    observed ??= null;
    let reviewedCommit = ctx.state.resultCommit;
    if (!reviewedCommit && ctx.state.releaseId) {
      ctx.state = deferCiReconciliation(ctx.state, new Date().toISOString());
      await ctx.project();
      return ctx.state;
    }
    if (!ctx.state.releaseId) {
      if (reviewedCommit && observed?.exists && observed.state === "open" && (observed.headSha?.toLowerCase() !== reviewedCommit.toLowerCase() || (expectedBaseSha && observed.baseSha?.toLowerCase() !== expectedBaseSha.toLowerCase()))) {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", deliveryReviewId: null, finalReviewId: null, ciRunId: null, acceptanceId: null, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      if (!observed?.exists || observed.state !== "open" || !observed.headSha || !observed.number || !observed.url || !ctx.state.releaseRepository || !ctx.state.branchName || !ctx.state.baseBranch) {
        ctx.state = deferCiReconciliation(ctx.state, new Date().toISOString());
        await ctx.project();
        return ctx.state;
      }
      const adopted = await activityProxies.adoptPullRequestRelease({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, repository: ctx.state.releaseRepository, branchName: ctx.state.branchName, baseBranch: ctx.state.baseBranch, ...(expectedBaseSha ? { expectedBaseSha } : {}), pullRequestNumber: observed.number, headSha: observed.headSha });
      ctx.state = adoptCiPullRequestRelease(ctx.state, adopted);
      await ctx.project();
      observed = null;
      reviewedCommit = ctx.state.resultCommit;
    }
    const attempt = (ctx.state.ciAttempt ?? 0) + 1;
    const expectedReleaseId = ctx.state.releaseId!;
    const expectedRevision = ctx.state.revision;
    let result;
    try {
      const currentObservation = initialObservation ?? observed;
      const expectedHeadSha = currentObservation?.headSha ?? reviewedCommit!;
      if (currentObservation?.headSha && expectedHeadSha.toLowerCase() !== reviewedCommit!.toLowerCase()) {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("delivery_ready"), owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the latest changes", deliveryReviewId: null, finalReviewId: null, ciRunId: null, acceptanceId: null, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      result = await activityProxies.reconcileCi({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, releaseId: expectedReleaseId, expectedHeadSha, attemptNumber: attempt });
    } catch (error) {
      if (isCancellation(error)) throw error;
      if (ctx.state.step !== "ci_waiting" || ctx.state.revision !== expectedRevision || ctx.state.releaseId !== expectedReleaseId) return ctx.state;
      const failure = ctx.permanentActivityFailure(error);
      const failureClass = classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : failure?.code === "authentication-required" ? { category: "provider_authentication" } : {}), summary: failure?.summary ?? "Forge could not check CI. Retry.", source: "ci" });
      if (failureClass === "credential_missing") {
        const evidence = stateTransitions.evidencePointer(failure?.evidenceArtifactId ?? ctx.state.ciEvidenceArtifactId ?? ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence");
        ctx.state = stateTransitions.credentialBlockedState(ctx.state, "reconcile_ci", evidence);
        await ctx.project();
        return ctx.state;
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ciAttempt: attempt, ciReason: "provider_failure_budget_exhausted", ciOwner: "human", ciRepairable: false, ciNextPollAt: null, ...at("development"), owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], pendingAction: failure?.summary ?? "Forge could not check CI. Retry.", blocker: failure?.category ? stateTransitions.humanBlocker(failure.category, failure.summary, [{ command: "reconcile_ci", label: "Check CI", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], undefined) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (ctx.state.step !== "ci_waiting" || ctx.state.revision !== expectedRevision || ctx.state.releaseId !== expectedReleaseId) return ctx.state;
    const ciOwner = (result.owner as "system" | "integrator" | "human" | "lead" | null) === "lead" ? "integrator" : result.owner;
    const pending = result.outcome === "waiting" || result.outcome === "rate_limited";
    const minimumPollAt = new Date(runExecution.current().now() + CI_PENDING_POLL_DELAY_MS).toISOString();
    const ciNextPollAt = pending && (!result.nextPollAt || Date.parse(result.nextPollAt) < Date.parse(minimumPollAt)) ? minimumPollAt : result.nextPollAt;
    ctx.assignState(() => contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, expectedHeadSha: result.expectedHeadSha, ciAttempt: result.attemptNumber, ciAttemptId: result.attemptId, ciRunId: result.runId, ciReason: result.reason, ciOwner, ciRepairable: result.repairable, ciEvidenceArtifactId: result.evidenceArtifactId, ciPropagationDeadline: result.propagationDeadline, ciOverallDeadline: result.overallDeadline, ciNextPollAt, pendingAction: pending ? "Forge waits for CI" : result.summary, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }));
    await ctx.project();
    if (result.outcome === "failed" && ctx.state.ciOverallDeadline && Date.parse(ctx.state.ciOverallDeadline) <= Date.now()) {
      ctx.state = ciDeadlineBlockedState(ctx.state, result.summary, new Date().toISOString());
      await ctx.project();
      return ctx.state;
    }
    if (result.outcome === "passed") {
      if (result.reason === "checks_passed_merged") {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("done"), owner: "human", allowedCommands: [], pendingAction: "Merged", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      const baseUpdateCount = ctx.state.ciBaseUpdateCount ?? 0;
      if (baseUpdateCount < 5 && ctx.state.developerExecutionId && ctx.state.branchName && ctx.state.targetBaseSha && ctx.state.resultCommit && ctx.state.resultTree && ctx.state.ciRunId) {
        const update = await activityProxies.updateCiFromBase({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, releaseId: ctx.state.releaseId!, developerExecutionId: ctx.state.developerExecutionId, branchName: ctx.state.branchName, expectedBaseSha: ctx.state.targetBaseSha, expectedHeadSha: ctx.state.resultCommit, expectedHeadTree: ctx.state.resultTree, ciRunId: ctx.state.ciRunId });
        if (update.outcome === "updated") {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: update.summary, targetBaseSha: update.baseSha, expectedHeadSha: update.headSha, resultCommit: update.headSha, resultTree: update.headTree, ciRunId: null, ciAttemptId: null, ciReason: null, ciEvidenceArtifactId: null, ciNextPollAt: null, ciBaseUpdateCount: baseUpdateCount + 1, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          await ctx.project();
          return ctx.state;
        }
        if (update.outcome === "conflict") {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("merge_conflict_resolving"), owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: update.summary, forwardMergeId: update.forwardMergeId, forwardMergePriorHead: update.priorHead, forwardMergePriorTree: update.priorTree, forwardMergeTargetBaseSha: update.baseSha, forwardMergeConflictArtifact: { id: update.conflictArtifactId, kind: "forward-merge-conflict" }, forwardMergeConflictFileCount: update.conflictFileCount, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          await ctx.project();
          return ctx.state;
        }
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("final_review"), owner: "lead", allowedCommands: [], pendingAction: "The final review is in progress", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.runFinalReviewTurn();
    }
    const baseUpdateCount = ctx.state.ciBaseUpdateCount ?? 0;
    if (shouldUpdateFromBaseBeforeCiRepair({ outcome: result.outcome, repairable: result.repairable, owner: result.owner, baseUpdateCount }) && ctx.state.releaseId && ctx.state.developerExecutionId && ctx.state.branchName && ctx.state.targetBaseSha && ctx.state.resultCommit && ctx.state.resultTree && ctx.state.ciRunId) {
      const update = await activityProxies.updateCiFromBase({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, releaseId: ctx.state.releaseId, developerExecutionId: ctx.state.developerExecutionId, branchName: ctx.state.branchName, expectedBaseSha: ctx.state.targetBaseSha, expectedHeadSha: ctx.state.resultCommit, expectedHeadTree: ctx.state.resultTree, ciRunId: ctx.state.ciRunId });
      if (update.outcome === "updated") {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: update.summary, targetBaseSha: update.baseSha, expectedHeadSha: update.headSha, resultCommit: update.headSha, resultTree: update.headTree, ciRunId: null, ciAttemptId: null, ciReason: null, ciEvidenceArtifactId: null, ciNextPollAt: null, ciBaseUpdateCount: baseUpdateCount + 1, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
    }
    if (result.outcome === "failed" && result.repairable && ciOwner === "integrator" && result.evidenceArtifactId && ctx.state.leadSessionRef && ctx.state.ciAttemptId) {
      const leadSessionRef = ctx.state.leadSessionRef!;
      const ciAttemptId = ctx.state.ciAttemptId!;
      const evidenceArtifactId = result.evidenceArtifactId!;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_repair_planning"), owner: "lead", allowedCommands: [], pendingAction: "Forge inspects the CI failure", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      try {
        const plan = await ctx.acquireExternalTurn<contracts.CiRepairPlanActivityResult>(
          { operation: "ci_repair_plan", ...stateTransitions.integratorTurn(ctx, "planner"), sessionRef: leadSessionRef },
          (capacityRequestId) => agent.planCiRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, leadSessionRef, ciRunId: result.runId, ciAttemptId, failedHeadSha: result.expectedHeadSha, evidenceArtifactId, requiredChecks: [], localVerification: [], roleProfiles: ctx.input.roleProfiles, executionRole: stateTransitions.integratorTurn(ctx, "planner").role === "integrator" ? "integrator" : "planner", ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (repairPlan) => repairPlan.leadExecutionId,
        );
        // The Lead can conclude the failure is not caused by this delivery. Re-run the
        // failed provider jobs instead of forcing a code repair, then wait on CI again.
        const rerunCount = ctx.state.ciRerunCount ?? 0;
        if (plan.disposition === "rerun" && rerunCount < CI_RERUN_LIMIT) {
          const rerun = await activityProxies.rerunCi({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, ciRunId: result.runId, ciAttemptId }).catch((error) => {
            if (isCancellation(error)) throw error;
            return null;
          });
          if (rerun) {
            ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: rerun.summary, ciRerunCount: rerunCount + 1, ciNextPollAt: new Date(Date.now() + CI_RERUN_POLL_DELAY_MS).toISOString(), ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
            await ctx.project();
            return ctx.state;
          }
        }
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_repair_planning"), owner: "lead", allowedCommands: [], pendingAction: "The Builder starts the CI repair", ciRepairPlanId: plan.planId, ciRepairPlanArtifactId: plan.planArtifactId, ciRepairPlanEvidenceArtifactId: plan.evidenceArtifactId, ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return runExactCiRepairTurn();
      } catch (error) {
        if (isCancellation(error)) throw error;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ctx.addRevisionCommand(["reconcile_ci", "request_delivery_changes", "cancel_issue"]), pendingAction: "The Integrator did not plan the fix. Retry, or inspect the task.", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      await ctx.project();
    } else if (!(result.owner === "system" && result.retryAt)) {
      const category: IssueBlocker["category"] = result.outcome === "provider_unavailable" ? "provider_connectivity_exhausted" : result.outcome === "stale_head" ? "target_drift" : "verification_unrecoverable";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("development"), owner: "human", allowedCommands: ctx.addRevisionCommand(["reconcile_ci", "cancel_issue"]), pendingAction: result.summary, blocker: stateTransitions.humanBlocker(category, result.summary, [{ command: "reconcile_ci", label: "Check CI", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.evidenceArtifactId ?? undefined, "ci-evidence")), stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
    }
    return ctx.state;
  };
  setHandler(issueUpdates.reconcile_ci, ctx.guarded(async (rawInput: any) => {
    validateReconcileCi(rawInput);
    if (isBlocked(ctx.state)) {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ...at("ci_waiting"), owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Forge checks CI again", blocker: null, ciNextPollAt: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
    }
    return reconcileCiTurn();
  }, "reconcile_ci"), { validator(rawInput) { validateReconcileCi(rawInput); } });
  setHandler(issueUpdates.repair_ci, ctx.guarded(async (rawInput: any) => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || !CI_COMMAND_STEPS.has(ctx.state.step) || !ctx.state.allowedCommands.includes("repair_ci")) throw new Error("CI repair is not available in the current phase");
    if (ctx.state.ciRepairPlanId && ctx.state.ciRepairPlanArtifactId && ctx.state.ciRepairPlanEvidenceArtifactId && ctx.state.ciAttemptId && ctx.state.ciRunId && ctx.state.resultCommit && ctx.state.resultTree && ctx.state.developerExecutionId && ctx.state.developerSessionRef && ctx.state.branchName) return runExactCiRepairTurn();
    if (!ctx.state.deliveryReviewId || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.leadSessionRef) throw new Error("The exact prior Developer delivery is required for CI repair");
    const cycle = (ctx.state.repairCycle ?? 0) + 1;
    if (ctx.input.repairCycleLimit !== undefined && cycle > ctx.repairCycleLimit) throw new Error("CI repair limit is exhausted");
    const priorDelivery = { leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef!, developerExecutionId: ctx.state.developerExecutionId!, reviewId: ctx.state.deliveryReviewId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree! };
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Builder CI repair cycle ${cycle}`, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    const ciFindings = (ctx.state.deliveryBlockingFindings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    const repairFindings = ciFindings.length ? ciFindings : [{ findingId: `ci_failure_${ctx.state.revision}`, severity: "blocking" as const, rationale: "Required CI did not pass", evidenceRef: ctx.state.ciRunId ?? "CI reconciliation", disposition: "open" as const, repairInstruction: "Resolve the exact-head CI failure and rerun the required checks." }];
    const repairPlan = await ctx.acquireExternalTurn<contracts.DeliveryRepairPlanResult>(
      { operation: "delivery_repair_plan", role: "planner", profileId: ctx.input.roleProfiles.planner, sessionRef: priorDelivery.leadSessionRef, worktreePath: priorDelivery.worktreePath },
      (capacityRequestId) => activityProxies.planDeliveryRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, source: "ci_failure", leadSessionRef: priorDelivery.leadSessionRef, planRevision: ctx.state.planRevision ?? ctx.state.revision, releaseId: ctx.state.releaseId, deliveryReviewId: ctx.state.deliveryReviewId, ciRunId: ctx.state.ciRunId, evidenceArtifactIds: [ctx.state.developerEvidenceArtifactId, ctx.state.finalReviewEvidenceArtifactId].filter((id): id is string => Boolean(id)), branchName: priorDelivery.branchName, worktreePath: priorDelivery.worktreePath, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, findings: repairFindings, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (plan) => plan.leadExecutionId,
    );
    const result = await ctx.acquireExternalTurn<contracts.WorkflowDeveloperRepairResult>(
      { operation: "developer_repair", role: "builder", profileId: ctx.input.roleProfiles.builder, sessionRef: priorDelivery.developerSessionRef, worktreePath: priorDelivery.worktreePath },
      (capacityRequestId) => activityProxies.runDeveloperRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision: ctx.state.planRevision ?? ctx.state.revision, roleProfiles: ctx.input.roleProfiles, leadSessionRef: priorDelivery.leadSessionRef, developerSessionRef: priorDelivery.developerSessionRef, developerExecutionId: priorDelivery.developerExecutionId, reviewId: priorDelivery.reviewId, cycle, repairCycleLimit: ctx.repairCycleLimit, ...(ctx.state.ciRepairPlanArtifactId ? { repairPlanArtifactId: ctx.state.ciRepairPlanArtifactId } : {}), branchName: priorDelivery.branchName, worktreePath: priorDelivery.worktreePath, targetBaseSha: priorDelivery.targetBaseSha, subjectCommit: priorDelivery.subjectCommit, subjectTree: priorDelivery.subjectTree, ...(capacityRequestId ? { capacityRequestId } : {}) }),
      (repair) => repair.developerExecutionId,
    );
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, ...(result.outcome === "completed" ? {} : stateTransitions.freshDeliveryLineage()), revision: ctx.state.revision + 1, ...at(result.outcome === "completed" ? "delivery_ready" : ctx.state.step), owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Reviewing the changes" : "Your decision is necessary", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: ctx.state.worktreePath, branchName: result.branchName, targetBaseSha: result.subject.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.outcome === "completed" ? result.deliveryArtifactId : ctx.state.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.outcome === "completed" ? result.summary : ctx.state.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, activeOperation: null, deliveryReviewId: null, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan.planArtifactId, deliveryRepairAuthority: result.outcome === "completed" ? null : "ci_failure", releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) { const command = contracts.StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision"); if (!CI_COMMAND_STEPS.has(ctx.state.step) || !ctx.state.allowedCommands.includes("repair_ci") || !ctx.state.developerExecutionId) throw new Error("CI repair is not available in the current phase"); } });

  ctx.reconcileCiTurn = reconcileCiTurn;
  (ctx as IssueWorkflowContext & { retryCiRepair?: (input: contracts.StartPlanningInput) => Promise<contracts.IssueWorkflowState> }).retryCiRepair = async () => runExactCiRepairTurn();
}
