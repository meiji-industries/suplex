import { ActivityFailure, ApplicationFailure, sleep } from "@temporalio/workflow";

import type { CapacityOperation, CapacityRole } from "../../capacity-contracts.js";
import {
  AttentionCategorySchema,
  IssueWorkflowStateSchema,
  type IssueWorkflowState,
  type LeadPlanningResult,
} from "../issue-contracts.js";
import { cancelCapacityExecution, finalizeCapacity, inspectCapacity, rateLimitCapacity, requestCapacity, requeueCapacity, tryAcquireCapacity } from "./activity-proxies.js";
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
      pendingAction: "Human decision required by Lead",
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
  if (["ownership_ambiguous", "session_identity_conflict"].includes(code)) return "execution_ownership";
  return undefined;
}

export function createAcquireExternalTurn(
  stateRef: StateRef,
  options: {
    projectState: (state: IssueWorkflowState) => Promise<IssueWorkflowState>;
    projectCapacityState: (capacity: IssueWorkflowState["capacity"], pendingAction?: string) => Promise<number>;
    patched: (patchId: string) => boolean;
    durableCapacityPatch: string;
  },
): IssueWorkflowContext["acquireExternalTurn"] {
  return async <T>(spec: { operation: CapacityOperation; role: CapacityRole; profileId?: string | undefined; sessionRef?: string | null | undefined; worktreePath?: string | null | undefined }, run: (capacityRequestId?: string) => Promise<T>, executionId: (result: T) => string | undefined, durableCapacityEnabled = options.patched(options.durableCapacityPatch)): Promise<T> => {
    if (!durableCapacityEnabled) return run(undefined);
    if (!spec.profileId) throw ApplicationFailure.nonRetryable("profile_unavailable", "profile_unavailable", { operation: spec.operation, role: spec.role });
    const turnRevision = stateRef.get().revision;
    const expectedPhase = stateRef.get().phase;
    const commandsBeforeWait = stateRef.get().allowedCommands;
    let observedRevision = stateRef.get().revision;
    const isCurrent = (): boolean => stateRef.get().phase === expectedPhase && stateRef.get().revision === observedRevision;
    const assertCurrent = (): void => { if (!isCurrent()) throw new Error("External turn became stale"); };
    const abandonStaleRequest = async (): Promise<void> => {
      const current = await inspectCapacity({ requestId: request.id });
      if (["queued", "rate_limited", "active", "ownership_ambiguous"].includes(current.status)) await cancelCapacityExecution({ requestId: request.id });
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
          const ownerId = current.executionId;
          await finalizeCapacity({ requestId: request.id, expectedExecutionId: ownerId ?? request.id, terminalReason: ownerId ? "completed" : "failed_before_start" });
          assertCurrent();
          observedRevision = await options.projectCapacityState(null);
          return result;
        } catch (error) {
          if (!isCurrent()) throw error;
          const current = await inspectCapacity({ requestId: request.id });
          const rateLimit = rateLimitFailure(error);
          if (rateLimit && current.executionId) {
            const limited = await rateLimitCapacity({ requestId: request.id, executionId: current.executionId, ...(rateLimit.retryAt ? { retryAt: rateLimit.retryAt } : {}) });
            if (limited.status === "exhausted") {
              const state = stateRef.get();
              const blocker = { category: "capacity_exhausted" as const, summary: "External turn capacity was exhausted.", nextAction: "Retry capacity or cancel the issue.", resumeOperation: spec.operation };
              stateRef.set(IssueWorkflowStateSchema.parse({ ...state, capacity: { ...admission.publicState, status: "exhausted", position: null, reason: null, retryAt: null, rateLimitAttempts: limited.rateLimitAttempts }, capacityBlocker: blocker, allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: "Capacity retry required", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
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
      if (admission.status === "exhausted" || admission.status === "ownership_ambiguous") {
        const category = admission.status === "exhausted" ? "capacity_exhausted" : "ownership_ambiguous";
        const state = stateRef.get();
        stateRef.set(IssueWorkflowStateSchema.parse({ ...state, capacity: admission.publicState, capacityBlocker: { category, summary: category === "capacity_exhausted" ? "External turn capacity was exhausted." : "Forge cannot prove external process ownership.", nextAction: category === "capacity_exhausted" ? "Retry capacity or cancel the issue." : "Verify ownership before retrying or cancelling.", resumeOperation: spec.operation }, allowedCommands: ["retry_capacity", "cancel_issue"], owner: "human", pendingAction: category === "capacity_exhausted" ? "Capacity retry required" : "Ownership verification required", revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` }));
        await options.projectState(stateRef.get());
        throw ApplicationFailure.nonRetryable(category, category, stateRef.get().capacityBlocker);
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
