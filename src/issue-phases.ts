import { z } from "zod";

export const ISSUE_PHASES = ["backlog", "planning", "supplemental_review", "plan_consolidation", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done", "delivery_blocked", "blocked", "cancelled", "failed"] as const;

export type IssuePhase = (typeof ISSUE_PHASES)[number];

export const IssuePhaseSchema = z.enum(ISSUE_PHASES);

const PHASE_LABELS: Partial<Record<IssuePhase, string>> = {
  development: "In Development",
  ready_for_development: "Ready",
  delivery_ready: "Ready for review",
  reviewing_delivery: "In Review",
  repair_required: "Fixing review findings",
  delivery_reviewed: "Reviewed",
  releasing: "Opening PR",
  delivery_blocked: "Needs attention",
  blocked: "Blocked",
  merge_conflict_reviewing: "Reviewing conflict",
  merge_conflict_required: "Conflict resolution",
  merge_conflict_resolving: "Resolving conflict",
  ci_waiting: "Waiting for CI",
  ci_repairing: "Fixing CI",
  ci_repair_required: "CI repair needed",
  final_review: "Final review",
  ready_reconciliation: "Checking readiness",
  manual_merge: "Ready to Merge",
};

export function phaseLabel(phase: IssuePhase): string {
  return PHASE_LABELS[phase] ?? phase.split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

export const ACTIVE_PHASES: ReadonlySet<IssuePhase> = new Set(["planning", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repairing", "final_review", "accepted", "ready_reconciliation", "manual_merge"]);
export const BLOCKED_PHASES: ReadonlySet<IssuePhase> = new Set(["delivery_blocked", "ci_repair_required", "blocked", "failed"]);
export const ATTENTION_ACTIVE_PHASES: ReadonlySet<string> = new Set([...ACTIVE_PHASES, "delivery_blocked"]);

// Phases where the workflow has already finished and there is nothing left to cancel.
export const TERMINAL_PHASES: ReadonlySet<IssuePhase> = new Set(["done", "cancelled"]);
