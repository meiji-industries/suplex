import type { IssueCommand } from "../../commands/registry.js";

export const COMMAND_LABELS: Record<IssueCommand, string> = {
  accept_delivery: "Accept the delivery", approve_plan: "Approve the plan", cancel_development: "Cancel the build", cancel_issue: "Cancel the task", continue_work: "Continue in a new task", delete_worktree: "Delete the worktree", final_review: "Start the final review", integrate_remote_conflict: "Resolve the remote branch conflict", publish_draft: "Publish the pull request", reconcile_acceptance: "Check the ready state", reconcile_ci: "Check CI", reconcile_merge: "Check the merge", record_delivery_decision: "Accept as is and publish", record_progress: "Record progress", recreate_worktree: "Recreate the worktree and resume", reject_plan: "Reject the plan", repair_ci: "Repair CI", repair_delivery: "Send back to the Builder", report_worktree_missing: "Report the missing worktree", request_delivery_changes: "Request changes", request_plan_revision: "Request plan changes", request_supplemental_review: "Request a second review", respond_plan_blocker: "Answer the Planner", resume_preserved_work: "Resume from the saved branch", resolve_decision_blocker: "Resolve the decision", resolve_merge_conflict: "Resolve the merge conflict", retry_capacity: "Retry when capacity is free", retry_development: "Retry the build", retry_forward_merge_verification: "Retry the merge check", retry_target_base_reconciliation: "Retry the base update", revise_plan: "Revise the plan", review_delivery: "Approve the delivery", send_planner_note: "Send a note to the Planner", start_development: "Start the build", start_planning: "Start planning",
};

export const RESTART_LABELS: Readonly<Record<string, string>> = {
  start_planning: "Restart the Planner",
  retry_development: "Restart the Builder",
  review_delivery: "Restart the Reviewer",
  repair_ci: "Restart CI repair",
  resolve_merge_conflict: "Restart the conflict resolution",
  publish_draft: "Retry the publish",
  reconcile_ci: "Check CI",
  reconcile_merge: "Check the merge",
  accept_delivery: "Accept the delivery",
  retry_capacity: "Retry when capacity is free",
};

export function commandLabel(command: string): string {
  return Object.entries(COMMAND_LABELS).find(([candidate]) => candidate === command)?.[1] ?? command.replaceAll("_", " ");
}
