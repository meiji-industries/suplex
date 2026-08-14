import { z } from "zod";

export const ISSUE_PHASES = ["backlog", "planning", "supplemental_review", "plan_consolidation", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done", "delivery_blocked", "blocked", "cancelled", "failed"] as const;

export type IssuePhase = (typeof ISSUE_PHASES)[number];

export const IssuePhaseSchema = z.enum(ISSUE_PHASES);

const PHASE_LABELS: Partial<Record<IssuePhase, string>> = {
  ready_for_development: "Ready",
  delivery_ready: "Delivered",
  reviewing_delivery: "Reviewing",
  repair_required: "Repair",
  delivery_reviewed: "Reviewed",
  delivery_blocked: "Blocked",
  blocked: "Blocked",
  merge_conflict_reviewing: "Reviewing conflict",
  merge_conflict_required: "Conflict resolution",
  merge_conflict_resolving: "Resolving conflict",
  ci_waiting: "Waiting for CI",
  ci_repair_required: "CI repair",
  final_review: "Final review",
  ready_reconciliation: "Ready reconciliation",
  manual_merge: "Ready to Merge",
};

export function phaseLabel(phase: IssuePhase): string {
  return PHASE_LABELS[phase] ?? phase.split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

export const ACTIVE_PHASES: ReadonlySet<IssuePhase> = new Set(["planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge"]);
export const BLOCKED_PHASES: ReadonlySet<IssuePhase> = new Set(["delivery_blocked", "blocked", "failed"]);
export const ATTENTION_ACTIVE_PHASES: ReadonlySet<string> = new Set([...ACTIVE_PHASES, "delivery_blocked"]);
