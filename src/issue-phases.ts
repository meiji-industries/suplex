export const ISSUE_PHASES = ["backlog", "planning", "supplemental_review", "plan_consolidation", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done", "delivery_blocked", "blocked", "cancelled", "failed"] as const;

export type IssuePhase = (typeof ISSUE_PHASES)[number];
