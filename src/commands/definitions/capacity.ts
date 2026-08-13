import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const capacityCommands = {
  retry_capacity: defineIssueCommand({
    name: "retry_capacity",
    slug: "retry-capacity",
    updateName: "retryCapacity",
    label: "Retry capacity",
    family: "start",
    durableCommandKind: "capacity retry command",
    payloadLabel: "capacity retry command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
