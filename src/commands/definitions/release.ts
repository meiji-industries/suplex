import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const releaseCommands = {
  publish_draft: defineIssueCommand({
    name: "publish_draft",
    slug: "publish-draft",
    updateName: "publishDraft",
    label: "Publish draft",
    family: "start",
    durableCommandKind: "draft publication command",
    payloadLabel: "draft publication command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
