import type { IssueCommand } from "../../commands/registry.js";
import type { IssueStep } from "../../issue-phases.js";

export const OWNERS = ["member", "git", "github", "herdr", "timer", "terminal"] as const;
export type Owner = (typeof OWNERS)[number];

export const ANSWERS = ["done", "live", "absent", "failed"] as const;
export type Answer = (typeof ANSWERS)[number];

export type OwnerRead =
  | { owner: "herdr"; role: "planner" | "reviewer" | "builder" | "integrator"; promptKind: string }
  | { owner: "github"; what: "pull_request" | "checks" }
  | { owner: "git"; what: "delivery" | "base" }
  | { owner: "member"; decision: "plan_approval" | "delivery_decision" | "product_decision" | "acceptance" }
  | { owner: "timer"; field: "releaseRetryAt" | "ciNextPollAt" | "acceptanceRetryAt" };

export type TerminalRead = { owner: "terminal" };

export type Transition =
  | { command: IssueCommand }
  | { wait: "signal" | { pollMs: number } }
  | { step: IssueStep; owner: "lead" | "human" };

export type AdoptFirstTransition = Transition | { continue: true };

type ActiveStepRule = {
  waitsOn: OwnerRead;
  on: Record<Answer, Transition>;
  adoptFirst?: Extract<OwnerRead, { owner: "git" }>;
  onAdoptFirst?: Record<Answer, AdoptFirstTransition>;
  humanAction?: IssueCommand;
  terminal?: false;
};

type TerminalStepRule = {
  waitsOn: TerminalRead;
  on: Record<Answer, Transition>;
  humanAction?: IssueCommand;
  terminal: true;
};

export type StepRule = ActiveStepRule | TerminalStepRule;

const signal = { wait: "signal" } as const;
const poll = (pollMs: number) => ({ wait: { pollMs } }) as const;

export const STEP_TABLE: Record<IssueStep, StepRule> = {
  backlog: {
    waitsOn: { owner: "member", decision: "product_decision" },
    on: { done: { command: "start_planning" }, live: signal, absent: { command: "start_planning" }, failed: signal },
    humanAction: "start_planning",
  },
  planning: {
    waitsOn: { owner: "herdr", role: "planner", promptKind: "lead-plan" },
    on: { done: { step: "approval", owner: "human" }, live: signal, absent: { command: "start_planning" }, failed: { command: "start_planning" } },
  },
  supplemental_review: {
    waitsOn: { owner: "herdr", role: "reviewer", promptKind: "supplemental-review" },
    on: { done: { step: "plan_consolidation", owner: "lead" }, live: signal, absent: { command: "request_supplemental_review" }, failed: { command: "start_planning" } },
  },
  plan_consolidation: {
    waitsOn: { owner: "herdr", role: "planner", promptKind: "lead-consolidation" },
    on: { done: { step: "approval", owner: "human" }, live: signal, absent: { command: "start_planning" }, failed: { command: "start_planning" } },
  },
  approval: {
    waitsOn: { owner: "member", decision: "plan_approval" },
    on: { done: { command: "start_development" }, live: signal, absent: signal, failed: signal },
    humanAction: "approve_plan",
  },
  ready_for_development: {
    waitsOn: { owner: "herdr", role: "builder", promptKind: "implementation" },
    on: { done: { command: "review_delivery" }, live: signal, absent: { command: "start_development" }, failed: { command: "retry_development" } },
  },
  development: {
    waitsOn: { owner: "herdr", role: "builder", promptKind: "implementation" },
    on: { done: { command: "review_delivery" }, live: signal, absent: { command: "retry_development" }, failed: { command: "retry_development" } },
  },
  repair_required: {
    waitsOn: { owner: "herdr", role: "builder", promptKind: "delivery-repair" },
    on: { done: { command: "review_delivery" }, live: signal, absent: { command: "repair_delivery" }, failed: { command: "repair_delivery" } },
  },
  delivery_ready: {
    adoptFirst: { owner: "git", what: "delivery" },
    onAdoptFirst: { done: { continue: true }, live: signal, absent: signal, failed: { command: "retry_target_base_reconciliation" } },
    waitsOn: { owner: "herdr", role: "planner", promptKind: "delivery-review" },
    on: { done: { step: "delivery_reviewed", owner: "lead" }, live: signal, absent: { command: "review_delivery" }, failed: { command: "review_delivery" } },
  },
  reviewing_delivery: {
    waitsOn: { owner: "herdr", role: "planner", promptKind: "delivery-review" },
    on: { done: { step: "delivery_reviewed", owner: "lead" }, live: signal, absent: { command: "review_delivery" }, failed: { step: "repair_required", owner: "lead" } },
  },
  review_arbitration: {
    waitsOn: { owner: "herdr", role: "planner", promptKind: "delivery-review" },
    on: { done: { step: "delivery_reviewed", owner: "lead" }, live: signal, absent: { command: "arbitrate_review" }, failed: { step: "repair_required", owner: "lead" } },
  },
  delivery_reviewed: {
    adoptFirst: { owner: "git", what: "delivery" },
    onAdoptFirst: { done: { continue: true }, live: signal, absent: signal, failed: { command: "retry_target_base_reconciliation" } },
    waitsOn: { owner: "git", what: "delivery" },
    on: { done: { command: "publish_draft" }, live: signal, absent: { command: "review_delivery" }, failed: { step: "delivery_ready", owner: "lead" } },
  },
  final_review: {
    waitsOn: { owner: "herdr", role: "reviewer", promptKind: "final-review" },
    on: { done: { step: "accepted", owner: "human" }, live: signal, absent: { command: "final_review" }, failed: { step: "development", owner: "human" } },
  },
  releasing: {
    waitsOn: { owner: "github", what: "pull_request" },
    on: { done: { step: "done", owner: "human" }, live: poll(60_000), absent: { command: "publish_draft" }, failed: { step: "merge_conflict_reviewing", owner: "lead" } },
  },
  merge_conflict_reviewing: {
    waitsOn: { owner: "herdr", role: "integrator", promptKind: "merge-conflict-plan" },
    on: { done: { command: "resolve_merge_conflict" }, live: signal, absent: { command: "resolve_merge_conflict" }, failed: { step: "delivery_ready", owner: "lead" } },
  },
  merge_conflict_resolving: {
    waitsOn: { owner: "herdr", role: "integrator", promptKind: "merge-conflict-resolution" },
    on: { done: { step: "delivery_ready", owner: "lead" }, live: signal, absent: { command: "resolve_merge_conflict" }, failed: { command: "resolve_merge_conflict" } },
  },
  ci_waiting: {
    waitsOn: { owner: "github", what: "checks" },
    on: { done: { command: "final_review" }, live: poll(60_000), absent: { command: "reconcile_ci" }, failed: { step: "ci_repair_planning", owner: "lead" } },
  },
  ci_repair_planning: {
    waitsOn: { owner: "herdr", role: "integrator", promptKind: "ci-repair-plan" },
    on: { done: { command: "repair_ci" }, live: signal, absent: { command: "repair_ci" }, failed: { step: "development", owner: "human" } },
  },
  ci_repairing: {
    waitsOn: { owner: "herdr", role: "integrator", promptKind: "ci-repair" },
    on: { done: { step: "delivery_ready", owner: "lead" }, live: signal, absent: { command: "repair_ci" }, failed: { step: "development", owner: "human" } },
  },
  accepted: {
    waitsOn: { owner: "member", decision: "acceptance" },
    on: { done: { command: "reconcile_acceptance" }, live: signal, absent: signal, failed: { command: "request_delivery_changes" } },
    humanAction: "accept_delivery",
  },
  ready_reconciliation: {
    waitsOn: { owner: "timer", field: "acceptanceRetryAt" },
    on: { done: { command: "reconcile_acceptance" }, live: poll(60_000), absent: { command: "reconcile_acceptance" }, failed: { step: "development", owner: "human" } },
  },
  manual_merge: {
    waitsOn: { owner: "github", what: "pull_request" },
    on: { done: { step: "done", owner: "human" }, live: poll(60_000), absent: { command: "reconcile_merge" }, failed: { step: "delivery_ready", owner: "lead" } },
  },
  done: {
    waitsOn: { owner: "terminal" },
    on: { done: signal, live: signal, absent: signal, failed: signal },
    terminal: true,
  },
  cancelled: {
    waitsOn: { owner: "terminal" },
    on: { done: signal, live: signal, absent: signal, failed: signal },
    terminal: true,
  },
} satisfies Record<IssueStep, StepRule>;
