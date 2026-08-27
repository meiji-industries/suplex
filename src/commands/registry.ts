import { z } from "zod";

import type { IssueCommandDescriptor } from "./kit.js";
import { acceptanceCommands } from "./definitions/acceptance.js";
import { capacityCommands } from "./definitions/capacity.js";
import { ciCommands } from "./definitions/ci.js";
import { deliveryReviewCommands } from "./definitions/delivery-review.js";
import { developmentCommands } from "./definitions/development.js";
import { governanceCommands } from "./definitions/governance.js";
import { lifecycleCommands } from "./definitions/lifecycle.js";
import { mergeCommands } from "./definitions/merge.js";
import { planningCommands } from "./definitions/planning.js";
import { releaseCommands } from "./definitions/release.js";
import { targetBaseCommands } from "./definitions/target-base.js";

export const issueCommands: Record<IssueCommand, IssueCommandDescriptor> = {
  ...planningCommands, ...governanceCommands, ...developmentCommands, ...deliveryReviewCommands,
  ...releaseCommands, ...targetBaseCommands, ...ciCommands, ...acceptanceCommands,
  ...mergeCommands, ...lifecycleCommands, ...capacityCommands,
} as const;

// FROZEN ORDER: must match the historical z.enum literal (issue-contracts.ts@086a000).
export const ISSUE_COMMAND_NAMES = ["start_planning", "request_supplemental_review", "approve_plan", "request_plan_revision", "reject_plan", "respond_plan_blocker", "revise_plan", "record_progress", "start_development", "retry_development", "cancel_development", "verify_developer_ownership", "review_delivery", "repair_delivery", "record_delivery_decision", "publish_draft", "resolve_merge_conflict", "retry_target_base_reconciliation", "retry_forward_merge_verification", "reconcile_ci", "repair_ci", "final_review", "accept_delivery", "request_delivery_changes", "reconcile_acceptance", "resolve_decision_blocker", "cancel_issue", "reconcile_merge", "continue_work", "retry_capacity", "resync_projection", "send_planner_note", "delete_worktree", "recreate_worktree", "resume_preserved_work", "report_worktree_missing", "integrate_remote_conflict"] as const;

export const IssueCommandSchema = z.enum(ISSUE_COMMAND_NAMES);
export type IssueCommand = z.infer<typeof IssueCommandSchema>;

// FROZEN ORDER: must match the historical TaskCommandEndpointSchema (http/contracts/tasks.ts@086a000).
export const ISSUE_COMMAND_SLUGS = ["request-supplemental-review", "approve-plan", "request-plan-revision", "respond-plan-blocker", "resolve-decision-blocker", "start-planning", "start-development", "retry-development", "cancel-development", "verify-developer-ownership", "review-delivery", "repair-delivery", "record-delivery-decision", "publish-draft", "resolve-merge-conflict", "retry-target-base-reconciliation", "retry-forward-merge-verification", "reconcile-ci", "repair-ci", "final-review", "accept-delivery", "request-delivery-changes", "cancel", "reconcile-acceptance", "reconcile-merge", "retry-capacity", "revise-plan", "continue-work", "record-progress", "resync-projection", "tell-planner", "delete-worktree", "recreate-worktree", "resume-preserved-work", "integrate-remote-conflict"] as const;
export const IssueCommandSlugSchema = z.enum(ISSUE_COMMAND_SLUGS);
export type IssueCommandSlug = z.infer<typeof IssueCommandSlugSchema>;

export function issueCommand(name: IssueCommand): IssueCommandDescriptor {
  return issueCommands[name];
}

export const routedIssueCommands = ISSUE_COMMAND_NAMES
  .map((name) => issueCommands[name])
  .filter((descriptor) => descriptor.slug !== null && descriptor.family !== "bespoke");
