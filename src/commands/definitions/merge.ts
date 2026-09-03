import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { z } from "zod";

const ForwardMergeConflictArtifactSchema = z.object({ id: z.string().min(1).max(256), kind: z.literal("forward-merge-conflict") }).strict();
import { defineIssueCommand } from "../kit.js";

export const mergeCommands = {
  integrate_remote_conflict: defineIssueCommand({
    name: "integrate_remote_conflict",
    slug: "integrate-remote-conflict",
    updateName: "integrateRemoteConflict",
    label: "Resolve the remote branch conflict",
    family: "bespoke",
    durableCommandKind: "integrate-remote-conflict",
    payloadLabel: "integrateRemoteConflict command",
    body: z.object({
      expectedRevision: ExpectedRevisionBodySchema.shape.expectedRevision,
      forwardMergeId: z.string(),
      priorHead: z.string(),
      priorTree: z.string(),
      remoteHead: z.string(),
      conflictArtifact: ForwardMergeConflictArtifactSchema,
      conflictFileCount: z.number().int().nonnegative(),
    }).strict(),
    note: "none",
    idempotency: "none",
  }),
  resolve_merge_conflict: defineIssueCommand({
    name: "resolve_merge_conflict",
    slug: "resolve-merge-conflict",
    updateName: "resolveMergeConflict",
    label: "Resolve the merge conflict",
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
    label: "Check the merge",
    family: "start",
    durableCommandKind: "merge reconciliation command",
    payloadLabel: "merge reconciliation command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
