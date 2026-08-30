import { isCancellation, log, runExecution, sleep } from "../registry.js";
import { ActivityFailure, ApplicationFailure } from "../failures.js";

import {
  AttentionCategorySchema,
  IssueWorkflowStateSchema,
  type IssueWorkflowState,
  type LeadPlanningResult,
  type StartPlanningInput,
} from "../issue-contracts.js";
import { repairDelivery, reviewDelivery } from "./register-delivery-review.js";
import { startDevelopment } from "./register-development.js";
import { resolveMergeConflict } from "./register-merge.js";
import { evidencePointer, humanBlocker } from "./state-transitions.js";
import { TERMINAL_PHASES } from "../../issue-phases.js";
import type { IssueWorkflowContext, StateRef } from "./context.js";

export type RepairFailureClass = "transient_infrastructure" | "rate_limited" | "credential_missing" | "code_failure" | "ci_failure" | "merge_conflict_mechanical" | "product_ambiguity" | "no_progress";

export function classifyRepairFailure(input: { code: string | null; category?: string | null; summary: string; source: "local_check" | "ci" | "merge" | "review" }): RepairFailureClass {
  if (["login-expired", "unauthenticated"].includes(input.code ?? "") || input.category === "provider_authentication") return "credential_missing";
  if (["rate-limited", "capacity-exhausted", "capacity_unavailable"].includes(input.code ?? "")) return "rate_limited";
  if (["model-unavailable", "provider-unavailable", "activity-failed", "timeout", "repair-infrastructure-failure", "ci-provider-unavailable"].includes(input.code ?? "") || input.category === "provider_connectivity_exhausted") return "transient_infrastructure";
  if (input.source === "merge") return input.code === "product-decision-required" ? "product_ambiguity" : "merge_conflict_mechanical";
  if (input.source === "ci") return "ci_failure";
  return "code_failure";
}

export function isoEpochMillis(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146097 + dayOfEra - 719468;
  return days * 86_400_000 + Number(match[4]) * 3_600_000 + Number(match[5]) * 60_000 + Number(match[6]) * 1_000 + Number((match[7] ?? "").padEnd(3, "0") || 0);
}

export function leadResultKind(result: LeadPlanningResult): "plan" | "decision_blocker" {
  return "kind" in result ? result.kind : result.leadOutputKind;
}

export function leadResultMaterial(result: LeadPlanningResult): boolean {
  return leadResultKind(result) === "plan" && "material" in result ? result.material : false;
}

export function leadResultCategories(result: LeadPlanningResult) {
  return leadResultKind(result) === "plan" && "materialCategories" in result ? result.materialCategories : [];
}

export function applyLeadResult(state: IssueWorkflowState, result: LeadPlanningResult): IssueWorkflowState {
  const kind = leadResultKind(result);
  const common = {
    leadSessionRef: result.leadSessionRef,
    leadExecutionId: result.leadExecutionId,
    leadEvidenceArtifactId: result.leadEvidenceArtifactId,
    leadOutputArtifactId: result.leadOutputArtifactId,
    leadOutputKind: kind,
    leadSummary: result.leadSummary,
    ...(("leadEvidenceSha256" in result && result.leadEvidenceSha256) ? { leadEvidenceSha256: result.leadEvidenceSha256 } : {}),
    ...(("leadOutputSha256" in result && result.leadOutputSha256) ? { leadOutputSha256: result.leadOutputSha256 } : {}),
    ...(("leadInputManifestArtifactId" in result && result.leadInputManifestArtifactId) ? { leadInputManifestArtifactId: result.leadInputManifestArtifactId } : {}),
    ...(("leadInputManifestSha256" in result && result.leadInputManifestSha256) ? { leadInputManifestSha256: result.leadInputManifestSha256 } : {}),
  };
  if (kind === "decision_blocker") {
    return IssueWorkflowStateSchema.parse({
      ...state,
      ...common,
      phase: "blocked",
      owner: "human",
      allowedCommands: ["resolve_decision_blocker", "cancel_issue"],
      pendingAction: "Needs your call",
      blockedCategory: "human_decision",
      blockedResumePhase: "planning",
      blockerArtifactId: result.leadOutputArtifactId,
      blockerArtifactSha256: "leadOutputSha256" in result ? result.leadOutputSha256 : null,
      planRevision: null,
      planMaterial: null,
      materialCategories: [],
    });
  }
  return IssueWorkflowStateSchema.parse({
    ...state,
    ...common,
    planRevision: state.revision,
    planMaterial: leadResultMaterial(result),
    materialCategories: leadResultCategories(result),
    blockedCategory: null,
    blockedResumePhase: null,
    blockerArtifactId: null,
    blockerArtifactSha256: null,
  });
}

export function applyLegacyLeadResult(state: IssueWorkflowState, result: LeadPlanningResult): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...state,
    ...result,
    planRevision: state.revision,
    planMaterial: leadResultMaterial(result),
    materialCategories: leadResultCategories(result),
  });
}

export function permanentActivityFailure(error: unknown, recoverExhausted = false): IssueWorkflowContext["permanentActivityFailure"] extends (error: unknown) => infer Result ? Result : never {
  if (error instanceof ApplicationFailure && error.nonRetryable) {
    return { code: error.type ?? "permanent-activity-failure", summary: error.message || "The invocation cannot complete without a configuration change." };
  }
  if (!(error instanceof ActivityFailure)) return undefined;
  if (!(error.cause instanceof ApplicationFailure) || !error.cause.nonRetryable) {
    return recoverExhausted ? { code: "activity-failed", summary: "The operation failed after its retry attempts." } : undefined;
  }
  const detail = error.cause.details?.[0];
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.summary === "string") {
      const category = AttentionCategorySchema.safeParse(record.category);
      return { code: record.code, summary: record.summary, ...(category.success ? { category: category.data } : {}), ...(typeof record.evidenceArtifactId === "string" ? { evidenceArtifactId: record.evidenceArtifactId } : {}), ...(typeof record.evidenceSha256 === "string" ? { evidenceSha256: record.evidenceSha256 } : {}) };
    }
  }
  return { code: error.cause.type ?? "permanent-activity-failure", summary: "The invocation cannot complete without a configuration change." };
}

export function rateLimitFailure(error: unknown): { retryAt?: string } | undefined {
  if (!(error instanceof ActivityFailure) || !(error.cause instanceof ApplicationFailure) || error.cause.type !== "rate-limited") return undefined;
  const detail = error.cause.details?.[0];
  if (!detail || typeof detail !== "object") return {};
  const retryAt = (detail as Record<string, unknown>).retryAt;
  return typeof retryAt === "string" ? { retryAt } : {};
}

export function failureBlockCategory(code: string): "authentication" | "configuration" | "capacity" | "execution_ownership" | undefined {
  if (["login-expired", "unauthenticated"].includes(code)) return "authentication";
  if (["model-unavailable", "profile-unavailable", "scope_configuration", "version_incompatible"].includes(code)) return "configuration";
  if (["capacity_unavailable", "capacity-exhausted", "rate-limited"].includes(code)) return "capacity";
  if (code === "session_identity_conflict") return "execution_ownership";
  return undefined;
}

export function createAcquireExternalTurn(
  stateRef: StateRef,
  options: { projectState: (state: IssueWorkflowState) => Promise<IssueWorkflowState> },
): IssueWorkflowContext["acquireExternalTurn"] {
  const acquire: IssueWorkflowContext["acquireExternalTurn"] = async (_spec, run) => {
    const state = stateRef.get();
    stateRef.set(IssueWorkflowStateSchema.parse({ ...state, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
    await options.projectState(stateRef.get());
    return run(undefined);
  };
  return acquire;
}

// Forge is a single-operator tool: a phase whose next step is an agent turn must not park
// on a button. The human gates stay plan approval and pull-request handling.
const AUTO_CHAINED_COMMANDS = { delivery_ready: "review_delivery", delivery_reviewed: "publish_draft", repair_required: "repair_delivery", merge_conflict_required: "resolve_merge_conflict", ready_for_development: "start_development" } as const;

// A chained step that threw is never chained again in this run: the phase may re-enter itself
// (plan conflict -> required -> resolve throws -> plan conflict ...) and each pass has a new revision.
const haltedChains = new Set<string>();
const chainKey = (workflowId: string, command: string) => `${workflowId}:${command}`;

export function clearAutomaticChainHalt(workflowId: string): void {
  for (const key of haltedChains) if (key.startsWith(`${workflowId}:`)) haltedChains.delete(key);
}
const AUTO_RETRY_BLOCKER_DELAYS = [30_000, 120_000, 300_000] as const;
const AUTO_RETRY_BLOCKER_COMMANDS = new Set(["review_delivery", "repair_delivery", "repair_ci", "final_review", "accept_delivery", "reconcile_acceptance", "reconcile_merge", "retry_target_base_reconciliation"]);

// Human decision gates: the member is choosing, not handing work to an agent, so a failure inside one of
// these is retried in place by the guarded fallback below.
const DECISION_COMMANDS = new Set(["approve_plan", "accept_delivery", "request_delivery_changes", "record_delivery_decision", "reconcile_acceptance", "reconcile_merge"]);
const CAPACITY_FAILURE_CODES = new Set(["not-found", "not-owner", "duplicate", "conflict", "stale-revision", "profile-unavailable", "invalid-status", "deadline-exhausted"]);

export function autoChainedCommand(ctx: IssueWorkflowContext, patchId: string): { command: string; commandId: string } | null {
  void patchId;
  const command = AUTO_CHAINED_COMMANDS[ctx.state.phase as keyof typeof AUTO_CHAINED_COMMANDS];
  if (!command || !ctx.state.allowedCommands.includes(command) || !true) return null;
  if (command === "resolve_merge_conflict" && ctx.state.mergeDecision) return null;
  // Routine (non-material) plans land in ready_for_development without going through autoApprovePlan's
  // auto-start, so this table entry needs its own gate to keep old histories that parked here replayable.
  if (ctx.state.phase === "ready_for_development" && !true) return null;
  if (haltedChains.has(chainKey(ctx.state.workflowId, command)) && true) return null;
  if (runExecution.current().autoActionsHalted()) return null;
  const commandId = `${ctx.state.workflowId}:auto-${command}:${ctx.state.revision}`;
  return ctx.commandAlreadyProcessed(commandId) ? null : { command, commandId };
}

export async function runAutoChainedCommand(ctx: IssueWorkflowContext, chained: { command: string; commandId: string }): Promise<void> {
  // Marked before the turn runs: a chained step that throws must not spin the Workflow loop.
  // start_development is the exception: it already gates on commandAlreadyProcessed at its own
  // entry and marks itself once its state mutation lands, so pre-marking here would make it a
  // silent no-op before it ever runs.
  if (chained.command !== "start_development") ctx.markCommandProcessed(chained.commandId);
  const before = { phase: ctx.state.phase, owner: ctx.state.owner, pendingAction: ctx.state.pendingAction };
  const command = { expectedRevision: ctx.state.revision, actorUserId: ctx.input.autoMergeActorUserId ?? ctx.input.autoApprovePlanActorUserId ?? "forge-auto-chain", commandId: chained.commandId };
  let failure: unknown;
  try {
    if (chained.command === "review_delivery") await reviewDelivery(ctx, command);
    else if (chained.command === "publish_draft") await ctx.runPublishTurn();
    else if (chained.command === "repair_delivery") await repairDelivery(ctx, command);
    else if (chained.command === "start_development") await startDevelopment(ctx, command);
    else await resolveMergeConflict(ctx, command);
  } catch (error) {
    failure = error;
  }
  const unchanged = ctx.state.phase === before.phase && ctx.state.owner === before.owner && ctx.state.pendingAction === before.pendingAction;
  if (!failure && !unchanged) return;
  const reason = failure instanceof Error ? failure.message : failure ? String(failure) : `Automatic ${chained.command.replaceAll("_", " ")} made no progress`;
  haltedChains.add(chainKey(ctx.state.workflowId, chained.command));
  ctx.state = IssueWorkflowStateSchema.parse({
    ...ctx.state,
    revision: ctx.state.revision + 1,
    owner: "human",
    allowedCommands: [...new Set([...ctx.state.allowedCommands, "cancel_issue"])],
    pendingAction: reason.slice(0, 256),
    lastHandlerError: { command: chained.command, reason: reason.slice(0, 256), at: new Date().toISOString() },
    stateChangedAt: new Date().toISOString(),
    lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`,
  });
  await ctx.project();
}

function retryOnlyBlockerCommand(ctx: IssueWorkflowContext): "review_delivery" | "repair_delivery" | "repair_ci" | "final_review" | "accept_delivery" | "reconcile_acceptance" | "reconcile_merge" | "retry_target_base_reconciliation" | null {
  if (ctx.state.phase !== "delivery_blocked") return null;
  const nonDestructive = ctx.state.allowedCommands.filter((command) => command !== "cancel_issue");
  const command = nonDestructive[0];
  if (nonDestructive.length !== 1 || !command || !AUTO_RETRY_BLOCKER_COMMANDS.has(command)) return null;
  return command as "review_delivery" | "repair_delivery" | "repair_ci" | "final_review" | "accept_delivery" | "reconcile_acceptance" | "reconcile_merge" | "retry_target_base_reconciliation";
}

function retryScope(ctx: IssueWorkflowContext, command: string): string | null {
  if (command === "review_delivery") return ctx.state.resultCommit ?? null;
  if (command === "repair_delivery" || command === "repair_ci") return ctx.state.resultCommit ?? null;
  if (command === "retry_target_base_reconciliation") return ctx.state.targetBaseCheckId ?? null;
  return ctx.state.acceptanceId ?? ctx.state.releaseId ?? null;
}

export function canAutoRetryDeliveryBlocker(ctx: IssueWorkflowContext): boolean {
  if (runExecution.current().autoActionsHalted()) return false;
  if (!true) return false;
  const command = retryOnlyBlockerCommand(ctx);
  const scope = command ? retryScope(ctx, command) : null;
  if (!command || !scope) return false;
  const prefix = `${ctx.state.workflowId}:auto-retry:${command}:${scope}:`;
  const attempt = (ctx.state.processedCommandIds ?? []).filter((id) => id.startsWith(prefix)).length;
  return attempt < AUTO_RETRY_BLOCKER_DELAYS.length;
}

export async function autoRetryDeliveryBlocker(ctx: IssueWorkflowContext): Promise<boolean> {
  if (!canAutoRetryDeliveryBlocker(ctx)) {
    const command = retryOnlyBlockerCommand(ctx);
    if (command && true) {
      const summary = ctx.state.deliveryRepairBlockerSummary ?? "Temporary provider failure persisted after automatic retries.";
      // Record the exhausted blocker once; re-projecting it on every loop pass is a hot loop.
      // humanBlocker() returns null without evidence, so the projected blocker cannot be the guard.
      if (ctx.state.owner === "human" && ctx.state.pendingAction === summary && ctx.state.allowedCommands.includes(command)) return false;
      ctx.state = IssueWorkflowStateSchema.parse({
        ...ctx.state,
        revision: ctx.state.revision + 1,
        owner: "human",
        allowedCommands: [command, "cancel_issue"],
        pendingAction: summary,
        blocker: humanBlocker("provider_connectivity_exhausted", summary, [{ command, label: "Retry now", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(ctx.state.deliveryRepairBlockerEvidenceArtifactId ?? ctx.state.ciEvidenceArtifactId ?? undefined, "attention-evidence")),
        stateChangedAt: new Date().toISOString(),
        lastEventId: `${ctx.state.workflowId}:${ctx.state.revision + 1}`,
      });
      await ctx.project();
      return true;
    }
    return false;
  }
  const command = retryOnlyBlockerCommand(ctx)!;
  const scope = retryScope(ctx, command)!;
  const prefix = `${ctx.state.workflowId}:auto-retry:${command}:${scope}:`;
  const attempt = (ctx.state.processedCommandIds ?? []).filter((id) => id.startsWith(prefix)).length;
  const commandId = `${prefix}${attempt + 1}`;
  if (ctx.commandAlreadyProcessed(commandId)) return false;
  ctx.markCommandProcessed(commandId);
  await sleep(AUTO_RETRY_BLOCKER_DELAYS[attempt]!);
  if (ctx.state.phase !== "delivery_blocked" || retryOnlyBlockerCommand(ctx) !== command || retryScope(ctx, command) !== scope) return true;
  const input = { expectedRevision: ctx.state.revision, actorUserId: ctx.input.autoMergeActorUserId ?? ctx.input.autoApprovePlanActorUserId ?? "forge-auto-retry", commandId };
  if (command === "review_delivery") await reviewDelivery(ctx, input);
  else if (command === "repair_delivery") await repairDelivery(ctx, input);
  else if (command === "repair_ci") await (ctx as IssueWorkflowContext & { retryCiRepair?: (input: StartPlanningInput) => Promise<IssueWorkflowState> }).retryCiRepair?.(input);
  else if (command === "final_review") await ctx.runFinalReviewTurn();
  else if (command === "accept_delivery") await ctx.retryAcceptDelivery(input);
  else if (command === "reconcile_acceptance") await ctx.reconcileAcceptanceTurn();
  else if (command === "retry_target_base_reconciliation") await ctx.retryTargetBaseReconciliation(input);
  else await ctx.reconcileMergeTurn();
  return true;
}

// A rejected update handler must never leave the Workflow holding mutated state
// that the projection never saw: recover to a retryable failed state and project it.
export function createGuarded(
  store: { get: () => IssueWorkflowState; set: (next: IssueWorkflowState) => void },
  options: { enabled: boolean; reviseContinueEnabled: boolean; failedRetryEnabled: boolean; project: (state: IssueWorkflowState) => Promise<unknown> },
) {
  return <A extends unknown[], R>(fn: (...args: A) => Promise<R>, command?: string) => async (...args: A): Promise<R> => {
    const before = store.get();
    try {
      const result = await fn(...args);
      const commandId = (args[0] as { commandId?: unknown } | undefined)?.commandId;
      const automatic = typeof commandId === "string" && commandId.startsWith(`${before.workflowId}:auto-`);
      if (!automatic && store.get().lastHandlerError) {
        const cleared = IssueWorkflowStateSchema.parse({ ...store.get(), lastHandlerError: null });
        store.set(cleared);
        await options.project(cleared);
        return cleared as R;
      }
      return result;
    } catch (error) {
      const state = store.get();
      if (isCancellation(error)) throw error;
      // Update handlers run while replaying every accepted update in history.
      // A plain Error is a programming/precondition failure, not an update
      // rejection; letting it escape fails the Workflow Task and wedges the
      // entire run. New commands must reject in validators, while an accepted
      // legacy command safely reports the state it reached.
      if (!(error instanceof ApplicationFailure)) {
        const reason = error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256);
        log.warn("Ignoring non-ApplicationFailure from update handler", {
          command: command ?? "unknown",
          reason,
        });
        const recorded = IssueWorkflowStateSchema.parse({ ...state, lastHandlerError: { command: command ?? "unknown", reason, at: new Date().toISOString() } });
        store.set(recorded);
        await options.project(recorded);
        return recorded as R;
      }
      if (!options.enabled || state === before) throw error;
      const failure = permanentActivityFailure(error, true);
      const summary = failure?.summary ?? "The command failed; retry is available";
      const revision = state.revision + 1;
      // A failed human decision gate returns the member to that same decision so the command can be retried,
      // instead of collapsing a late-stage failure (e.g. a rejected GitHub merge) into "re-plan from scratch".
      // Gated on the invoked command itself, not merely offered by the prior state: a Lead-turn command issued
      // from a state that also offers a decision command must not revert and discard mutations it already made.
      if (before.owner === "human" && !TERMINAL_PHASES.has(before.phase) && command !== undefined && DECISION_COMMANDS.has(command)) {
        const retry = before.allowedCommands.filter((command) => command !== "cancel_issue").map((command) => ({ command, label: `Retry ${command.replace(/_/g, " ")}`, requiresNote: ["reject_plan", "record_delivery_decision", "request_delivery_changes"].includes(command), destructive: false }));
        const reverted = IssueWorkflowStateSchema.parse({
          ...before,
          revision,
          pendingAction: summary,
          blocker: failure?.category ? humanBlocker(failure.category, summary, [...retry, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : before.blocker,
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${state.workflowId}:${revision}`,
        });
        store.set(reverted);
        await options.project(reverted);
        throw error;
      }
      // Capacity ledger conflicts are Forge bookkeeping failures.  They must
      // always land on an actionable retry, never the terminal failed phase.
      if (failure && CAPACITY_FAILURE_CODES.has(failure.code)) {
        const retryDevelopment = command === "start_development" || command === "retry_development";
        const retryCi = command === "repair_ci";
        const phase = retryDevelopment ? "delivery_blocked" : retryCi ? "ci_repair_required" : "backlog";
        const allowedCommands = retryDevelopment ? ["retry_development", "cancel_issue"] : retryCi ? ["repair_ci", "cancel_issue"] : ["start_planning", "cancel_issue"];
        const nextAction = retryDevelopment ? "retry development" : retryCi ? "retry CI repair" : "retry planning";
        const pendingAction = `${failure.summary} Forge reconciled the capacity record; ${nextAction}.`;
        const retryable = IssueWorkflowStateSchema.parse({
          ...state,
          capacity: null,
          capacityBlocker: null,
          phase,
          revision,
          owner: "human",
          allowedCommands,
          pendingAction,
          blocker: null,
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${state.workflowId}:${revision}`,
        });
        store.set(retryable);
        await options.project(retryable);
        throw error;
      }
      const canRetryDevelopment = options.failedRetryEnabled
        && state.planMaterial === true
        && Boolean(state.leadOutputArtifactId)
        && Boolean(state.leadSessionRef);
      const allowedCommands = canRetryDevelopment
        ? ["retry_development", "start_planning", ...(options.reviseContinueEnabled ? ["continue_work"] : []), "cancel_issue"]
        : options.reviseContinueEnabled ? ["start_planning", "continue_work", "cancel_issue"] : ["start_planning", "cancel_issue"];
      const retryActions = canRetryDevelopment
        ? [{ command: "retry_development" as const, label: "Retry development", requiresNote: false, destructive: false }, { command: "start_planning" as const, label: "Start planning", requiresNote: false, destructive: false }]
        : [{ command: "start_planning" as const, label: "Retry planning", requiresNote: false, destructive: false }];
      const next = IssueWorkflowStateSchema.parse({
        ...state,
        capacity: null,
        capacityBlocker: null,
        phase: "failed",
        revision,
        owner: "human",
        allowedCommands,
        pendingAction: summary,
        blocker: failure?.category ? humanBlocker(failure.category, summary, [...retryActions, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : null,
        stateChangedAt: new Date().toISOString(),
        lastEventId: `${state.workflowId}:${revision}`,
      });
      store.set(next);
      await options.project(next);
      throw error;
    }
  };
}
