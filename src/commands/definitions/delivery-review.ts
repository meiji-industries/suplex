import { ExpectedRevisionBodySchema, ExpectedRevisionNoteBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const deliveryReviewCommands = {
  review_delivery: defineIssueCommand({
    name: "review_delivery",
    slug: "review-delivery",
    updateName: "reviewDelivery",
    label: "Review delivery",
    family: "start",
    durableCommandKind: "delivery review command",
    payloadLabel: "delivery review command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  repair_delivery: defineIssueCommand({
    name: "repair_delivery",
    slug: "repair-delivery",
    updateName: "repairDelivery",
    label: "Repair delivery",
    family: "start",
    durableCommandKind: "delivery repair command",
    payloadLabel: "delivery repair command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  record_delivery_decision: defineIssueCommand({
    name: "record_delivery_decision",
    slug: "record-delivery-decision",
    updateName: "recordDeliveryDecision",
    label: "Record delivery decision",
    family: "plan",
    durableCommandKind: "recordDeliveryDecision",
    payloadLabel: "plan command",
    body: ExpectedRevisionNoteBodySchema,
    note: "required",
    idempotency: "required",
  }),
} as const;
