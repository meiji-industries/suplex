import { z } from "zod";

import { TERMINAL_PHASES } from "../../../issue-phases.js";
import { normalizeSafeSummary } from "../primitives.js";
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
    const state = raw as { owner?: unknown; allowedCommands?: unknown; blocker?: { unblockOwner?: unknown; actions?: Array<{ command?: unknown }> } | null };
    const allowedCommands = Array.isArray(state.allowedCommands) ? state.allowedCommands : [];
    if ((state.owner !== "human" && state.blocker?.unblockOwner === "human")
      || state.blocker?.actions?.some((action) => typeof action.command !== "string" || !allowedCommands.includes(action.command))) return { ...state, blocker: null };
  }
  return raw;
}, z.object(orderedStateFields)).superRefine((state, context) => {
  if (state.blocker?.unblockOwner !== "human") return;
  if (state.owner !== "human") context.addIssue({ code: "custom", path: ["owner"], message: "Human blockers require human ownership" });
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
  const naturalRetry = state.phase === "delivery_blocked" ? ["retry_development" as const] : [];
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
