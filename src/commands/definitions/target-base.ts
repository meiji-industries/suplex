import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const targetBaseCommands = {
  retry_target_base_reconciliation: defineIssueCommand({
    name: "retry_target_base_reconciliation",
    slug: "retry-target-base-reconciliation",
    updateName: "retryTargetBaseReconciliation",
    label: "Retry target-base reconciliation",
    family: "start",
    durableCommandKind: "target-base reconciliation retry command",
    payloadLabel: "target-base reconciliation retry command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  retry_forward_merge_verification: defineIssueCommand({
    name: "retry_forward_merge_verification",
    slug: "retry-forward-merge-verification",
    updateName: "retryForwardMergeVerification",
    label: "Retry forward-merge verification",
    family: "start",
    durableCommandKind: "forward-merge verification retry command",
    payloadLabel: "forward-merge verification retry command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
