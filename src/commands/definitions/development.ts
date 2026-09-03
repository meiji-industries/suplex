import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const developmentCommands = {
  start_development: defineIssueCommand({
    name: "start_development",
    slug: "start-development",
    updateName: "startDevelopment",
    label: "Start the build",
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
    label: "Retry the build",
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
    label: "Cancel the build",
    family: "start",
    durableCommandKind: "cancel-development",
    payloadLabel: "cancel development command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
