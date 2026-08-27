import type { AttentionCard, AttentionChoice, FailureClass } from "./convergence.js";

export type AttentionCondition =
  | { kind: "github_credential"; detail?: string }
  | { kind: "worktree_missing"; worktreePath: string | null; branchName: string | null }
  | { kind: "missing_turn_outcome"; role: "lead" | "developer"; dirty: boolean; evidenceRef?: string }
  | { kind: "product_decision"; question: string; choices: [AttentionChoice, AttentionChoice, ...AttentionChoice[]]; recommendedChoiceId: string; evidenceRef?: string }
  | { kind: "dirty_worktree_cleanup"; dirtyFileCount: number; worktreePath: string }
  | { kind: "no_progress"; failureClass: FailureClass; signature: string; evidenceRef?: string };

export function attentionCardFor(condition: AttentionCondition, overrides?: Partial<AttentionCard>): AttentionCard {
  const card = (() => {
    switch (condition.kind) {
      case "github_credential": return { kind: condition.kind, title: "GitHub sign-in required", explanation: condition.detail || "Forge needs permission to continue the GitHub step.", evidence: [{ kind: "text" as const, ref: condition.detail || "GitHub authentication is unavailable." }], primaryAction: { command: "reconcile_ci", label: "Sign in to GitHub and retry" } };
      case "worktree_missing": return { kind: condition.kind, title: "Local worktree is missing", explanation: "The local worktree needed to continue this issue is no longer available.", evidence: [{ kind: "text" as const, ref: condition.worktreePath || condition.branchName || "No recorded worktree was found." }], primaryAction: { command: "recreate_worktree", label: "Recreate worktree and resume" } };
      case "missing_turn_outcome": { const role = condition.role === "lead" ? "Lead" : "Developer"; return { kind: condition.kind, title: `${role} turn ended without an outcome`, explanation: condition.dirty ? "The Developer turn ended with uncommitted changes that need your review." : `The ${role} turn ended before recording an outcome.`, evidence: [{ kind: "text" as const, ref: condition.evidenceRef || (condition.dirty ? "Uncommitted changes remain in the worktree." : "No valid turn outcome was recorded.") }], primaryAction: { command: condition.role === "developer" ? "retry_development" : "continue_work", label: `Resume ${role} turn` }, secondaryAction: { command: "cancel_issue", label: "Cancel issue", destructive: true } }; }
      case "product_decision": return { kind: condition.kind, title: "Decision needed", explanation: condition.question, evidence: [{ kind: "text" as const, ref: condition.evidenceRef || condition.question }], primaryAction: { command: "send_planner_note", label: "Choose a behavior", requiresNote: true }, decision: { choices: condition.choices, recommendedChoiceId: condition.recommendedChoiceId, freeTextPrompt: "Anything else the Lead should know?" } };
      case "dirty_worktree_cleanup": return { kind: condition.kind, title: "Discard uncommitted changes?", explanation: `${condition.dirtyFileCount} uncommitted ${condition.dirtyFileCount === 1 ? "file needs" : "files need"} a decision before cleanup.`, evidence: [{ kind: "artifact" as const, ref: condition.worktreePath, label: "Worktree" }], primaryAction: { command: "delete_worktree", label: "Discard changes and delete worktree", destructive: true }, secondaryAction: { command: "continue_work", label: "Keep worktree" } };
      case "no_progress": { const merge = condition.failureClass === "merge_conflict_mechanical"; return { kind: condition.kind, title: "Automatic repair is not making progress", explanation: "The same repair problem repeated without new evidence of progress.", evidence: [{ kind: "text" as const, ref: condition.evidenceRef || condition.signature || "The repair repeated without new progress." }], primaryAction: merge ? { command: "resolve_merge_conflict", label: "Resume conflict resolution" } : { command: "retry_development", label: "Resume Developer turn" }, secondaryAction: { command: "cancel_issue", label: "Cancel issue", destructive: true } }; }
    }
  })();
  return { ...card, ...overrides };
}
