import { z } from "zod";

import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const ContinueWorkBodySchema = z.object({ expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1) }).strict();

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
  resync_projection: defineIssueCommand({
    name: "resync_projection",
    slug: "resync-projection",
    updateName: "resyncProjection",
    label: "Resync projection",
    family: "bespoke",
    durableCommandKind: null,
    payloadLabel: "resyncProjection command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
