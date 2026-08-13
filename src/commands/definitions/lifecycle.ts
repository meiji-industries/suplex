import { z } from "zod";

import { defineIssueCommand } from "../kit.js";

export const ContinueWorkBodySchema = z.object({ expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(4_000) }).strict();

export const lifecycleCommands = {
  record_progress: defineIssueCommand({
    name: "record_progress",
    slug: "record-progress",
    updateName: "recordProgress",
    label: "Record progress",
    family: "bespoke",
    durableCommandKind: "record-progress",
    payloadLabel: "recordProgress command",
    body: null,
    note: "none",
    idempotency: "none",
  }),
  continue_work: defineIssueCommand({
    name: "continue_work",
    slug: "continue-work",
    updateName: "continueWork",
    label: "Continue work",
    family: "bespoke",
    durableCommandKind: null,
    payloadLabel: "continueWork command",
    body: ContinueWorkBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
