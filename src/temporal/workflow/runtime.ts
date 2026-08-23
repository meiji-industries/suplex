import { ActivityFailure, ApplicationFailure, isCancellation, log, sleep } from "@temporalio/workflow";

import type { CapacityOperation, CapacityRole } from "../../capacity-contracts.js";
import {
  AttentionCategorySchema,
  IssueWorkflowStateSchema,
  type IssueWorkflowState,
  type LeadPlanningResult,
} from "../issue-contracts.js";
import { cancelCapacityExecution, finalizeCapacity, inspectCapacity, rateLimitCapacity, requestCapacity, requeueCapacity, tryAcquireCapacity } from "./activity-proxies.js";
import { repairDelivery, reviewDelivery } from "./register-delivery-review.js";
import { startDevelopment } from "./register-development.js";
import { resolveMergeConflict } from "./register-merge.js";
import { evidencePointer, humanBlocker } from "./state-transitions.js";
import { TERMINAL_PHASES } from "../../issue-phases.js";
import type { IssueWorkflowContext, StateRef } from "./context.js";

export function compactStateForContinuation(state: IssueWorkflowState): IssueWorkflowState {
  const compact = { ...state, activeOperation: null } as Record<string, unknown>;
  for (const key of ["worktreePath", "deliveryBlockingFindings", "deliveryRepairPlan", "forwardMergeConflictFiles", "forwardMergeConflictDiff", "conflictFiles", "conflictDiff"]) delete compact[key];
  return IssueWorkflowStateSchema.parse(compact);
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
  options: {
    projectState: (state: IssueWorkflowState) => Promise<IssueWorkflowState>;
    projectCapacityState: (capacity: IssueWorkflowState["capacity"], pendingAction?: string) => Promise<number>;
    patched: (patchId: string) => boolean;
    durableCapacityPatch: string;
    capacityFinalizationOwnershipPatch: string;
    capacityReadmissionPatch: string;
  },
): IssueWorkflowContext["acquireExternalTurn"] {
  return async <T>(spec: { operation: CapacityOperation; role: CapacityRole; profileId?: string | undefined; sessionRef?: string | null | undefined; worktreePath?: string | null | undefined }, run: (capacityRequestId?: string) => Promise<T>, executionId: (result: T) => string | undefined, durableCapacityEnabled = options.patched(options.durableCapacityPatch)): Promise<T> => {
    if (options.patched("forge-simple-capacity-v1")) {
      const state = stateRef.get();
      stateRef.set(IssueWorkflowStateSchema.parse({ ...state, pendingAction: "Waiting for a free agent slot", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
      await options.projectState(stateRef.get());
      return run(undefined);
    }
    if (!durableCapacityEnabled) return run(undefined);
    if (!spec.profileId) throw ApplicationFailure.nonRetryable("profile_unavailable", "profile_unavailable", { operation: spec.operation, role: spec.role });
    // A cancelled/interrupted turn can leave its released request in durable
    // workflow state.  Never carry that terminal id into the next admission.
    const storedCapacity = stateRef.get().capacity;
    if (options.patched(options.capacityReadmissionPatch) && storedCapacity) {
      const stored = await inspectCapacity({ requestId: storedCapacity.requestId });
      if (stored.status !== "active") await options.projectCapacityState(null);
    }
    const turnRevision = stateRef.get().revision;
    const expectedPhase = stateRef.get().phase;
    const commandsBeforeWait = stateRef.get().allowedCommands;
    let observedRevision = stateRef.get().revision;
    const isCurrent = (): boolean => stateRef.get().phase === expectedPhase && stateRef.get().revision === observedRevision;
    const assertCurrent = (): void => { if (!isCurrent()) throw new Error("External turn became stale"); };
    const abandonStaleRequest = async (): Promise<void> => {
      const current = await inspectCapacity({ requestId: request.id });
      if (["queued", "rate_limited", "active"].includes(current.status)) await cancelCapacityExecution({ requestId: request.id });
    };
    const request = await requestCapacity({ logicalTurnKey: `${stateRef.get().workflowId}:${turnRevision}:${spec.operation}`, companyId: stateRef.get().companyId, taskId: stateRef.get().issueId, workflowId: stateRef.get().workflowId, projectRevisionId: stateRef.get().projectRevisionId, workflowRevision: turnRevision, operation: spec.operation, role: spec.role, profileId: spec.profileId, sessionRef: spec.sessionRef ?? null, worktreePath: spec.worktreePath ?? null });
    if (!isCurrent()) { await abandonStaleRequest(); throw new Error("External turn became stale"); }
    for (;;) {
      if (!isCurrent()) { await abandonStaleRequest(); throw new Error("External turn became stale before admission"); }
      const admission = await tryAcquireCapacity({ requestId: request.id, expectedWorkflowRevision: turnRevision });
      if (!isCurrent()) { await abandonStaleRequest(); throw new Error("External turn became stale after admission"); }
      const state = stateRef.get();
      if ((admission.status === "queued" || admission.status === "rate_limited") && state.allowedCommands.some((command) => !["cancel_issue", "cancel_development"].includes(command))) {
        const waitingCommands = state.allowedCommands.filter((command) => command === "cancel_issue" || command === "cancel_development");
        stateRef.set(IssueWorkflowStateSchema.parse({ ...state, allowedCommands: waitingCommands, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
        observedRevision = stateRef.get().revision;
        await options.projectState(stateRef.get());
      }
      observedRevision = await options.projectCapacityState(admission.publicState, admission.status === "queued" ? "Waiting for external capacity" : admission.status === "rate_limited" ? "Waiting for provider reset" : stateRef.get().pendingAction ?? undefined);
      if (!isCurrent()) { await abandonStaleRequest(); throw new Error("External turn became stale after projection"); }
      if (admission.status === "active") {
        const activeState = stateRef.get();
        if (activeState.allowedCommands.length !== commandsBeforeWait.length || activeState.allowedCommands.some((command, index) => command !== commandsBeforeWait[index])) {
          stateRef.set(IssueWorkflowStateSchema.parse({ ...activeState, allowedCommands: commandsBeforeWait, revision: activeState.revision + 1, lastEventId: `${activeState.workflowId}:${activeState.revision + 1}` }));
          observedRevision = stateRef.get().revision;
          await options.projectState(stateRef.get());
        }
        assertCurrent();
        try {
          const result = await run(request.id);
          assertCurrent();
          const current = await inspectCapacity({ requestId: request.id });
          assertCurrent();
          const resultExecutionId = executionId(result);
          if (current.executionId && resultExecutionId && current.executionId !== resultExecutionId) throw ApplicationFailure.nonRetryable("capacity_owner_mismatch", "capacity_owner_mismatch", { requestId: request.id });
          // Deprecated: this marker replaced forge-capacity-ownership-clear-v1
          // briefly. Both calls must remain at this position for persisted runs.
          void options.patched("forge-no-ownership-v2");
          if ((current as { status: string }).status === "ownership_ambiguous" && !options.patched("forge-capacity-ownership-clear-v1")) {
            observedRevision = await options.projectCapacityState({ ...(admission.publicState as object), status: "ownership_ambiguous", position: null, reason: null, retryAt: null } as unknown as IssueWorkflowState["capacity"], "Needs a retry");
            return result;
          }
          if (["released", "cancelled", "stale", "exhausted"].includes(current.status) && options.patched(options.capacityReadmissionPatch)) {
            observedRevision = await options.projectCapacityState(null);
            return result;
          }
          const ownerId = current.executionId;
          const resultStatus = result && typeof result === "object" && "status" in result ? (result as { status?: unknown }).status : undefined;
          await finalizeCapacity({ requestId: request.id, expectedExecutionId: ownerId ?? request.id, terminalReason: ownerId ? resultStatus && resultStatus !== "completed" ? "process_failed" : "completed" : "failed_before_start" });
          assertCurrent();
          observedRevision = await options.projectCapacityState(null);
          return result;
        } catch (error) {
          if (!isCurrent()) throw error;
          const current = await inspectCapacity({ requestId: request.id });
          if (current.status !== "active" && options.patched(options.capacityFinalizationOwnershipPatch)) throw error;
          const rateLimit = rateLimitFailure(error);
          if (rateLimit && current.executionId) {
            const limited = await rateLimitCapacity({ requestId: request.id, executionId: current.executionId, ...(rateLimit.retryAt ? { retryAt: rateLimit.retryAt } : {}) });
            if (limited.status === "exhausted") {
              const state = stateRef.get();
              const blocker = { category: "capacity_exhausted" as const, summary: "No agent slots are free.", nextAction: "Retry or cancel the issue.", resumeOperation: spec.operation };
              stateRef.set(IssueWorkflowStateSchema.parse({ ...state, capacity: { ...admission.publicState, status: "exhausted", position: null, reason: null, retryAt: null, rateLimitAttempts: limited.rateLimitAttempts }, capacityBlocker: blocker, allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: "Waiting for a free agent slot", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
              observedRevision = stateRef.get().revision;
              await options.projectState(stateRef.get());
              throw ApplicationFailure.nonRetryable("capacity_exhausted", "capacity_exhausted", blocker);
            }
            observedRevision = await options.projectCapacityState({ ...admission.publicState, status: "rate_limited", position: null, reason: "rate_limit_reset", retryAt: limited.retryAt, rateLimitAttempts: limited.rateLimitAttempts }, "Waiting for provider reset");
            continue;
          }
          await finalizeCapacity({ requestId: request.id, expectedExecutionId: current.executionId ?? request.id, terminalReason: current.executionId ? "process_failed" : "failed_before_start" });
          throw error;
        }
      }
      if (admission.status === "exhausted") {
        const category = "capacity_exhausted" as const;
        const state = stateRef.get();
        stateRef.set(IssueWorkflowStateSchema.parse({ ...state, capacity: admission.publicState, capacityBlocker: { category, summary: "No agent slots are free.", nextAction: "Retry or cancel the issue.", resumeOperation: spec.operation }, allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: "Waiting for a free agent slot", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
        await options.projectState(stateRef.get());
        throw ApplicationFailure.nonRetryable(category, category, stateRef.get().capacityBlocker);
      }
      // Deprecated: see the matching completion-path marker above.
      void options.patched("forge-no-ownership-v2");
      if ((admission as { status: string }).status === "ownership_ambiguous" && !options.patched("forge-capacity-ownership-clear-v1")) {
        const state = stateRef.get();
        const legacyAdmission = admission as unknown as { publicState: IssueWorkflowState["capacity"] };
        stateRef.set({ ...state, capacity: legacyAdmission.publicState, capacityBlocker: { category: "ownership_ambiguous", summary: "Forge couldn't confirm the previous run.", nextAction: "Retry or cancel the issue.", resumeOperation: spec.operation } as unknown as IssueWorkflowState["capacityBlocker"], allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: "Needs a retry", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` });
        await options.projectState(stateRef.get());
        throw ApplicationFailure.nonRetryable("ownership_ambiguous", "ownership_ambiguous", stateRef.get().capacityBlocker);
      }
      const retryAt = admission.publicState.retryAt;
      const retryDelay = admission.status === "rate_limited" && retryAt ? Math.max(1_000, isoEpochMillis(retryAt) - Date.now()) : 5_000;
      await sleep(retryDelay);
      if (!isCurrent()) { await abandonStaleRequest(); throw new Error("External turn became stale while waiting for capacity"); }
      if (admission.status === "rate_limited") {
        await requeueCapacity({ requestId: request.id });
        if (!isCurrent()) { await abandonStaleRequest(); throw new Error("External turn became stale while requeueing capacity"); }
      }
    }
  };
}

// Forge is a single-operator tool: a phase whose next step is an agent turn must not park
// on a button. The human gates stay plan approval and pull-request handling.
const AUTO_CHAINED_COMMANDS = { delivery_ready: "review_delivery", delivery_reviewed: "publish_draft", repair_required: "repair_delivery", merge_conflict_required: "resolve_merge_conflict", ready_for_development: "start_development" } as const;

// A chained step that threw is never chained again in this run: the phase may re-enter itself
// (plan conflict -> required -> resolve throws -> plan conflict ...) and each pass has a new revision.
const haltedChains = new Set<string>();
const AUTO_RETRY_BLOCKER_DELAYS = [30_000, 120_000, 300_000] as const;
const AUTO_RETRY_BLOCKER_COMMANDS = new Set(["review_delivery", "final_review", "accept_delivery", "reconcile_acceptance", "reconcile_merge", "retry_target_base_reconciliation"]);

// Human decision gates: the member is choosing, not handing work to an agent, so a failure inside one of
// these is retried in place by the guarded fallback below.
const DECISION_COMMANDS = new Set(["approve_plan", "accept_delivery", "request_delivery_changes", "record_delivery_decision", "reconcile_acceptance", "reconcile_merge"]);
const CAPACITY_FAILURE_CODES = new Set(["not-found", "not-owner", "duplicate", "conflict", "stale-revision", "profile-unavailable", "invalid-status", "deadline-exhausted"]);

export function autoChainedCommand(ctx: IssueWorkflowContext, patchId: string): { command: string; commandId: string } | null {
  const command = AUTO_CHAINED_COMMANDS[ctx.state.phase as keyof typeof AUTO_CHAINED_COMMANDS];
  if (!command || !ctx.state.allowedCommands.includes(command) || !ctx.patched(patchId)) return null;
  // Routine (non-material) plans land in ready_for_development without going through autoApprovePlan's
  // auto-start, so this table entry needs its own gate to keep old histories that parked here replayable.
  if (ctx.state.phase === "ready_for_development" && !ctx.patched("forge-auto-start-routine-v1")) return null;
  if (haltedChains.has(command) && ctx.patched("forge-auto-chain-halt-v1")) return null;
  const commandId = `${ctx.state.workflowId}:auto-${command}:${ctx.state.revision}`;
  return ctx.commandAlreadyProcessed(commandId) ? null : { command, commandId };
}

export async function runAutoChainedCommand(ctx: IssueWorkflowContext, chained: { command: string; commandId: string }): Promise<void> {
  // Marked before the turn runs: a chained step that throws must not spin the Workflow loop.
  // start_development is the exception: it already gates on commandAlreadyProcessed at its own
  // entry and marks itself once its state mutation lands, so pre-marking here would make it a
  // silent no-op before it ever runs.
  if (chained.command !== "start_development") ctx.markCommandProcessed(chained.commandId);
  const command = { expectedRevision: ctx.state.revision, actorUserId: ctx.input.autoMergeActorUserId ?? ctx.input.autoApprovePlanActorUserId ?? "forge-auto-chain", commandId: chained.commandId };
  try {
    if (chained.command === "review_delivery") await reviewDelivery(ctx, command);
    else if (chained.command === "publish_draft") await ctx.runPublishTurn();
    else if (chained.command === "repair_delivery") await repairDelivery(ctx, command);
    else if (chained.command === "start_development") await startDevelopment(ctx, command);
    else await resolveMergeConflict(ctx, command);
  } catch {
    haltedChains.add(chained.command); // the manual button stays in allowedCommands for a retry
  }
}

function retryOnlyBlockerCommand(ctx: IssueWorkflowContext): "review_delivery" | "final_review" | "accept_delivery" | "reconcile_acceptance" | "reconcile_merge" | "retry_target_base_reconciliation" | null {
  if (ctx.state.phase !== "delivery_blocked") return null;
  const nonDestructive = ctx.state.allowedCommands.filter((command) => command !== "cancel_issue");
  const command = nonDestructive[0];
  if (nonDestructive.length !== 1 || !command || !AUTO_RETRY_BLOCKER_COMMANDS.has(command)) return null;
  return command as "review_delivery" | "final_review" | "accept_delivery" | "reconcile_acceptance" | "reconcile_merge" | "retry_target_base_reconciliation";
}

function retryScope(ctx: IssueWorkflowContext, command: string): string | null {
  if (command === "review_delivery") return ctx.state.resultCommit ?? null;
  if (command === "retry_target_base_reconciliation") return ctx.state.targetBaseCheckId ?? null;
  return ctx.state.acceptanceId ?? ctx.state.releaseId ?? null;
}

export function canAutoRetryDeliveryBlocker(ctx: IssueWorkflowContext): boolean {
  if (!ctx.patched("forge-auto-retry-blockers-v1")) return false;
  const command = retryOnlyBlockerCommand(ctx);
  const scope = command ? retryScope(ctx, command) : null;
  if (!command || !scope) return false;
  const prefix = `${ctx.state.workflowId}:auto-retry:${command}:${scope}:`;
  const attempt = (ctx.state.processedCommandIds ?? []).filter((id) => id.startsWith(prefix)).length;
  return attempt < AUTO_RETRY_BLOCKER_DELAYS.length;
}

export async function autoRetryDeliveryBlocker(ctx: IssueWorkflowContext): Promise<boolean> {
  if (!canAutoRetryDeliveryBlocker(ctx)) return false;
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
      return await fn(...args);
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
