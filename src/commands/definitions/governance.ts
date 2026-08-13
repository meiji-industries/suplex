import { ExpectedRevisionBodySchema, ExpectedRevisionNoteBodySchema, HttpPlanBlockerResponseBodySchema, HttpPlanDecisionBodySchema, ResolveDecisionBlockerBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

const decisionBody = HttpPlanDecisionBodySchema.extend({ expectedRevision: ExpectedRevisionBodySchema.shape.expectedRevision });

export const governanceCommands = {
  approve_plan: defineIssueCommand({
    name: "approve_plan",
    slug: "approve-plan",
    updateName: "approvePlan",
    label: "Approve plan",
    family: "plan",
    durableCommandKind: "approvePlan",
    payloadLabel: "plan command",
    body: decisionBody,
    note: "required",
    idempotency: "required",
    uiSubject: (context) => {
      if (!context.finalPlanSubject || !context.materialityEvidence) return undefined;
      return { subject: { kind: "plan_decision", value: { plan: context.finalPlanSubject, materiality: context.materialityEvidence, expectedWorkflowRevision: context.expectedRevision } } };
    },
  }),
  request_plan_revision: defineIssueCommand({
    name: "request_plan_revision",
    slug: "request-plan-revision",
    updateName: "requestPlanRevision",
    label: "Request plan revision",
    family: "plan",
    durableCommandKind: "requestPlanRevision",
    payloadLabel: "plan command",
    body: decisionBody,
    note: "required",
    idempotency: "required",
    uiSubject: (context) => {
      if (!context.finalPlanSubject || !context.materialityEvidence) return undefined;
      return { subject: { kind: "plan_decision", value: { plan: context.finalPlanSubject, materiality: context.materialityEvidence, expectedWorkflowRevision: context.expectedRevision } } };
    },
  }),
  reject_plan: defineIssueCommand({
    name: "reject_plan",
    slug: null,
    updateName: "rejectPlan",
    label: "Reject plan",
    family: "bespoke",
    durableCommandKind: "rejectPlan",
    payloadLabel: "plan command",
    body: null,
    note: "none",
    idempotency: "none",
    uiSubject: () => undefined,
  }),
  respond_plan_blocker: defineIssueCommand({
    name: "respond_plan_blocker",
    slug: "respond-plan-blocker",
    updateName: "respondPlanBlocker",
    label: "Respond to blocker",
    family: "plan",
    durableCommandKind: "respondPlanBlocker",
    payloadLabel: "plan command",
    body: HttpPlanBlockerResponseBodySchema,
    note: "required",
    idempotency: "required",
    uiSubject: (context) => context.planBlockerSubject ? { subject: { kind: "plan_blocker", value: context.planBlockerSubject } } : undefined,
  }),
  resolve_decision_blocker: defineIssueCommand({
    name: "resolve_decision_blocker",
    slug: "resolve-decision-blocker",
    updateName: "resolveDecisionBlocker",
    label: "Resolve decision blocker",
    family: "bespoke",
    durableCommandKind: null,
    payloadLabel: "decision blocker resolution command",
    body: ResolveDecisionBlockerBodySchema,
    note: "required",
    idempotency: "none",
  }),
  cancel_issue: defineIssueCommand({
    name: "cancel_issue",
    slug: "cancel",
    updateName: "cancelIssue",
    label: "Cancel issue",
    family: "plan",
    durableCommandKind: "cancelIssue",
    payloadLabel: "issue cancellation command",
    body: ExpectedRevisionNoteBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
