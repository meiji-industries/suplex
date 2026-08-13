import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const mergeCommands = {
  resolve_merge_conflict: defineIssueCommand({
    name: "resolve_merge_conflict",
    slug: "resolve-merge-conflict",
    updateName: "resolveMergeConflict",
    label: "Resolve merge conflict",
    family: "start",
    durableCommandKind: "merge-conflict resolution command",
    payloadLabel: "merge-conflict resolution command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  reconcile_merge: defineIssueCommand({
    name: "reconcile_merge",
    slug: "reconcile-merge",
    updateName: "reconcileMerge",
    label: "Reconcile merge",
    family: "start",
    durableCommandKind: "merge reconciliation command",
    payloadLabel: "merge reconciliation command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
