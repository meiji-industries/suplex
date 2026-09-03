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

export const ISSUE_COMMAND_NAMES = ["accept_delivery", "approve_plan", "arbitrate_review", "cancel_development", "cancel_issue", "continue_work", "delete_worktree", "final_review", "integrate_remote_conflict", "publish_draft", "reconcile_acceptance", "reconcile_ci", "reconcile_merge", "record_delivery_decision", "record_progress", "recreate_worktree", "reject_plan", "repair_ci", "repair_delivery", "report_worktree_missing", "request_delivery_changes", "request_plan_revision", "request_supplemental_review", "respond_plan_blocker", "resume_preserved_work", "resolve_decision_blocker", "resolve_merge_conflict", "retry_capacity", "retry_development", "retry_forward_merge_verification", "retry_target_base_reconciliation", "revise_plan", "review_delivery", "send_planner_note", "start_development", "start_planning"] as const;

export const IssueCommandSchema = z.enum(ISSUE_COMMAND_NAMES);
export type IssueCommand = z.infer<typeof IssueCommandSchema>;

export const ISSUE_COMMAND_SLUGS = ["accept-delivery", "approve-plan", "arbitrate-review", "cancel", "cancel-development", "continue-work", "delete-worktree", "final-review", "integrate-remote-conflict", "publish-draft", "reconcile-acceptance", "reconcile-ci", "reconcile-merge", "record-delivery-decision", "record-progress", "recreate-worktree", "repair-ci", "repair-delivery", "request-delivery-changes", "request-plan-revision", "request-supplemental-review", "respond-plan-blocker", "resume-preserved-work", "resolve-decision-blocker", "resolve-merge-conflict", "retry-capacity", "retry-development", "retry-forward-merge-verification", "retry-target-base-reconciliation", "revise-plan", "review-delivery", "start-development", "start-planning", "tell-planner"] as const;
export const IssueCommandSlugSchema = z.enum(ISSUE_COMMAND_SLUGS);
export type IssueCommandSlug = z.infer<typeof IssueCommandSlugSchema>;

export function issueCommand(name: IssueCommand): IssueCommandDescriptor {
  return issueCommands[name];
}

export const routedIssueCommands = ISSUE_COMMAND_NAMES
  .map((name) => issueCommands[name])
  .filter((descriptor) => descriptor.slug !== null && descriptor.family !== "bespoke");
