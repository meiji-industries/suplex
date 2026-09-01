import { ISSUE_COMMAND_NAMES, issueCommands, type IssueCommand } from "../commands/registry.js";
type IssueUpdates = { [K in IssueCommand]: string };

export const issueUpdates = Object.fromEntries(
  ISSUE_COMMAND_NAMES.map((name) => [name, issueCommands[name].updateName]),
) as unknown as IssueUpdates;

export const startPlanningUpdate = issueUpdates.start_planning;
export const requestSupplementalReviewUpdate = issueUpdates.request_supplemental_review;
export const approvePlanUpdate = issueUpdates.approve_plan;
export const rejectPlanUpdate = issueUpdates.reject_plan;
export const revisePlanUpdate = issueUpdates.revise_plan;
export const recordProgressUpdate = issueUpdates.record_progress;
export const startDevelopmentUpdate = issueUpdates.start_development;
export const retryDevelopmentUpdate = issueUpdates.retry_development;
export const cancelDevelopmentUpdate = issueUpdates.cancel_development;
export const reviewDeliveryUpdate = issueUpdates.review_delivery;
export const repairDeliveryUpdate = issueUpdates.repair_delivery;
export const recordDeliveryDecisionUpdate = issueUpdates.record_delivery_decision;
export const publishDraftUpdate = issueUpdates.publish_draft;
export const resolveMergeConflictUpdate = issueUpdates.resolve_merge_conflict;
export const retryTargetBaseReconciliationUpdate = issueUpdates.retry_target_base_reconciliation;
export const retryForwardMergeVerificationUpdate = issueUpdates.retry_forward_merge_verification;
export const reconcileCIUpdate = issueUpdates.reconcile_ci;
export const repairCIUpdate = issueUpdates.repair_ci;
export const finalReviewUpdate = issueUpdates.final_review;
export const acceptDeliveryUpdate = issueUpdates.accept_delivery;
export const requestDeliveryChangesUpdate = issueUpdates.request_delivery_changes;
export const cancelIssueUpdate = issueUpdates.cancel_issue;
export const reconcileAcceptanceUpdate = issueUpdates.reconcile_acceptance;
export const resolveDecisionBlockerUpdate = issueUpdates.resolve_decision_blocker;
export const reconcileMergeUpdate = issueUpdates.reconcile_merge;
export const continueWorkUpdate = issueUpdates.continue_work;
export const retryCapacityUpdate = issueUpdates.retry_capacity;
export const requestPlanRevisionUpdate = issueUpdates.request_plan_revision;
export const respondPlanBlockerUpdate = issueUpdates.respond_plan_blocker;
export const tellPlannerUpdate = issueUpdates.send_planner_note;

/** A read-triggered, debounced request to reconcile the GitHub PR. */
export const syncGithubPullRequestSignal = "syncGithubPullRequest";
