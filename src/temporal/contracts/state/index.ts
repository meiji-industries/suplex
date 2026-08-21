import { z } from "zod";

import { TERMINAL_PHASES } from "../../../issue-phases.js";
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
import { releaseStateFields, releaseStateFields2 } from "./release.js";
import { repairStateFields } from "./repair.js";
import { successorStateFields, successorStateFields2 } from "./successor.js";
import { targetBaseStateFields } from "./target-base.js";

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
};

export const IssueWorkflowStateSchema = z.preprocess((raw) => {
  // A human blocker is a human-owned wait. When a transition hands ownership back to an
  // agent without clearing it, the blocker is stale, not an invariant violation.
  if (raw && typeof raw === "object" && (raw as { owner?: unknown }).owner !== "human" && (raw as { blocker?: { unblockOwner?: unknown } | null }).blocker?.unblockOwner === "human") return { ...(raw as object), blocker: null };
  return raw;
}, z.object(orderedStateFields)).superRefine((state, context) => {
  if (state.blocker?.unblockOwner !== "human") return;
  if (state.owner !== "human") context.addIssue({ code: "custom", path: ["owner"], message: "Human blockers require human ownership" });
  if (state.blocker.retry && !state.blocker.retry.exhausted && state.blocker.retry.retryAt !== null) context.addIssue({ code: "custom", path: ["blocker", "retry"], message: "Retryable blockers cannot be surfaced as human attention" });
  for (const action of state.blocker.actions) {
    if (!state.allowedCommands.includes(action.command)) context.addIssue({ code: "custom", path: ["allowedCommands"], message: "Blocker actions must be legal in the current state" });
    if (action.destructive !== (action.command === "cancel_issue")) context.addIssue({ code: "custom", path: ["blocker", "actions"], message: "Only issue cancellation is destructive" });
    if (["reject_plan", "record_delivery_decision", "request_delivery_changes"].includes(action.command) && !action.requiresNote) context.addIssue({ code: "custom", path: ["blocker", "actions"], message: "This action requires a note" });
  }
}).transform((state) => {
  // Single-operator tool: cancel_issue must always be offered while the issue is
  // still active, even mid agent-turn phases that otherwise clear allowedCommands.
  if (TERMINAL_PHASES.has(state.phase) || state.allowedCommands.includes("cancel_issue")) return state;
  return { ...state, allowedCommands: [...state.allowedCommands, "cancel_issue" as const] };
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
});

export {
  acceptanceStateFields, capacityStateFields, ciStateFields, deliveryReviewStateFields,
  developmentStateFields, developerRecoveryStateFields, finalReviewStateFields,
  forwardMergeStateFields, governanceStateFields, identityStateFields, lifecycleStateFields, mergeStateFields,
  mergeStateFields2, planningStateFields, releaseStateFields, releaseStateFields2,
  repairStateFields, successorStateFields, successorStateFields2, targetBaseStateFields,
};
