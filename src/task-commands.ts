import { IssueCommandSchema, type IssueCommand } from "./temporal/issue-contracts.js";
import type { MaterialityEvidenceSubject, PlanBlockerSubject, PlanDecisionSubject, PlanSubject, SupplementalReviewSubject } from "./plan-governance.js";

export type TaskCommandEndpoint = "request-supplemental-review" | "approve-plan" | "request-plan-revision" | "respond-plan-blocker" | "start-planning" | "start-development" | "retry-development" | "cancel-development" | "verify-developer-ownership" | "review-delivery" | "repair-delivery" | "record-delivery-decision" | "publish-draft" | "resolve-merge-conflict" | "retry-target-base-reconciliation" | "retry-forward-merge-verification" | "reconcile-ci" | "repair-ci" | "final-review" | "accept-delivery" | "request-delivery-changes" | "cancel" | "reconcile-acceptance" | "reconcile-merge" | "retry-capacity" | "revise-plan" | "continue-work" | "record-progress";

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

export interface TaskCommandContext {
  expectedRevision: number;
  reviewerProfileId?: string;
  originalPlanSubject?: PlanSubject | null;
  finalPlanSubject?: PlanSubject | null;
  materialityEvidence?: MaterialityEvidenceSubject | null;
  planBlockerSubject?: PlanBlockerSubject | null;
}

function planDecisionSubject(plan: PlanSubject, materiality: MaterialityEvidenceSubject, expectedWorkflowRevision: number): PlanDecisionSubject {
  return { plan, materiality, expectedWorkflowRevision };
}

function descriptor(name: IssueCommand, context: TaskCommandContext): TaskCommandDescriptor | undefined {
  const base = (label: string, endpoint: TaskCommandEndpoint, note: TaskCommandDescriptor["note"] = "none", idempotency: TaskCommandDescriptor["idempotency"] = "none"): TaskCommandDescriptor => ({ name, label, endpoint, method: "POST", expectedRevision: context.expectedRevision, note, idempotency });
  switch (name) {
    case "approve_plan": {
      if (!context.finalPlanSubject || !context.materialityEvidence) return undefined;
      return { ...base("Approve plan", "approve-plan", "required", "required"), subject: { kind: "plan_decision", value: planDecisionSubject(context.finalPlanSubject, context.materialityEvidence, context.expectedRevision) } };
    }
    case "request_plan_revision": {
      if (!context.finalPlanSubject || !context.materialityEvidence) return undefined;
      return { ...base("Request plan revision", "request-plan-revision", "required", "required"), subject: { kind: "plan_decision", value: planDecisionSubject(context.finalPlanSubject, context.materialityEvidence, context.expectedRevision) } };
    }
    case "request_supplemental_review": {
      if (!context.originalPlanSubject) return undefined;
      return { ...base("Request supplemental review", "request-supplemental-review", "none", "required"), subject: { kind: "supplemental_review", value: { originalPlan: context.originalPlanSubject, reviewerProfileId: context.reviewerProfileId ?? "reviewer", evidenceManifestArtifactId: context.originalPlanSubject.evidenceManifestArtifactId, evidenceManifestSha256: context.originalPlanSubject.evidenceManifestSha256 } } };
    }
    case "respond_plan_blocker":
      return context.planBlockerSubject ? { ...base("Respond to blocker", "respond-plan-blocker", "required", "required"), subject: { kind: "plan_blocker", value: context.planBlockerSubject } } : undefined;
    case "start_planning": return base("Start planning", "start-planning");
    case "start_development": return base("Start development", "start-development");
    case "retry_development": return base("Retry development", "retry-development");
    case "cancel_development": return base("Cancel development", "cancel-development");
    case "verify_developer_ownership": return base("Verify developer ownership", "verify-developer-ownership");
    case "review_delivery": return base("Review delivery", "review-delivery");
    case "repair_delivery": return base("Repair delivery", "repair-delivery");
    case "record_delivery_decision": return base("Record delivery decision", "record-delivery-decision", "required", "required");
    case "publish_draft": return base("Publish draft", "publish-draft");
    case "resolve_merge_conflict": return base("Resolve merge conflict", "resolve-merge-conflict");
    case "retry_target_base_reconciliation": return base("Retry target-base reconciliation", "retry-target-base-reconciliation");
    case "retry_forward_merge_verification": return base("Retry forward-merge verification", "retry-forward-merge-verification");
    case "reconcile_ci": return base("Reconcile CI", "reconcile-ci");
    case "repair_ci": return base("Repair CI", "repair-ci");
    case "final_review": return base("Final review", "final-review");
    case "accept_delivery": return base("Accept delivery", "accept-delivery");
    case "request_delivery_changes": return base("Request delivery changes", "request-delivery-changes", "required", "required");
    case "cancel_issue": return base("Cancel issue", "cancel");
    case "reconcile_acceptance": return base("Reconcile acceptance", "reconcile-acceptance");
    case "reconcile_merge": return base("Reconcile merge", "reconcile-merge");
    case "retry_capacity": return base("Retry capacity", "retry-capacity");
    case "revise_plan": return base("Revise plan", "revise-plan", "required");
    case "continue_work": return base("Continue work", "continue-work");
    case "record_progress": return base("Record progress", "record-progress");
    case "reject_plan": return undefined;
    default: return assertNever(name);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unmapped issue command: ${String(value)}`);
}

export function taskCommandDescriptors(commands: readonly string[], context: TaskCommandContext = { expectedRevision: 0 }): TaskCommandDescriptor[] {
  return commands.flatMap((raw) => {
    const parsed = IssueCommandSchema.safeParse(raw);
    if (!parsed.success) return [];
    const value = descriptor(parsed.data, context);
    return value ? [value] : [];
  });
}
