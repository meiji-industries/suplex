import { expect, test } from "vitest";

import { ISSUE_COMMAND_NAMES } from "../src/commands/registry.js";
import { taskCommandDescriptors } from "../src/task-commands.js";

// Commands are shown whenever the workflow allows them; the descriptor no longer hides plan
// commands behind an "exact subject" the client had to echo back.
test("task command descriptors project every routed command", () => {
  const actual = taskCommandDescriptors(ISSUE_COMMAND_NAMES, 7);
  expect(actual.map(({ name, label, endpoint, method, expectedRevision, note, idempotency }) => ({ name, label, endpoint, method, expectedRevision, note, idempotency })).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: "start_planning", label: "Start planning", endpoint: "start-planning", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "request_supplemental_review", label: "Request a second review", endpoint: "request-supplemental-review", method: "POST", expectedRevision: 7, note: "none", idempotency: "required" },
    { name: "approve_plan", label: "Approve the plan", endpoint: "approve-plan", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "arbitrate_review", label: "Decide the review outcome", endpoint: "arbitrate-review", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "request_plan_revision", label: "Request plan changes", endpoint: "request-plan-revision", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "respond_plan_blocker", label: "Answer the Planner", endpoint: "respond-plan-blocker", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "revise_plan", label: "Revise the plan", endpoint: "revise-plan", method: "POST", expectedRevision: 7, note: "required", idempotency: "none" },
    { name: "record_progress", label: "Record progress", endpoint: "record-progress", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "start_development", label: "Start the build", endpoint: "start-development", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_development", label: "Retry the build", endpoint: "retry-development", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "cancel_development", label: "Cancel the build", endpoint: "cancel-development", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "review_delivery", label: "Approve the delivery", endpoint: "review-delivery", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "repair_delivery", label: "Send back to the Builder", endpoint: "repair-delivery", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "record_delivery_decision", label: "Accept as is and publish", endpoint: "record-delivery-decision", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "publish_draft", label: "Publish the pull request", endpoint: "publish-draft", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "resolve_merge_conflict", label: "Resolve the merge conflict", endpoint: "resolve-merge-conflict", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_target_base_reconciliation", label: "Retry the base update", endpoint: "retry-target-base-reconciliation", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_forward_merge_verification", label: "Retry the merge check", endpoint: "retry-forward-merge-verification", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "reconcile_ci", label: "Check CI", endpoint: "reconcile-ci", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "repair_ci", label: "Repair CI", endpoint: "repair-ci", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "final_review", label: "Start the final review", endpoint: "final-review", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "accept_delivery", label: "Accept the delivery", endpoint: "accept-delivery", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "request_delivery_changes", label: "Request delivery changes", endpoint: "request-delivery-changes", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "reconcile_acceptance", label: "Check the ready state", endpoint: "reconcile-acceptance", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "resolve_decision_blocker", label: "Resolve the decision", endpoint: "resolve-decision-blocker", method: "POST", expectedRevision: 7, note: "required", idempotency: "none" },
    { name: "cancel_issue", label: "Cancel the task", endpoint: "cancel", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "reconcile_merge", label: "Check the merge", endpoint: "reconcile-merge", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "continue_work", label: "Continue in a new task", endpoint: "continue-work", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_capacity", label: "Retry when capacity is free", endpoint: "retry-capacity", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "send_planner_note", label: "Send a note to the Planner", endpoint: "tell-planner", method: "POST", expectedRevision: 7, note: "required", idempotency: "none" },
    { name: "delete_worktree", label: "Delete the worktree", endpoint: "delete-worktree", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "recreate_worktree", label: "Recreate the worktree and resume", endpoint: "recreate-worktree", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "resume_preserved_work", label: "Resume from the saved branch", endpoint: "resume-preserved-work", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "integrate_remote_conflict", label: "Resolve the remote branch conflict", endpoint: "integrate-remote-conflict", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
  ].sort((left, right) => left.name.localeCompare(right.name)));
});
