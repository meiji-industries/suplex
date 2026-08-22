import { z } from "zod";

import { ExpectedRevisionBodySchema, HttpSupplementalReviewBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";
import { TERMINAL_PHASES, type IssuePhase } from "../../issue-phases.js";

export const PlanRevisionBodySchema = z.object({ expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1) }).strict();
export const SendPlannerNoteBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  note: z.string().trim().min(1),
  commandId: z.string().min(1),
}).strict();
export function plannerNoteAvailable(phase: IssuePhase, successorTaskId?: string | null): boolean {
  return !TERMINAL_PHASES.has(phase) && !successorTaskId;
}

export const planningCommands = {
  start_planning: defineIssueCommand({
    name: "start_planning",
    slug: "start-planning",
    updateName: "startPlanning",
    label: "Start planning",
    family: "start",
    durableCommandKind: "start-planning",
    payloadLabel: "startPlanning command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  send_planner_note: defineIssueCommand({
    name: "send_planner_note",
    slug: "tell-planner",
    updateName: "tellPlanner",
    label: "Tell the Planner",
    family: "start",
    durableCommandKind: "tell-planner",
    payloadLabel: "tell Planner command",
    body: SendPlannerNoteBodySchema,
    note: "required",
    idempotency: "none",
  }),
  request_supplemental_review: defineIssueCommand({
    name: "request_supplemental_review",
    slug: "request-supplemental-review",
    updateName: "requestSupplementalReview",
    label: "Request supplemental review",
    family: "plan",
    durableCommandKind: "requestSupplementalReview",
    payloadLabel: "plan command",
    body: HttpSupplementalReviewBodySchema,
    note: "none",
    idempotency: "required",
  }),
  revise_plan: defineIssueCommand({
    name: "revise_plan",
    slug: "revise-plan",
    updateName: "revisePlan",
    label: "Revise plan",
    family: "bespoke",
    durableCommandKind: null,
    payloadLabel: "revisePlan command",
    body: PlanRevisionBodySchema,
    note: "required",
    idempotency: "none",
  }),
} as const;
