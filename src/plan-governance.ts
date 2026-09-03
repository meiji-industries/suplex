import { z } from "zod";

import { at, type IssuePhase, type IssueStep } from "./issue-phases.js";
import type { IssueBlocker } from "./engine/contracts/primitives.js";

const GovernanceIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const PlanSubjectSchema = z.object({
  planRevision: z.number().int().nonnegative(),
  artifactId: GovernanceIdSchema,
  leadSessionRef: GovernanceIdSchema,
}).strip();

export type PlanSubject = z.infer<typeof PlanSubjectSchema>;

export const PlanDecisionSubjectSchema = z.object({
  plan: PlanSubjectSchema,
  expectedWorkflowRevision: z.number().int().nonnegative(),
}).strip();

export type PlanDecisionSubject = z.infer<typeof PlanDecisionSubjectSchema>;

export const SupplementalReviewSubjectSchema = z.object({
  originalPlan: PlanSubjectSchema,
  reviewerProfileId: GovernanceIdSchema,
}).strip();

export type SupplementalReviewSubject = z.infer<typeof SupplementalReviewSubjectSchema>;

export const PlanBlockerSubjectSchema = z.object({
  companyId: GovernanceIdSchema,
  issueId: GovernanceIdSchema,
  workflowId: GovernanceIdSchema,
  artifactId: GovernanceIdSchema,
  leadSessionRef: GovernanceIdSchema,
  leadExecutionId: GovernanceIdSchema,
  category: z.literal("human_decision"),
  resumePhase: z.enum(["planning", "review_arbitration"]),
}).strip();

export type PlanBlockerSubject = z.infer<typeof PlanBlockerSubjectSchema>;

export const PublicPlanSubjectSchema = PlanSubjectSchema.omit({ leadSessionRef: true }).strip();
export const PublicPlanBlockerSubjectSchema = PlanBlockerSubjectSchema.omit({ leadSessionRef: true }).strip();
export type PublicPlanSubject = z.infer<typeof PublicPlanSubjectSchema>;
export type PublicPlanBlockerSubject = z.infer<typeof PublicPlanBlockerSubjectSchema>;

export const DecisionIdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export function routeLeadResult(result: { kind: "plan" | "decision_blocker" }, options: { supplementalReview: boolean; reviewerConfigured: boolean }): { step: IssueStep; phase: IssuePhase; owner: "lead" | "human"; allowedCommands: string[]; pendingAction: string; blocker?: IssueBlocker } {
  if (result.kind === "decision_blocker") {
    return {
      ...at("planning"), owner: "human", allowedCommands: ["respond_plan_blocker", "cancel_issue"], pendingAction: "Your decision is necessary",
      blocker: { category: "member_decision", summary: "Your decision is necessary", unblockOwner: "human", actions: [{ command: "respond_plan_blocker", label: "Answer the Planner", requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], evidence: { artifactId: "blocker", kind: "decision-blocker" }, createdAt: new Date().toISOString(), retry: null },
    };
  }
  return { ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue", ...(options.supplementalReview && options.reviewerConfigured ? ["request_supplemental_review"] : [])], pendingAction: "Approve the final plan" };
}
