import { expect, test } from "vitest";

import { ISSUE_COMMAND_NAMES } from "../src/commands/registry.js";
import { taskCommandDescriptors } from "../src/task-commands.js";

// Commands are shown whenever the workflow allows them; the descriptor no longer hides plan
// commands behind an "exact subject" the client had to echo back.
test("task command descriptors project every routed command", () => {
  const actual = taskCommandDescriptors(ISSUE_COMMAND_NAMES, 7);
  expect(actual.map(({ name, label, endpoint, method, expectedRevision, note, idempotency }) => ({ name, label, endpoint, method, expectedRevision, note, idempotency }))).toEqual([
    { name: "start_planning", label: "Start planning", endpoint: "start-planning", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "request_supplemental_review", label: "Request supplemental review", endpoint: "request-supplemental-review", method: "POST", expectedRevision: 7, note: "none", idempotency: "required" },
    { name: "approve_plan", label: "Approve plan", endpoint: "approve-plan", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "request_plan_revision", label: "Request plan revision", endpoint: "request-plan-revision", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "respond_plan_blocker", label: "Respond to blocker", endpoint: "respond-plan-blocker", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "revise_plan", label: "Revise plan", endpoint: "revise-plan", method: "POST", expectedRevision: 7, note: "required", idempotency: "none" },
    { name: "record_progress", label: "Record progress", endpoint: "record-progress", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "start_development", label: "Start development", endpoint: "start-development", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_development", label: "Retry development", endpoint: "retry-development", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "cancel_development", label: "Cancel development", endpoint: "cancel-development", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "verify_developer_ownership", label: "Verify developer ownership", endpoint: "verify-developer-ownership", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "review_delivery", label: "Review delivery", endpoint: "review-delivery", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "repair_delivery", label: "Send back to Developer", endpoint: "repair-delivery", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "record_delivery_decision", label: "Record delivery decision", endpoint: "record-delivery-decision", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "publish_draft", label: "Publish draft", endpoint: "publish-draft", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "resolve_merge_conflict", label: "Resolve merge conflict", endpoint: "resolve-merge-conflict", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_target_base_reconciliation", label: "Retry target-base reconciliation", endpoint: "retry-target-base-reconciliation", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_forward_merge_verification", label: "Retry forward-merge verification", endpoint: "retry-forward-merge-verification", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "reconcile_ci", label: "Reconcile CI", endpoint: "reconcile-ci", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "repair_ci", label: "Repair CI", endpoint: "repair-ci", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "final_review", label: "Final review", endpoint: "final-review", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "accept_delivery", label: "Accept delivery", endpoint: "accept-delivery", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "request_delivery_changes", label: "Request delivery changes", endpoint: "request-delivery-changes", method: "POST", expectedRevision: 7, note: "required", idempotency: "required" },
    { name: "reconcile_acceptance", label: "Reconcile acceptance", endpoint: "reconcile-acceptance", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "resolve_decision_blocker", label: "Resolve decision blocker", endpoint: "resolve-decision-blocker", method: "POST", expectedRevision: 7, note: "required", idempotency: "none" },
    { name: "cancel_issue", label: "Cancel issue", endpoint: "cancel", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "reconcile_merge", label: "Reconcile merge", endpoint: "reconcile-merge", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "continue_work", label: "Continue work", endpoint: "continue-work", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "retry_capacity", label: "Retry capacity", endpoint: "retry-capacity", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "resync_projection", label: "Resync projection", endpoint: "resync-projection", method: "POST", expectedRevision: 7, note: "none", idempotency: "none" },
    { name: "send_planner_note", label: "Tell the Planner", endpoint: "tell-planner", method: "POST", expectedRevision: 7, note: "required", idempotency: "none" },
  ]);
});
