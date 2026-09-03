import { ExpectedRevisionBodySchema } from "../../http/contracts/common.js";
import { defineIssueCommand } from "../kit.js";

export const ciCommands = {
  reconcile_ci: defineIssueCommand({
    name: "reconcile_ci",
    slug: "reconcile-ci",
    updateName: "reconcileCI",
    label: "Check CI",
    family: "start",
    durableCommandKind: "CI reconciliation command",
    payloadLabel: "CI reconciliation command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
  repair_ci: defineIssueCommand({
    name: "repair_ci",
    slug: "repair-ci",
    updateName: "repairCI",
    label: "Repair CI",
    family: "start",
    durableCommandKind: "CI repair command",
    payloadLabel: "CI repair command",
    body: ExpectedRevisionBodySchema,
    note: "none",
    idempotency: "none",
  }),
} as const;
