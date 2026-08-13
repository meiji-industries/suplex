import { IssueCommandSchema, issueCommands, type IssueCommand } from "./commands/registry.js";
import type { CommandUiContext } from "./commands/kit.js";
import type { PlanBlockerSubject, PlanDecisionSubject, SupplementalReviewSubject } from "./plan-governance.js";

export type TaskCommandEndpoint = "request-supplemental-review" | "approve-plan" | "request-plan-revision" | "respond-plan-blocker" | "resolve-decision-blocker" | "start-planning" | "start-development" | "retry-development" | "cancel-development" | "verify-developer-ownership" | "review-delivery" | "repair-delivery" | "record-delivery-decision" | "publish-draft" | "resolve-merge-conflict" | "retry-target-base-reconciliation" | "retry-forward-merge-verification" | "reconcile-ci" | "repair-ci" | "final-review" | "accept-delivery" | "request-delivery-changes" | "cancel" | "reconcile-acceptance" | "reconcile-merge" | "retry-capacity" | "revise-plan" | "continue-work" | "record-progress";

export interface TaskCommandDescriptor {
  name: IssueCommand;
  label: string;
  endpoint: TaskCommandEndpoint;
  method: "POST";
  expectedRevision: number;
  note: "required" | "none";
  idempotency: "required" | "none";
  subject?:
    | { kind: "plan_decision"; value: PlanDecisionSubject }
    | { kind: "supplemental_review"; value: SupplementalReviewSubject }
    | { kind: "plan_blocker"; value: PlanBlockerSubject };
}

export type TaskCommandContext = CommandUiContext;

export function taskCommandDescriptors(commands: readonly string[], context: TaskCommandContext = { expectedRevision: 0 }): TaskCommandDescriptor[] {
  return commands.flatMap((raw) => {
    const parsed = IssueCommandSchema.safeParse(raw);
    if (!parsed.success) return [];
    const descriptor = issueCommands[parsed.data];
    if (descriptor.slug === null) return [];
    const ui = descriptor.uiSubject ? descriptor.uiSubject(context) : {};
    if (descriptor.uiSubject && ui === undefined) return [];
    return [{ name: descriptor.name as IssueCommand, label: descriptor.label, endpoint: descriptor.slug as TaskCommandDescriptor["endpoint"], method: "POST" as const, expectedRevision: context.expectedRevision, note: descriptor.note, idempotency: descriptor.idempotency, ...(ui?.subject ? { subject: ui.subject } : {}) }];
  });
}
