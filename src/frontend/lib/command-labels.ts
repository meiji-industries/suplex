import type { IssueCommand } from "../../commands/registry.js";

export const COMMAND_LABELS: Record<IssueCommand, string> = {
  accept_delivery: "Accept", approve_plan: "Approve", cancel_development: "Cancel development", cancel_issue: "Cancel task", continue_work: "Continue work", delete_worktree: "Delete worktree", final_review: "Final review", integrate_remote_conflict: "Integrate remote conflict", publish_draft: "Publish pull request", reconcile_acceptance: "Check ready state", reconcile_ci: "Check CI", reconcile_merge: "Check merge", record_delivery_decision: "Record decision", record_progress: "Record progress", recreate_worktree: "Recreate worktree", reject_plan: "Reject plan", repair_ci: "Repair CI", repair_delivery: "Run missing check", report_worktree_missing: "Report missing worktree", request_delivery_changes: "Request changes", request_plan_revision: "Request changes", request_supplemental_review: "Request supplemental review", respond_plan_blocker: "Respond", resume_preserved_work: "Resume work", resolve_decision_blocker: "Resolve decision", resolve_merge_conflict: "Resolve merge conflict", retry_capacity: "Retry capacity", retry_development: "Retry development", retry_forward_merge_verification: "Retry verification", retry_target_base_reconciliation: "Retry target base", revise_plan: "Revise plan", review_delivery: "Looks good", send_planner_note: "Tell planner", start_development: "Start development", start_planning: "Start planning",
};

export const RESTART_LABELS: Readonly<Record<string, string>> = {
  start_planning: "Restart planner",
  retry_development: "Restart builder",
  review_delivery: "Restart reviewer",
  repair_ci: "Restart CI repair",
  resolve_merge_conflict: "Restart conflict resolution",
  publish_draft: "Retry publish",
  reconcile_ci: "Check CI",
  reconcile_merge: "Check merge",
  accept_delivery: "Accept",
  retry_capacity: "Retry when capacity frees",
};

export function commandLabel(command: string): string {
  return Object.entries(COMMAND_LABELS).find(([candidate]) => candidate === command)?.[1] ?? command.replaceAll("_", " ");
}
