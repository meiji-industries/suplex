import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const developmentCommands = {
  start_development: defineIssueCommand({
    name: "start_development",
    slug: "start-development",
    updateName: "startDevelopment",
    label: "Start development",
    family: "start",
    durableCommandKind: "start-development",
    payloadLabel: "start development command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  retry_development: defineIssueCommand({
    name: "retry_development",
    slug: "retry-development",
    updateName: "retryDevelopment",
    label: "Retry development",
    family: "start",
    durableCommandKind: "retry-development",
    payloadLabel: "retry development command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  cancel_development: defineIssueCommand({
    name: "cancel_development",
    slug: "cancel-development",
    updateName: "cancelDevelopment",
    label: "Cancel development",
    family: "start",
    durableCommandKind: "cancel-development",
    payloadLabel: "cancel development command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  // Deprecated persisted update name. No workflow handler or UI action uses it.
  verify_developer_ownership: defineIssueCommand({
    name: "verify_developer_ownership",
    slug: "verify-developer-ownership",
    updateName: "verifyDeveloperOwnership",
    label: "Verify developer ownership",
    family: "start",
    durableCommandKind: "Developer ownership verification command",
    payloadLabel: "Developer ownership verification command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
