import { z } from "zod";

import type { IssueCommand } from "./commands/registry.js";

export const ISSUE_STEPS = [
  "backlog",
  "planning", "supplemental_review", "plan_consolidation",
  "approval",
  "ready_for_development", "development", "repair_required",
  "delivery_ready", "reviewing_delivery", "review_arbitration", "delivery_reviewed", "final_review",
  "releasing", "merge_conflict_reviewing", "merge_conflict_resolving",
  "ci_waiting", "ci_repair_planning", "ci_repairing",
  "accepted", "ready_reconciliation", "manual_merge",
  "done", "cancelled",
] as const;

export type IssueStep = (typeof ISSUE_STEPS)[number];
export const IssueStepSchema = z.enum(ISSUE_STEPS);

export const ISSUE_PHASES = ["backlog", "planning", "approval", "building", "reviewing", "shipping", "done", "cancelled"] as const;
export type IssuePhase = (typeof ISSUE_PHASES)[number];
export const IssuePhaseSchema = z.enum(ISSUE_PHASES);

export function phaseOf(step: IssueStep): IssuePhase {
  switch (step) {
    case "backlog": return "backlog";
    case "planning": case "supplemental_review": case "plan_consolidation": return "planning";
    case "approval": return "approval";
    case "ready_for_development": case "development": case "repair_required": return "building";
    case "delivery_ready": case "reviewing_delivery": case "review_arbitration": case "delivery_reviewed": case "final_review": return "reviewing";
    case "releasing": case "merge_conflict_reviewing": case "merge_conflict_resolving":
    case "ci_waiting": case "ci_repair_planning": case "ci_repairing":
    case "accepted": case "ready_reconciliation": case "manual_merge": return "shipping";
    case "done": return "done";
    case "cancelled": return "cancelled";
  }
}

export const PHASE_LABELS: Record<IssuePhase, string> = {
  backlog: "Backlog",
  planning: "Planning",
  approval: "Needs approval",
  building: "Building",
  reviewing: "Reviewing",
  shipping: "Shipping",
  done: "Done",
  cancelled: "Cancelled",
};

export function phaseLabel(phase: IssuePhase): string {
  return PHASE_LABELS[phase];
}

export const TERMINAL_PHASES: ReadonlySet<IssuePhase> = new Set(["done", "cancelled"]);
export const ACTIVE_PHASES: ReadonlySet<IssuePhase> = new Set(["planning", "approval", "building", "reviewing", "shipping"]);

export const STEP_RETRY_COMMAND: Partial<Record<IssueStep, IssueCommand>> = {
  planning: "start_planning",
  supplemental_review: "start_planning",
  plan_consolidation: "start_planning",
  ready_for_development: "start_development",
  development: "retry_development",
  repair_required: "retry_development",
  delivery_ready: "review_delivery",
  reviewing_delivery: "review_delivery",
  review_arbitration: "arbitrate_review",
  delivery_reviewed: "review_delivery",
  final_review: "final_review",
  releasing: "publish_draft",
  merge_conflict_reviewing: "resolve_merge_conflict",
  merge_conflict_resolving: "resolve_merge_conflict",
  ci_waiting: "repair_ci",
  ci_repair_planning: "repair_ci",
  ci_repairing: "repair_ci",
  accepted: "accept_delivery",
  ready_reconciliation: "reconcile_acceptance",
  manual_merge: "reconcile_merge",
};

/** Spread into a state literal: `{ ...state, ...at("development"), … }`. */
export function at(step: IssueStep): { step: IssueStep; phase: IssuePhase } {
  return { step, phase: phaseOf(step) };
}

export function isBlocked(state: { blocker?: { unblockOwner: string } | null | undefined }): boolean {
  return state.blocker?.unblockOwner === "human";
}
