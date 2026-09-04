import { at } from "../../issue-phases.js";
import { isCancellation, log } from "../registry.js";
import { ActivityFailure, ApplicationFailure } from "../failures.js";

import {
  AttentionCategorySchema,
  IssueWorkflowStateSchema,
  type IssueWorkflowState,
  type LeadPlanningResult,
} from "../issue-contracts.js";
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

export function applyLeadResult(state: IssueWorkflowState, result: LeadPlanningResult): IssueWorkflowState {
  const kind = leadResultKind(result);
  const common = {
    leadSessionRef: result.leadSessionRef,
    leadExecutionId: result.leadExecutionId,
    leadEvidenceArtifactId: result.leadEvidenceArtifactId,
    leadOutputArtifactId: result.leadOutputArtifactId,
    leadOutputKind: kind,
    leadSummary: result.leadSummary,
    ...(("leadInputManifestArtifactId" in result && result.leadInputManifestArtifactId) ? { leadInputManifestArtifactId: result.leadInputManifestArtifactId } : {}),
  };
  if (kind === "decision_blocker") {
    return IssueWorkflowStateSchema.parse({
      ...state,
      ...common,
      ...at("planning"),
      owner: "human",
      allowedCommands: ["resolve_decision_blocker", "cancel_issue"],
      pendingAction: "Your decision is necessary",
      blockedCategory: "human_decision",
      blockedResumePhase: "planning",
      blocker: humanBlocker("member_decision", "Your decision is necessary", [{ command: "resolve_decision_blocker", label: "Resolve the decision", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(result.leadOutputArtifactId, "decision-blocker")),
      blockerArtifactId: result.leadOutputArtifactId,
      planRevision: null,
    });
  }
  return IssueWorkflowStateSchema.parse({
    ...state,
    ...common,
    planRevision: state.revision,
    blockedCategory: null,
    blockedResumePhase: null,
    blockerArtifactId: null,
  });
}

export function applyLegacyLeadResult(state: IssueWorkflowState, result: LeadPlanningResult): IssueWorkflowState {
  return IssueWorkflowStateSchema.parse({
    ...state,
    ...result,
    planRevision: state.revision,
  });
}

export function permanentActivityFailure(error: unknown, recoverExhausted = false): IssueWorkflowContext["permanentActivityFailure"] extends (error: unknown) => infer Result ? Result : never {
  if (error instanceof ApplicationFailure && error.nonRetryable) {
    return { code: error.type, summary: error.message || "The invocation cannot complete without a configuration change." };
  }
  if (!(error instanceof ActivityFailure)) return undefined;
  if (!(error.cause instanceof ApplicationFailure) || !error.cause.nonRetryable) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return recoverExhausted ? { code: "activity-failed", summary: `The operation failed after its retry attempts: ${cause}` } : undefined;
  }
  const detail = error.cause.details[0];
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.summary === "string") {
      const category = AttentionCategorySchema.safeParse(record.category);
      return { code: record.code, summary: record.summary, ...(category.success ? { category: category.data } : {}), ...(typeof record.evidenceArtifactId === "string" ? { evidenceArtifactId: record.evidenceArtifactId } : {}), ...(typeof record.evidenceSha256 === "string" ? { evidenceSha256: record.evidenceSha256 } : {}) };
    }
  }
  return { code: error.cause.type, summary: "The invocation cannot complete without a configuration change." };
}

export function rateLimitFailure(error: unknown): { retryAt?: string } | undefined {
  if (!(error instanceof ActivityFailure) || !(error.cause instanceof ApplicationFailure) || error.cause.type !== "rate-limited") return undefined;
  const detail = error.cause.details[0];
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

const DECISION_COMMANDS = new Set(["approve_plan", "accept_delivery", "request_delivery_changes", "record_delivery_decision", "reconcile_acceptance", "reconcile_merge"]);
const CAPACITY_FAILURE_CODES = new Set(["not-found", "not-owner", "duplicate", "conflict", "stale-revision", "profile-unavailable", "invalid-status", "deadline-exhausted"]);

// A rejected update handler must never leave the Workflow holding mutated state
// that the projection never saw: recover to a retryable failed state and project it.
export function createGuarded(
  store: { get: () => IssueWorkflowState; set: (next: IssueWorkflowState) => void },
  options: { project: (state: IssueWorkflowState) => Promise<unknown> },
) {
  return <A extends unknown[], R>(fn: (...args: A) => Promise<R>, command?: string) => async (...args: A): Promise<R> => {
    const before = store.get();
    try {
      const commandId = (args[0] as { commandId?: unknown } | undefined)?.commandId;
      const automatic = typeof commandId === "string" && commandId.startsWith(`${before.workflowId}:auto-`);
      // Clearing a prior handler error changes the durable state, so it owns a
      // fresh revision before the next command can authorize an external effect.
      if (!automatic && before.lastHandlerError) {
        const revision = before.revision + 1;
        const cleared = IssueWorkflowStateSchema.parse({ ...before, revision, lastEventId: `${before.workflowId}:${revision}`, lastHandlerError: null });
        store.set(cleared);
        await options.project(cleared);
        const first = args[0];
        if (first && typeof first === "object") {
          const rebased = { ...first } as Record<string, unknown>;
          let changed = false;
          if ("expectedRevision" in first && first.expectedRevision === before.revision) { rebased.expectedRevision = revision; changed = true; }
          if ("expectedWorkflowRevision" in first && first.expectedWorkflowRevision === before.revision) { rebased.expectedWorkflowRevision = revision; changed = true; }
          if (changed) (args as unknown[])[0] = rebased;
        }
      }
      return await fn(...args);
    } catch (error) {
      const state = store.get();
      if (isCancellation(error)) throw error;
      const actorUserId = (args[0] as { actorUserId?: unknown } | undefined)?.actorUserId;
      if (actorUserId === "forge-driver" && error instanceof Error && /not available in the current phase/i.test(error.message)) {
        store.set(before);
        throw error;
      }
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
        const revision = state.revision + 1;
        const recorded = IssueWorkflowStateSchema.parse({ ...state, revision, lastEventId: `${state.workflowId}:${revision}`, lastHandlerError: { command: command ?? "unknown", reason, at: new Date().toISOString() } });
        store.set(recorded);
        await options.project(recorded);
        return recorded as R;
      }
      if (state === before) throw error;
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
          blocker: failure?.category ? humanBlocker(failure.category, summary, [...retry, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : before.blocker,
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
        const step = retryDevelopment ? "development" : retryCi ? "ci_waiting" : "backlog";
        const allowedCommands = retryDevelopment ? ["retry_development", "cancel_issue"] : retryCi ? ["repair_ci", "cancel_issue"] : ["start_planning", "cancel_issue"];
        const nextAction = retryDevelopment ? "retry development" : retryCi ? "retry CI repair" : "retry planning";
        const pendingAction = `${failure.summary} Forge reconciled the capacity record; ${nextAction}.`;
        const retryable = IssueWorkflowStateSchema.parse({
          ...state,
          capacity: null,
          capacityBlocker: null,
          ...at(step),
          revision,
          owner: "human",
          allowedCommands,
          pendingAction,
          blocker: humanBlocker("capacity_exhausted", pendingAction, allowedCommands.map((command) => ({ command: command as IssueWorkflowState["allowedCommands"][number], label: command === "cancel_issue" ? "Cancel the task" : `Retry ${command.replace(/_/g, " ")}`, requiresNote: false, destructive: command === "cancel_issue" })), evidencePointer(failure.evidenceArtifactId, "attention-evidence")),
          stateChangedAt: new Date().toISOString(),
          lastEventId: `${state.workflowId}:${revision}`,
        });
        store.set(retryable);
        await options.project(retryable);
        throw error;
      }
      const canRetryDevelopment = Boolean(state.leadOutputArtifactId)
        && Boolean(state.leadSessionRef);
      const allowedCommands = canRetryDevelopment
        ? ["retry_development", "start_planning", "continue_work", "cancel_issue"]
        : ["start_planning", "continue_work", "cancel_issue"];
      const retryActions = canRetryDevelopment
        ? [{ command: "retry_development" as const, label: "Retry development", requiresNote: false, destructive: false }, { command: "start_planning" as const, label: "Start planning", requiresNote: false, destructive: false }]
        : [{ command: "start_planning" as const, label: "Retry planning", requiresNote: false, destructive: false }];
      const next = IssueWorkflowStateSchema.parse({
        ...state,
        capacity: null,
        capacityBlocker: null,
        ...at(state.step),
        revision,
        owner: "human",
        allowedCommands,
        pendingAction: summary,
        blocker: failure?.category ? humanBlocker(failure.category, summary, [...retryActions, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidencePointer(failure.evidenceArtifactId, "attention-evidence")) : null,
        stateChangedAt: new Date().toISOString(),
        lastEventId: `${state.workflowId}:${revision}`,
      });
      store.set(next);
      await options.project(next);
      throw error;
    }
  };
}
