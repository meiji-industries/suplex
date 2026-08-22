import { z } from "zod";

import { ExpectedRevisionBodySchema, HttpSupplementalReviewBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const PlanRevisionBodySchema = z.object({ expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(4_000) }).strict();

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
