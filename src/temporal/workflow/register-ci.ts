import { setHandler } from "@temporalio/workflow";
import * as contracts from "../issue-contracts.js";
import * as legacyActivityProxies from "./activity-proxies.js";
import * as stateTransitions from "./state-transitions.js";
import { issueUpdates } from "../issue-updates.js";
import { developerExecutionId } from "../deterministic-id.js";
import { classifyRepairFailure } from "./runtime.js";
import type { IssueBlocker } from "../issue-contracts.js";
import type { IssueWorkflowContext } from "./context.js";

/** Reruns are for flaky/unrelated failures; two per CI cycle, then repair the code. */
export const CI_RERUN_LIMIT = 2;
const CI_RERUN_POLL_DELAY_MS = 60_000;
const shouldUpdateFromBaseBeforeCiRepair = (result: { outcome: string; repairable: boolean; owner: string | null }, baseUpdateCount: number): boolean => result.outcome === "failed" && result.repairable && result.owner === "lead" && baseUpdateCount < 2;

export function registerCiHandlers(ctx: IssueWorkflowContext): void {
  const activityProxies = { ...legacyActivityProxies, ...legacyActivityProxies.agentActivities(ctx.herdrExecutionSubstrateEnabled) };
  const agent = activityProxies;
  const validateReconcileCi = (rawInput: contracts.StartPlanningInput): contracts.StartPlanningInput => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || !["ci_waiting", "delivery_blocked"].includes(ctx.state.phase) || !ctx.state.allowedCommands.includes("reconcile_ci")) throw new Error("CI reconciliation is not available in the current phase");
    return command;
  };
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
    const developerAttempt = (ctx.state.developerAttempt ?? 0) + 1;
    const planRevision = ctx.state.planRevision ?? ctx.state.revision;
    const turnExecutionId = developerExecutionId(ctx.state.workflowId, planRevision, developerAttempt, "repair");
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repairing", owner: "lead", allowedCommands: [], pendingAction: "Builder is fixing the failing CI job", developerExecutionId: ctx.supervisedDeveloperTurns ? turnExecutionId : priorDeveloperExecutionId, developerAttempt, developerTurnKind: "repair", ...ctx.recoveryFields("starting", null, "Starting Developer CI repair.", null), blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    try {
      const result = await ctx.acquireExternalTurn<contracts.WorkflowCiRepairActivityResult>(
        { operation: "ci_repair_execution", ...stateTransitions.integratorTurn(ctx, "builder"), sessionRef: priorDeveloperSessionRef, worktreePath: ctx.state.worktreePath },
        (capacityRequestId) => agent.runCiRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, ...(releaseId ? { releaseId } : {}), projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, planRevision, ciRunId, ciAttemptId, repairPlanId, repairPlanArtifactId, repairPlanEvidenceArtifactId, failedHeadSha, priorDeveloperExecutionId, priorDeveloperSessionRef, branchName, priorCommit, priorTree, developerTurnExecutionId: turnExecutionId, developerAttempt, turnKind: "repair", ...(capacityRequestId ? { capacityRequestId } : {}) }),
        (repair) => repair.developerExecutionId,
      );
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: result.outcome === "completed" ? "delivery_ready" : "delivery_blocked", owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ctx.addRevisionCommand(["review_delivery", "cancel_issue"]) : ctx.addRevisionCommand(["request_delivery_changes", "cancel_issue"]), pendingAction: result.outcome === "completed" ? "Reviewing the latest changes" : "CI repair is blocked", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, branchName: result.branchName, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.outcome === "completed" ? "clean" : "dirty", deliveryArtifactId: result.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.summary, developerOutcome: result.outcome === "completed" ? "completed" : "blocked", deliveryReviewId: result.outcome === "completed" ? null : ctx.state.deliveryReviewId, releaseId: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, ciRepairDeveloperExecutionId: result.developerExecutionId, ciRepairDeveloperSessionRef: result.developerSessionRef, blocker: result.outcome === "blocked" ? stateTransitions.humanBlocker("verification_unrecoverable", result.summary, [{ command: "request_delivery_changes", label: "Request delivery changes", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], undefined) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    } catch (error) {
      const failure = ctx.permanentActivityFailure(error);
      const failureClass = ctx.patched("forge-repair-no-progress-v1") ? classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : {}), summary: failure?.summary ?? "CI repair failed — retry", source: "ci" }) : "ci_failure";
      const evidence = stateTransitions.evidencePointer(failure?.evidenceArtifactId ?? ctx.state.ciEvidenceArtifactId ?? undefined, "attention-evidence");
      if (failureClass === "credential_missing") ctx.state = stateTransitions.credentialBlockedState(ctx.state, "repair_ci", evidence);
      else if (failureClass === "transient_infrastructure" || failureClass === "rate_limited") ctx.state = stateTransitions.transientRetryState(ctx.state, "repair_ci", failure?.summary ?? "CI repair failed — retry");
      else ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repair_required", owner: "human", allowedCommands: ctx.addRevisionCommand(["repair_ci", "cancel_issue"]), pendingAction: failure?.summary ?? "CI repair failed — retry", blocker: failure?.category ? stateTransitions.humanBlocker(failure.category, failure.summary, [{ command: "repair_ci", label: "Retry CI repair", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidence) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    }
    await ctx.project();
    return ctx.state;
  };
  const reconcileCiTurn = async (): Promise<contracts.IssueWorkflowState> => {
    if (!ctx.state.releaseId || !ctx.state.expectedHeadSha) throw new Error("Release evidence is required for CI reconciliation");
    const attempt = (ctx.state.ciAttempt ?? 0) + 1;
    const expectedReleaseId = ctx.state.releaseId;
    const expectedHeadSha = ctx.state.expectedHeadSha;
    const expectedRevision = ctx.state.revision;
    let result;
    try {
      const observed = ctx.patched("forge-live-head-v1") && ctx.state.releaseRepository && ctx.state.branchName
        ? await activityProxies.observeGithubPullRequest({ repository: ctx.state.releaseRepository, branch: ctx.state.branchName, pullRequestNumber: ctx.state.pullRequestNumber })
        : ctx.patched("forge-github-sync-v1") && ctx.state.releaseRepository && ctx.state.branchName
          ? await activityProxies.observeGithubPullRequest({ repository: ctx.state.releaseRepository, branch: ctx.state.branchName, pullRequestNumber: ctx.state.pullRequestNumber })
          : null;
      if (ctx.patched("forge-live-head-v1") && observed?.exists && observed.state === "open" && observed.headSha && observed.headSha !== ctx.state.expectedHeadSha) {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_ready", owner: "lead", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Reviewing the latest changes", expectedHeadSha: observed.headSha, expectedHeadTree: null, resultCommit: observed.headSha, resultTree: null, deliveryReviewId: null, finalReviewId: null, ciRunId: null, ciOutcome: null, acceptanceId: null, blocker: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      result = await activityProxies.reconcileCi({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, releaseId: ctx.state.releaseId, expectedHeadSha: ctx.state.expectedHeadSha, attemptNumber: attempt });
    } catch (error) {
      if (ctx.state.phase !== "ci_waiting" || ctx.state.revision !== expectedRevision || ctx.state.releaseId !== expectedReleaseId || ctx.state.expectedHeadSha !== expectedHeadSha) return ctx.state;
      const failure = ctx.permanentActivityFailure(error);
      const failureClass = ctx.patched("forge-repair-no-progress-v1") ? classifyRepairFailure({ code: failure?.code ?? null, ...(failure?.category ? { category: failure.category } : {}), summary: failure?.summary ?? "Couldn't check CI — retry", source: "ci" }) : null;
      if (failureClass === "credential_missing") {
        const evidence = stateTransitions.evidencePointer(failure?.evidenceArtifactId ?? ctx.state.ciEvidenceArtifactId ?? ctx.state.developerEvidenceArtifactId ?? undefined, "attention-evidence");
        ctx.state = stateTransitions.credentialBlockedState(ctx.state, "reconcile_ci", evidence);
        await ctx.project();
        return ctx.state;
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, ciAttempt: attempt, ciOutcome: "provider_unavailable", ciReason: "provider_failure_budget_exhausted", ciOwner: "human", ciRepairable: false, ciNextPollAt: null, phase: "delivery_blocked", owner: "human", allowedCommands: ["reconcile_ci", "cancel_issue"], pendingAction: failure?.summary ?? "Couldn't check CI — retry", blocker: failure?.category ? stateTransitions.humanBlocker(failure.category, failure.summary, [{ command: "reconcile_ci", label: "Retry CI reconciliation", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], undefined) : null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.state;
    }
    if (ctx.state.phase !== "ci_waiting" || ctx.state.revision !== expectedRevision || ctx.state.releaseId !== expectedReleaseId || ctx.state.expectedHeadSha !== expectedHeadSha) return ctx.state;
    const ciOwner = (result.owner as "system" | "integrator" | "human" | "lead" | null) === "lead" ? "integrator" : result.owner;
    ctx.assignState(() => contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, expectedHeadSha: result.expectedHeadSha, ciAttempt: result.attemptNumber, ciAttemptId: result.attemptId, ciRunId: result.runId, ciOutcome: result.outcome, ciReason: result.reason, ciOwner, ciRepairable: result.repairable, ciEvidenceArtifactId: result.evidenceArtifactId, ciPropagationDeadline: result.propagationDeadline, ciOverallDeadline: result.overallDeadline, ciNextPollAt: result.nextPollAt, pendingAction: result.outcome === "waiting" || result.outcome === "rate_limited" ? "Waiting for CI" : result.summary, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` }));
    await ctx.project();
    if (result.outcome === "passed") {
      if (result.reason === "checks_passed_merged") {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Merged", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
      const baseUpdateCount = ctx.state.ciBaseUpdateCount ?? 0;
      if (ctx.patched("forge-kodiak-merge-v1") && baseUpdateCount < 5 && ctx.state.developerExecutionId && ctx.state.branchName && ctx.state.targetBaseSha && ctx.state.expectedHeadTree && ctx.state.resultCommit && ctx.state.ciRunId) {
        const update = await activityProxies.updateCiFromBase({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, releaseId: ctx.state.releaseId!, developerExecutionId: ctx.state.developerExecutionId, branchName: ctx.state.branchName, expectedBaseSha: ctx.state.targetBaseSha, expectedHeadSha: ctx.state.resultCommit, expectedHeadTree: ctx.state.expectedHeadTree, ciRunId: ctx.state.ciRunId });
        if (update.outcome === "updated") {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: update.summary, targetBaseSha: update.baseSha, expectedHeadSha: update.headSha, resultCommit: update.headSha, resultTree: update.headTree, ciRunId: null, ciAttemptId: null, ciOutcome: "waiting", ciReason: null, ciEvidenceArtifactId: null, ciNextPollAt: null, ciBaseUpdateCount: baseUpdateCount + 1, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          await ctx.project();
          return ctx.state;
        }
        if (update.outcome === "conflict") {
          ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: update.summary, forwardMergeId: update.forwardMergeId, forwardMergePriorHead: update.priorHead, forwardMergePriorTree: update.priorTree, forwardMergeTargetBaseSha: update.baseSha, forwardMergeConflictArtifact: { id: update.conflictArtifactId, kind: "forward-merge-conflict" }, forwardMergeConflictFileCount: update.conflictFileCount, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
          await ctx.project();
          return ctx.state;
        }
      }
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "final_review", owner: "lead", allowedCommands: [], pendingAction: "Final Lead review", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      return ctx.runFinalReviewTurn();
    }
    const baseUpdateCount = ctx.state.ciBaseUpdateCount ?? 0;
    if (ctx.patched("forge-ci-update-from-base-v1") && shouldUpdateFromBaseBeforeCiRepair(result, baseUpdateCount) && ctx.state.releaseId && ctx.state.developerExecutionId && ctx.state.branchName && ctx.state.targetBaseSha && ctx.state.expectedHeadTree && ctx.state.resultCommit && ctx.state.ciRunId) {
      const update = await activityProxies.updateCiFromBase({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectRevisionId: ctx.input.projectRevisionId, releaseId: ctx.state.releaseId, developerExecutionId: ctx.state.developerExecutionId, branchName: ctx.state.branchName, expectedBaseSha: ctx.state.targetBaseSha, expectedHeadSha: ctx.state.resultCommit, expectedHeadTree: ctx.state.expectedHeadTree, ciRunId: ctx.state.ciRunId });
      if (update.outcome === "updated") {
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: update.summary, targetBaseSha: update.baseSha, expectedHeadSha: update.headSha, resultCommit: update.headSha, resultTree: update.headTree, ciRunId: null, ciAttemptId: null, ciOutcome: "waiting", ciReason: null, ciEvidenceArtifactId: null, ciNextPollAt: null, ciBaseUpdateCount: baseUpdateCount + 1, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return ctx.state;
      }
    }
    if (result.outcome === "failed" && result.repairable && ciOwner === "integrator" && result.evidenceArtifactId && ctx.state.leadSessionRef && ctx.state.ciAttemptId) {
      const leadSessionRef = ctx.state.leadSessionRef;
      const ciAttemptId = ctx.state.ciAttemptId;
      const evidenceArtifactId = result.evidenceArtifactId;
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repair_planning", owner: "lead", allowedCommands: [], pendingAction: "Looking into the CI failure", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
      try {
        const plan = await ctx.acquireExternalTurn<contracts.CiRepairPlanActivityResult>(
          { operation: "ci_repair_plan", ...stateTransitions.integratorTurn(ctx, "planner"), sessionRef: leadSessionRef },
          (capacityRequestId) => agent.planCiRepair({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, projectId: ctx.input.projectId, projectRevisionId: ctx.input.projectRevisionId, leadSessionRef, ciRunId: result.runId, ciAttemptId, failedHeadSha: expectedHeadSha, evidenceArtifactId, requiredChecks: [], localVerification: [], roleProfiles: ctx.input.roleProfiles, executionRole: stateTransitions.integratorTurn(ctx, "planner").role === "integrator" ? "integrator" : "planner", ...(capacityRequestId ? { capacityRequestId } : {}) }),
          (repairPlan) => repairPlan.leadExecutionId,
        );
        // The Lead can conclude the failure is not caused by this delivery. Re-run the
        // failed provider jobs instead of forcing a code repair, then wait on CI again.
        const rerunCount = ctx.state.ciRerunCount ?? 0;
        if (plan.disposition === "rerun" && ctx.patched("forge-ci-rerun-v1") && rerunCount < CI_RERUN_LIMIT) {
          const rerun = await activityProxies.rerunCi({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, ciRunId: result.runId, ciAttemptId }).catch(() => null);
          if (rerun) {
            ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: rerun.summary, ciRerunCount: rerunCount + 1, ciNextPollAt: new Date(Date.now() + CI_RERUN_POLL_DELAY_MS).toISOString(), ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, blocker: null, stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
            await ctx.project();
            return ctx.state;
          }
        }
        ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_repair_required", owner: "lead", allowedCommands: [], pendingAction: "Builder is fixing the failing CI job", ciRepairPlanId: plan.planId, ciRepairPlanArtifactId: plan.planArtifactId, ciRepairPlanEvidenceArtifactId: plan.evidenceArtifactId, ciRepairPlanSummary: plan.summary, ciRepairLeadExecutionId: plan.leadExecutionId, ciRepairLeadSessionRef: plan.leadSessionRef, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
        await ctx.project();
        return runExactCiRepairTurn();
      } catch {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["reconcile_ci", "request_delivery_changes", "cancel_issue"]), pendingAction: "Integrator couldn't plan the fix — retry or take a look", lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      }
      await ctx.project();
    } else if (!(result.owner === "system" && result.retryAt)) {
      const category: IssueBlocker["category"] = result.outcome === "provider_unavailable" ? "provider_connectivity_exhausted" : result.outcome === "stale_head" ? "target_drift" : "verification_unrecoverable";
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ctx.addRevisionCommand(["reconcile_ci", "cancel_issue"]), pendingAction: result.summary, blocker: stateTransitions.humanBlocker(category, result.summary, [{ command: "reconcile_ci", label: "Retry CI reconciliation", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], stateTransitions.evidencePointer(result.evidenceArtifactId ?? undefined, "ci-evidence")), stateChangedAt: new Date().toISOString(), lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
    }
    return ctx.state;
  };
  setHandler(issueUpdates.reconcile_ci, ctx.guarded(async (rawInput) => {
    validateReconcileCi(rawInput);
    if (ctx.state.phase === "delivery_blocked") {
      ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Checking CI again", blocker: null, ciNextPollAt: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
      await ctx.project();
    }
    return reconcileCiTurn();
  }, "reconcile_ci"), { validator(rawInput) { validateReconcileCi(rawInput); } });
  setHandler(issueUpdates.repair_ci, ctx.guarded(async (rawInput) => {
    const command = contracts.StartPlanningInputSchema.parse(rawInput);
    if (command.expectedRevision !== ctx.state.revision || (ctx.state.phase !== "ci_repair_required" && !(ctx.state.phase === "delivery_blocked" && ctx.state.allowedCommands.includes("repair_ci")))) throw new Error("CI repair is not available in the current phase");
    if (ctx.state.ciRepairPlanId && ctx.state.ciRepairPlanArtifactId && ctx.state.ciRepairPlanEvidenceArtifactId && ctx.state.ciAttemptId && ctx.state.ciRunId && ctx.state.expectedHeadSha && ctx.state.resultCommit && ctx.state.resultTree && ctx.state.developerExecutionId && ctx.state.developerSessionRef && ctx.state.branchName) return runExactCiRepairTurn();
    if (!ctx.state.deliveryReviewId || !ctx.state.developerExecutionId || !ctx.state.developerSessionRef || !ctx.state.branchName || !ctx.state.targetBaseSha || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.leadSessionRef) throw new Error("The exact prior Developer delivery is required for CI repair");
    const cycle = (ctx.state.repairCycle ?? 0) + 1;
    if (ctx.input.repairCycleLimit !== undefined && cycle > ctx.repairCycleLimit) throw new Error("CI repair limit is exhausted");
    const priorDelivery = { leadSessionRef: ctx.state.leadSessionRef!, developerSessionRef: ctx.state.developerSessionRef!, developerExecutionId: ctx.state.developerExecutionId!, reviewId: ctx.state.deliveryReviewId!, worktreePath: ctx.state.worktreePath!, branchName: ctx.state.branchName!, targetBaseSha: ctx.state.targetBaseSha!, subjectCommit: ctx.state.resultCommit!, subjectTree: ctx.state.resultTree!, ciOutcome: ctx.state.ciOutcome };
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, owner: "lead", allowedCommands: [], pendingAction: `Developer CI repair cycle ${cycle}`, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    const ciFindings = (ctx.state.deliveryBlockingFindings ?? []).filter((finding) => finding.severity === "blocking" && finding.disposition === "open");
    const repairFindings = ciFindings.length ? ciFindings : [{ findingId: `ci_failure_${ctx.state.revision}`, severity: "blocking" as const, rationale: `Required CI did not pass: ${priorDelivery.ciOutcome ?? "failed"}`, evidenceRef: ctx.state.ciRunId ?? "CI reconciliation", disposition: "open" as const, repairInstruction: "Resolve the exact-head CI failure and rerun the required checks." }];
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
    const nextPhase = result.outcome === "completed" ? "delivery_ready" : "delivery_blocked";
    ctx.state = contracts.IssueWorkflowStateSchema.parse({ ...ctx.state, revision: ctx.state.revision + 1, phase: nextPhase, owner: result.outcome === "completed" ? "lead" : "human", allowedCommands: result.outcome === "completed" ? ["review_delivery", "cancel_issue"] : ["record_delivery_decision", "cancel_issue"], pendingAction: result.outcome === "completed" ? "Reviewing the changes" : "Needs your call", developerExecutionId: result.developerExecutionId, developerSessionRef: result.developerSessionRef, worktreePath: ctx.state.worktreePath, branchName: result.branchName, targetBaseSha: result.subject.targetBaseSha, resultCommit: result.resultCommit, resultTree: result.resultTree, dirtyState: result.dirtyState, deliveryArtifactId: result.outcome === "completed" ? result.deliveryArtifactId : ctx.state.deliveryArtifactId, developerEvidenceArtifactId: result.evidenceArtifactId, deliverySummary: result.outcome === "completed" ? result.summary : ctx.state.deliverySummary, developerOutcome: result.outcome, repairCycle: result.cycle, activeOperation: null, deliveryReviewId: result.outcome === "completed" ? null : ctx.state.deliveryReviewId, deliveryRepairPlan: null, deliveryRepairPlanArtifactId: repairPlan.planArtifactId, deliveryRepairAuthority: result.outcome === "completed" ? null : "ci_failure", releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, ciNextPollAt: null, finalReviewId: null, finalReviewOutcome: null, acceptanceId: null, lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}` });
    await ctx.project();
    return ctx.state;
  }), { validator(rawInput) { const command = contracts.StartPlanningInputSchema.parse(rawInput); if (command.expectedRevision !== ctx.state.revision) throw new Error("Stale workflow revision"); if ((ctx.state.phase !== "ci_repair_required" && !(ctx.state.phase === "delivery_blocked" && ctx.state.allowedCommands.includes("repair_ci"))) || !ctx.state.developerExecutionId) throw new Error("CI repair is not available in the current phase"); } });

  ctx.reconcileCiTurn = reconcileCiTurn;
  (ctx as IssueWorkflowContext & { retryCiRepair?: (input: contracts.StartPlanningInput) => Promise<contracts.IssueWorkflowState> }).retryCiRepair = async () => runExactCiRepairTurn();
}
