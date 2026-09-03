import { z } from "zod";

import { ISSUE_STEPS, TERMINAL_PHASES, isBlocked, phaseOf } from "../../../issue-phases.js";
import { IssueCommandSchema, normalizeSafeSummary } from "../primitives.js";
import { acceptanceStateFields } from "./acceptance.js";
import { capacityStateFields } from "./capacity.js";
import { ciStateFields } from "./ci.js";
import { deliveryReviewStateFields } from "./delivery-review.js";
import { developmentStateFields } from "./development.js";
import { developerRecoveryStateFields } from "./developer-recovery.js";
import { finalReviewStateFields } from "./final-review.js";
import { forwardMergeStateFields } from "./forward-merge.js";
import { governanceStateFields } from "./governance.js";
import { identityStateFields } from "./identity.js";
import { lifecycleStateFields } from "./lifecycle.js";
import { mergeStateFields, mergeStateFields2 } from "./merge.js";
import { planningStateFields } from "./planning.js";
import { releaseStateFields, releaseStateFields2, releaseObservationStateFields } from "./release.js";
import { repairStateFields } from "./repair.js";
import { successorStateFields, successorStateFields2 } from "./successor.js";
import { targetBaseStateFields } from "./target-base.js";
import { plannerNoteStateFields } from "./planner-note.js";

const orderedStateFields = {
  ...identityStateFields,
  ...lifecycleStateFields,
  ...developerRecoveryStateFields,
  ...capacityStateFields,
  ...planningStateFields,
  ...governanceStateFields,
  ...developmentStateFields,
  ...deliveryReviewStateFields,
  ...repairStateFields,
  ...forwardMergeStateFields,
  ...targetBaseStateFields,
  ...mergeStateFields,
  ...releaseStateFields,
  ...ciStateFields,
  ...finalReviewStateFields,
  ...acceptanceStateFields,
  ...mergeStateFields2,
  ...successorStateFields,
  ...releaseStateFields2,
  ...successorStateFields2,
  ...plannerNoteStateFields,
  ...releaseObservationStateFields,
};

export const IssueWorkflowStateSchema = z.preprocess((raw) => {
  if (raw && typeof raw === "object") {
    const state = { ...(raw as Record<string, unknown>) };
    for (const key of ["planMaterial", "materialCategories", "materialityEvidence", "finalPlanSubject", "originalPlanSubject", "leadReviewResponseArtifactSha256", "blockerArtifactSha256", "leadResumeInstructionSha256", "leadEvidenceSha256", "leadOutputSha256", "leadInputManifestSha256", "supplementalReviewArtifactSha256", "worktreeState", "releaseStatus", "releaseFailureCode", "ciOutcome"]) delete state[key];
    if (state.planBlockerResponseReceipt && typeof state.planBlockerResponseReceipt === "object") {
      const receipt = { ...(state.planBlockerResponseReceipt as Record<string, unknown>) };
      delete receipt.blockerSubjectHash;
      state.planBlockerResponseReceipt = receipt;
    }
    if (state.step === undefined && typeof state.phase === "string") {
      const legacyPhase = state.phase;
      const commands = Array.isArray(state.allowedCommands) ? state.allowedCommands.flatMap((command) => {
        const parsed = IssueCommandSchema.safeParse(command);
        return parsed.success ? [parsed.data] : [];
      }) : [];
      let step = ISSUE_STEPS.find((candidate) => candidate === legacyPhase);
      if (!step) {
        if (legacyPhase === "delivery_blocked") {
          if (commands.includes("review_delivery")) step = "delivery_ready";
          else if (commands.some((command) => ["publish_draft", "retry_target_base_reconciliation", "retry_forward_merge_verification"].includes(command))) step = "releasing";
          else if (commands.some((command) => ["reconcile_ci", "repair_ci"].includes(command))) step = "ci_waiting";
          else if (commands.includes("final_review")) step = "final_review";
          else if (commands.some((command) => ["accept_delivery", "reconcile_acceptance"].includes(command))) step = "accepted";
          else if (commands.includes("reconcile_merge")) step = "manual_merge";
          else step = "development";
        } else if (legacyPhase === "blocked") {
          step = state.blockedCategory === "human_decision" ? "planning" : state.developerExecutionId ? "development" : "planning";
        } else if (legacyPhase === "ci_repair_required") step = "ci_waiting";
        else if (legacyPhase === "merge_conflict_required") step = "merge_conflict_resolving";
        else if (legacyPhase === "failed") step = state.developerExecutionId ? "development" : "planning";
      }
      if (step) {
        state.step = step;
        state.phase = phaseOf(step);
        if (["delivery_blocked", "blocked", "failed", "ci_repair_required", "merge_conflict_required"].includes(legacyPhase) && (state.blocker === null || state.blocker === undefined)) {
          const orderedCommands = [...commands.filter((command) => command !== "cancel_issue"), ...commands.filter((command) => command === "cancel_issue")].slice(0, 3);
          const blockerCommands = orderedCommands.length > 0 ? orderedCommands : ["cancel_issue"];
          state.blocker = {
            category: "agent_contradiction",
            summary: state.pendingAction ?? "Needs your attention",
            unblockOwner: "human",
            actions: blockerCommands.map((command) => ({ command, label: command.split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "), destructive: command === "cancel_issue", requiresNote: false })),
            evidence: { artifactId: typeof state.lastEventId === "string" && state.lastEventId ? state.lastEventId : "legacy-blocker", kind: "attention-evidence" },
            createdAt: typeof state.stateChangedAt === "string" ? state.stateChangedAt : new Date().toISOString(),
            retry: null,
          };
          state.owner = "human";
        }
      }
    }
    // Activity-provided summaries are not trusted to fit the compact workflow
    // state fields. Normalize before validation so replaying an old activity
    // result cannot make a workflow task fail forever.
    if (typeof state.pendingAction === "string") state.pendingAction = normalizeSafeSummary(state.pendingAction, 200);
    for (const [key, value] of Object.entries(state)) {
      if (key.endsWith("Summary") && typeof value === "string") state[key] = normalizeSafeSummary(value, 200);
    }
    if (state.blocker && typeof state.blocker === "object") {
      const blocker = { ...(state.blocker as Record<string, unknown>) };
      if (typeof blocker.summary === "string") blocker.summary = normalizeSafeSummary(blocker.summary, 200);
      state.blocker = blocker;
    }
    raw = state;
  }
  // A blocker belongs to its original legal command set. Transitions can change
  // ownership or commands independently, leaving that persisted blocker stale.
  if (raw && typeof raw === "object") {
    const state = raw as { owner?: unknown; allowedCommands?: unknown; targetBaseBlockerRetryable?: unknown; blocker?: { unblockOwner?: unknown; actions?: Array<{ command?: unknown }> } | null };
    const allowedCommands = Array.isArray(state.allowedCommands) ? state.allowedCommands : [];
    const automaticTargetBaseRetry = state.owner === "lead" && state.targetBaseBlockerRetryable === true && state.blocker?.actions?.some((action) => action.command === "retry_target_base_reconciliation");
    if ((state.owner !== "human" && state.blocker?.unblockOwner === "human" && !automaticTargetBaseRetry)
      || state.blocker?.actions?.some((action) => typeof action.command !== "string" || !allowedCommands.includes(action.command))) return { ...state, blocker: null };
  }
  return raw;
}, z.object(orderedStateFields)).superRefine((state, context) => {
  if (state.phase !== phaseOf(state.step)) context.addIssue({ code: "custom", path: ["phase"], message: "Phase must match step" });
  if (state.blocker?.unblockOwner !== "human") return;
  const automaticTargetBaseRetry = state.owner === "lead" && state.targetBaseBlockerRetryable === true && state.blocker.actions.some((action) => action.command === "retry_target_base_reconciliation");
  if (state.owner !== "human" && !automaticTargetBaseRetry) context.addIssue({ code: "custom", path: ["owner"], message: "Human blockers require human ownership" });
  if (state.blocker.retry && !state.blocker.retry.exhausted && state.blocker.retry.retryAt !== null) context.addIssue({ code: "custom", path: ["blocker", "retry"], message: "Retryable blockers cannot be surfaced as human attention" });
  for (const action of state.blocker.actions) {
    if (action.destructive !== (action.command === "cancel_issue")) context.addIssue({ code: "custom", path: ["blocker", "actions"], message: "Only issue cancellation is destructive" });
    if (["reject_plan", "record_delivery_decision", "request_delivery_changes"].includes(action.command) && !action.requiresNote) context.addIssue({ code: "custom", path: ["blocker", "actions"], message: "This action requires a note" });
  }
}).transform((state) => {
  // Single-operator tool: a nonterminal state must always be actionable. The
  // delivery-blocked retry is the natural recovery action; other in-flight
  // phases retain their universally safe cancellation action.
  if (TERMINAL_PHASES.has(state.phase) || state.allowedCommands.includes("cancel_issue")) return state;
  const naturalRetry = isBlocked(state) && state.step === "development" ? ["retry_development" as const] : [];
  return { ...state, allowedCommands: [...naturalRetry, ...state.allowedCommands, "cancel_issue" as const] };
});

export const IssueContinuationStateSchema = z.object({
  ...lifecycleStateFields,
  ...developerRecoveryStateFields,
  ...capacityStateFields,
  ...planningStateFields,
  ...governanceStateFields,
  ...developmentStateFields,
  ...deliveryReviewStateFields,
  ...repairStateFields,
  ...forwardMergeStateFields,
  ...targetBaseStateFields,
  ...mergeStateFields,
  ...releaseStateFields,
  ...ciStateFields,
  ...finalReviewStateFields,
  ...acceptanceStateFields,
  ...mergeStateFields2,
  ...successorStateFields,
  ...releaseStateFields2,
  ...successorStateFields2,
  ...plannerNoteStateFields,
  ...releaseObservationStateFields,
});

export {
  acceptanceStateFields, capacityStateFields, ciStateFields, deliveryReviewStateFields,
  developmentStateFields, developerRecoveryStateFields, finalReviewStateFields,
  forwardMergeStateFields, governanceStateFields, identityStateFields, lifecycleStateFields, mergeStateFields,
  mergeStateFields2, planningStateFields, releaseStateFields, releaseStateFields2, releaseObservationStateFields,
  repairStateFields, successorStateFields, successorStateFields2, targetBaseStateFields,
  plannerNoteStateFields,
};
