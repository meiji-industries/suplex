import { createHash } from "node:crypto";

import { ArtifactPointerSchema, AttentionCategorySchema, type AttentionCategory, type IssueBlocker, type IssueBlockerAction, type IssueCommand, type IssuePhase } from "./temporal/issue-contracts.js";

export const ATTENTION_CATEGORY_SEVERITY = [
  "unsafe_recovery",
  "provider_authentication",
  "provider_ambiguity",
  "member_authorization",
  "member_decision",
  "verification_unrecoverable",
  "target_drift",
  "agent_contradiction",
  "agent_exhausted",
  "provider_connectivity_exhausted",
  "capacity_exhausted",
] as const satisfies readonly AttentionCategory[];

export interface AttentionPolicyInput {
  companyId: string;
  taskId: string;
  taskTitle: string;
  workflowId: string;
  phase: IssuePhase;
  revision: number;
  owner: "human" | "lead";
  allowedCommands: IssueCommand[];
  blocker: IssueBlocker | null | undefined;
  pendingAction?: string | null;
  stateChangedAt?: string;
  projectedAt: string;
}

export type AttentionPolicyResult =
  | { kind: "quiet"; projectionStatus: "current" }
  | { kind: "quiet"; projectionStatus: "unknown"; reason: "legacy-state-missing-blocker" | "legacy-state-missing-time" }
  | {
      kind: "attention";
      projectionStatus: "current";
      item: {
        id: string;
        category: AttentionCategory;
        summary: string;
        actions: IssueBlockerAction[];
        evidence: IssueBlocker["evidence"] | null;
        sourceRevision: number;
        activatedAt: string;
      };
    };

export function attentionId(companyId: string, taskId: string, revision: number, category: AttentionCategory): string {
  return `attention_${createHash("sha256").update(`${companyId}:${taskId}:${revision}:${category}`).digest("hex").slice(0, 24)}`;
}

export function attentionPolicy(input: AttentionPolicyInput): AttentionPolicyResult {
  if (input.blocker === undefined) return { kind: "quiet", projectionStatus: "unknown", reason: "legacy-state-missing-blocker" };
  if (!input.stateChangedAt) return { kind: "quiet", projectionStatus: "unknown", reason: "legacy-state-missing-time" };
  const blocker = input.blocker;
  // A phase the operator has to act on always shows up, even when the failing activity never wrote evidence.
  const strandedHuman = input.phase === "failed" || (input.phase === "delivery_blocked" && input.owner === "human");
  if (strandedHuman && (!blocker || !ArtifactPointerSchema.safeParse(blocker.evidence).success)) {
    const category = AttentionCategorySchema.safeParse(blocker?.category).data ?? "agent_exhausted";
    return {
      kind: "attention",
      projectionStatus: "current",
      item: {
        id: attentionId(input.companyId, input.taskId, input.revision, category),
        category,
        summary: blocker?.summary ?? input.pendingAction ?? (input.phase === "failed" ? "The task failed and needs an operator" : "Delivery is blocked and needs an operator"),
        actions: blocker?.actions ?? input.allowedCommands.map((command) => ({ command, label: command.replaceAll("_", " "), requiresNote: false, destructive: command === "cancel_issue" })),
        evidence: null,
        sourceRevision: input.revision,
        activatedAt: input.stateChangedAt,
      },
    };
  }
  if (!blocker || blocker.unblockOwner !== "human") return { kind: "quiet", projectionStatus: "current" };
  if (blocker.retry && !blocker.retry.exhausted) return { kind: "quiet", projectionStatus: "current" };
  if (blocker.actions.some((action) => !input.allowedCommands.includes(action.command))) return { kind: "quiet", projectionStatus: "unknown", reason: "legacy-state-missing-blocker" };
  if (!ArtifactPointerSchema.safeParse(blocker.evidence).success) return { kind: "quiet", projectionStatus: "unknown", reason: "legacy-state-missing-blocker" };
  const category = AttentionCategorySchema.parse(blocker.category);
  return {
    kind: "attention",
    projectionStatus: "current",
    item: {
      id: attentionId(input.companyId, input.taskId, input.revision, category),
      category,
      summary: blocker.summary,
      actions: blocker.actions,
      evidence: blocker.evidence,
      sourceRevision: input.revision,
      activatedAt: input.stateChangedAt,
    },
  };
}
